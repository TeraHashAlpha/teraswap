# Skill: Supabase Schema Migrations

Apply this skill whenever the task adds, alters, or drops tables / columns /
policies in `supabase/migrations/`.

## File location & naming

- Path: `supabase/migrations/{timestamp}_{description}.sql` (timestamp `YYYYMMDDHHMMSS`).
- Description in snake_case, imperative tense (e.g. `20260512183000_add_api_keys.sql`).
- One migration per logical change. Never edit a migration that has already shipped — write a new one.

## RLS is mandatory

- Every new table: `ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;` in the same migration.
- Default policies:
  - `CREATE POLICY "deny anon" ON {table} FOR ALL TO anon USING (false) WITH CHECK (false);`
  - `CREATE POLICY "service role full" ON {table} FOR ALL TO service_role USING (true) WITH CHECK (true);`
- See `api_keys` table (11-M-01) for the canonical pattern.
- Authenticated-role policies are added only when the table actually serves authenticated client traffic — never as a default.

## Column conventions

- snake_case for tables and columns (Postgres convention; matches existing schema).
- Always include:
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - `updated_at TIMESTAMPTZ` with a trigger when mutation tracking matters
- Primary key: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` unless there's a domain-natural key.
- Foreign keys: declare `ON DELETE` behaviour explicitly (never rely on the default).

## Indexes

- Add explicit indexes for every column used in a WHERE / JOIN / ORDER BY.
- Composite indexes ordered by selectivity (most selective column first).
- Name them `idx_{table}_{cols}` so they're identifiable in `pg_stat_user_indexes`.

## Secrets in the schema

- Never store plaintext secrets.
  - API keys → SHA-256 hash in `key_hash` (see `hashApiKey()` in `src/lib/api-auth.ts`).
  - User passwords → bcrypt / scrypt via the auth layer (not in our schema today).
- Webhook secrets and OAuth refresh tokens live in env / a secret manager, **not** in tables.

## Testing

- Run the migration against a local Supabase (or the staging project) before merging.
- Verify RLS:
  - `select * from {table}` as anon → 0 rows / permission denied.
  - Same query via service-role key → expected rows.
- For destructive migrations, capture a pre-migration `pg_dump` in the sprint packet.

## Rollback

- Every migration should include a rollback SQL block in a comment at the bottom (`-- ROLLBACK: drop ...`).
- We don't run rollbacks automatically — the block exists for incident response.
