import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── Supabase client (singleton) ────────────────────────────
// Server-side only — used from API routes, never in client components.
// Uses service-role key for direct inserts (no RLS needed for analytics).

let _client: SupabaseClient | null = null

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

export function isSupabaseEnabled(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}
