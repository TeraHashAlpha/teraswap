import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── Supabase clients (two singletons) ──────────────────────
//
// Server-side only — used from API routes, never in client components.
//
// [P114/M-03] We expose two clients with different blast radius:
//
//   getSupabase()        — service-role key. Full read/write/delete on
//                          every table. Used for reads, order CRUD,
//                          API-key management, and the rare update
//                          (e.g. /api/log-swap PATCH that confirms a
//                          previously-pending swap).
//
//   getSupabaseLogger()  — logger_role key, scoped to INSERT on the
//                          five logging tables (swaps, quotes,
//                          security_events, usage_events,
//                          wallet_activity). See migration
//                          supabase/migrations/20260514_logger_role.sql.
//                          Used by every fire-and-forget logging path
//                          so a key leak from that surface can't read
//                          orders/api_keys or delete anything.
//
// SUPABASE_LOGGER_KEY must be created in the Supabase Dashboard
// (Settings → API → Generate new key with custom claim `role:
// logger_role`). When the env var is missing, getSupabaseLogger()
// falls back to the service-role client with a one-time warning —
// keeps prod alive on deploy day if the dashboard step lags the
// commit.

let _client: SupabaseClient | null = null
let _loggerClient: SupabaseClient | null = null
let _loggerFallbackWarned = false

export function getSupabase(): SupabaseClient | null {
  if (_client) return _client

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) return null

  _client = createClient(url, key, {
    auth: { persistSession: false },
  })
  return _client
}

/**
 * [P114/M-03] Insert-only client. Use this for every fire-and-forget
 * write into the logging tables. Returns null when Supabase is
 * unconfigured (same shape as getSupabase()) so callers can keep
 * their existing `if (!sb) return` guards.
 *
 * Fallback policy: if SUPABASE_LOGGER_KEY is unset but Supabase is
 * otherwise configured, we return the service-role client and warn
 * once. That keeps logging paths working during the rollout window
 * before the dashboard key is provisioned. Once the key is in place,
 * the logger client takes over automatically on next cold start.
 */
export function getSupabaseLogger(): SupabaseClient | null {
  if (_loggerClient) return _loggerClient

  const url = process.env.SUPABASE_URL
  const loggerKey = process.env.SUPABASE_LOGGER_KEY

  if (!url) return null

  if (loggerKey) {
    _loggerClient = createClient(url, loggerKey, {
      auth: { persistSession: false },
    })
    return _loggerClient
  }

  // No logger key — fall back to the service-role client and warn once.
  if (!_loggerFallbackWarned) {
    console.warn(
      '[supabase] SUPABASE_LOGGER_KEY not set — logging paths are using the '
        + 'service-role key. Provision the logger_role key in the Supabase '
        + 'Dashboard (Settings → API) to enforce least-privilege.',
    )
    _loggerFallbackWarned = true
  }
  return getSupabase()
}

export function isSupabaseEnabled(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/** Test-only reset. Clears both singletons + the fallback-warned flag
 *  so the env-driven branches can be re-driven across tests. */
export function _resetSupabaseClients(): void {
  _client = null
  _loggerClient = null
  _loggerFallbackWarned = false
}
