-- ══════════════════════════════════════════════════════════
--  [LP-08] Public API key infrastructure — TeraSwap v1
--  Date: 2026-05-11
--  Run once in the Supabase SQL Editor.
--
--  Backs the /v1/quote and /v1/swap public-API endpoints with
--  tier-based rate limiting, soft-deletion, and usage telemetry.
--
--  Keys are NEVER stored in plaintext. The client receives the raw
--  key once on POST /api/admin/api-keys; the server keeps only the
--  SHA-256 hex digest (`key_hash`). Lookups on /v1/* compute the
--  digest of the incoming X-API-Key header and match against
--  `key_hash`.
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS api_keys (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex digest (64 chars). UNIQUE so a stolen key can't be
  -- silently re-issued with a different name.
  key_hash            TEXT         UNIQUE NOT NULL,
  -- Human-readable label set by the admin at creation time.
  name                TEXT         NOT NULL,
  -- Tier name; ranges are validated app-side, not via enum (so
  -- adding a new tier doesn't need a schema migration).
  tier                TEXT         NOT NULL DEFAULT 'free',
  -- Per-key sliding-window limits. Set on creation from the tier
  -- default; admins can override per-key for special arrangements.
  rate_limit_per_min  INT          NOT NULL DEFAULT 10,
  rate_limit_per_day  INT          NOT NULL DEFAULT 100,
  -- Soft-delete flag. DELETE on /api/admin/api-keys flips this; the
  -- row stays for audit + usage history.
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ  DEFAULT NOW(),
  -- Optional hard expiry (NULL = never). Auth middleware checks
  -- `NOW() < expires_at` and rejects with 401 when past.
  expires_at          TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  -- Monotonic counter incremented (fire-and-forget) on each successful
  -- auth. Not used for rate limiting — that's a sliding-window KV check.
  total_requests      BIGINT       DEFAULT 0
);

-- Indexes -----------------------------------------------------

-- Primary read path on /v1/*: look up by hash, fast.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON api_keys (key_hash);

-- Admin listing path: filter active keys and sort by most-recent.
CREATE INDEX IF NOT EXISTS idx_api_keys_active_created_at
  ON api_keys (created_at DESC)
  WHERE is_active = true;

-- Tier-scoped reports.
CREATE INDEX IF NOT EXISTS idx_api_keys_tier
  ON api_keys (tier)
  WHERE is_active = true;

-- Comments for self-documenting schema dumps -----------------

COMMENT ON COLUMN api_keys.key_hash IS
  'SHA-256 hex digest of the plaintext key the client holds. Plaintext is never stored.';

COMMENT ON COLUMN api_keys.tier IS
  'Tier identifier. App-side constants map this to the per-tier rate limits in src/lib/constants.ts (API_KEY_TIERS).';

COMMENT ON COLUMN api_keys.is_active IS
  'Soft-delete flag. DELETE on the admin route flips this; rows are preserved for audit + usage history.';

COMMENT ON COLUMN api_keys.total_requests IS
  'Monotonic counter incremented fire-and-forget on each successful auth. Not used for rate limiting (sliding-window KV check is the gate).';
