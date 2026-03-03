import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── Supabase client (singleton) ────────────────────────────
// Only initialised when env vars are present.
// Falls back gracefully → localStorage analytics continue working.

let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (_client) return _client

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) return null

  _client = createClient(url, key)
  return _client
}

export function isSupabaseEnabled(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}
