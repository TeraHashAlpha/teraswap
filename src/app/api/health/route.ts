import { NextRequest, NextResponse } from 'next/server'
import { getSupabase, isSupabaseEnabled } from '@/lib/supabase'

/**
 * GET /api/health?token=<HEALTH_TOKEN>
 *
 * Diagnostics endpoint — checks if analytics pipeline is working.
 * Tests: env vars → Supabase connection → tables exist → row count.
 *
 * [H-02] Protected by HEALTH_TOKEN env var to prevent data leakage.
 * Without a valid token, only returns basic status (no sample data).
 */
export async function GET(request: NextRequest) {
  // ── Auth check ─────────────────────────────────────────────
  const healthToken = process.env.HEALTH_TOKEN
  const providedToken = request.nextUrl.searchParams.get('token')
  const isAuthed = healthToken && providedToken === healthToken

  // Public check: return minimal health status without data
  if (!isAuthed) {
    const supabaseOk = isSupabaseEnabled()
    return NextResponse.json({
      status: supabaseOk ? 'OK' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      hint: 'Provide ?token=HEALTH_TOKEN for detailed diagnostics.',
    }, { status: supabaseOk ? 200 : 503 })
  }

  // ── Authenticated: full diagnostics ────────────────────────
  const checks: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    supabaseUrlSet: !!process.env.SUPABASE_URL,
    supabaseKeySet: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseEnabled: isSupabaseEnabled(),
  }

  if (!isSupabaseEnabled()) {
    checks.status = 'FAIL'
    checks.error = 'Supabase env vars missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    return NextResponse.json(checks, { status: 503 })
  }

  const supabase = getSupabase()
  if (!supabase) {
    checks.status = 'FAIL'
    checks.error = 'Supabase client could not be created'
    return NextResponse.json(checks, { status: 503 })
  }

  // Test 1: Can we query the swaps table?
  const { data: swapTest, error: swapErr } = await supabase
    .from('swaps')
    .select('id')
    .limit(1)

  checks.swapsTableExists = !swapErr
  if (swapErr) {
    checks.swapsTableError = swapErr.message
  } else {
    checks.swapsRowCount = '≥' + (swapTest?.length ?? 0)
  }

  // Test 2: Can we query the quotes table?
  const { data: quoteTest, error: quoteErr } = await supabase
    .from('quotes')
    .select('id')
    .limit(1)

  checks.quotesTableExists = !quoteErr
  if (quoteErr) {
    checks.quotesTableError = quoteErr.message
  }

  // [BUGFIX] Write test removed — inserting/deleting test rows into production tables
  // can contaminate data if the cleanup fails or is interrupted mid-operation.
  // Read-access verification (Tests 1–2) plus row count (Test 4) is sufficient
  // to confirm the analytics pipeline is functional.

  // Test 4: Count total swaps
  const { count, error: countErr } = await supabase
    .from('swaps')
    .select('*', { count: 'exact', head: true })

  if (!countErr) {
    checks.totalSwaps = count
  }

  // Test 5: Sample raw data (for debugging format issues)
  const { data: sampleRows } = await supabase
    .from('swaps')
    .select('id, wallet, source, token_in_symbol, token_out_symbol, amount_in, amount_out, amount_in_usd, amount_out_usd, status, fee_collected, fee_amount, chain_id, created_at')
    .order('created_at', { ascending: false })
    .limit(3)

  if (sampleRows) {
    checks.sampleSwaps = sampleRows
  }

  // Overall status
  const allOk = checks.swapsTableExists && checks.quotesTableExists
  checks.status = allOk ? 'OK' : 'FAIL'

  return NextResponse.json(checks, { status: allOk ? 200 : 503 })
}
