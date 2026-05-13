-- ══════════════════════════════════════════════════════════
--  [P114 / M-03] Least-privilege role for fire-and-forget logging.
--  Sprint 16A — Date: 2026-05-14
--
--  src/lib/supabase.ts has historically used the service-role key
--  for every server-side operation, including the fire-and-forget
--  inserts into swaps/quotes/wallet_activity/security_events/
--  usage_events. The service-role key bypasses RLS and grants full
--  read/write/delete on every table — so a leaked key from a
--  logging path would expose orders, api_keys, and everything else.
--
--  This migration creates a dedicated `logger_role` with INSERT
--  privileges on the five logging tables and nothing else. The
--  application layer (supabase.ts) issues a separate Supabase client
--  keyed to this role for the fire-and-forget paths; the service-
--  role key stays in place for reads, order CRUD, and api_key
--  management.
--
--  Idempotent — safe to run repeatedly. Re-runs won't fail if the
--  role or grants already exist.
-- ══════════════════════════════════════════════════════════

-- 1) Create the role if it doesn't exist yet. NOLOGIN means the role
--    can't authenticate by password — Supabase's JWT machinery is
--    what binds the API key to this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logger_role') THEN
    CREATE ROLE logger_role NOLOGIN;
  END IF;
END
$$;

-- 2) Grant INSERT on each logging table. Re-running the GRANT is a
--    no-op when the privilege is already present.
GRANT INSERT ON swaps           TO logger_role;
GRANT INSERT ON quotes          TO logger_role;
GRANT INSERT ON security_events TO logger_role;
GRANT INSERT ON usage_events    TO logger_role;
GRANT INSERT ON wallet_activity TO logger_role;

-- 3) Sequences. INSERT on a table with a serial/bigserial id requires
--    USAGE on the underlying sequence. We grant on every sequence in
--    the public schema for the listed tables — uuid pkeys don't need
--    this, but defensive coverage avoids surprises if a column is
--    later switched.
DO $$
DECLARE
  seq RECORD;
BEGIN
  FOR seq IN
    SELECT n.nspname || '.' || c.relname AS qualified_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO logger_role', seq.qualified_name);
  END LOOP;
END
$$;

-- 4) Document the negative space: logger_role explicitly has NO
--    SELECT/UPDATE/DELETE on any table, and no access at all to:
--      - orders, order_executions    (order engine — needs full CRUD)
--      - api_keys                    (auth — SELECT + UPDATE only via service-role)
--      - trade_events                (analytics-tracker uses upsert,
--                                     which requires UPDATE; service-role)
--    Verify in psql:
--      \du logger_role
--      SELECT grantee, privilege_type, table_name
--      FROM information_schema.role_table_grants
--      WHERE grantee = 'logger_role'
--      ORDER BY table_name, privilege_type;
