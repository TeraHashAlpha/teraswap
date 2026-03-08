import { NextResponse } from 'next/server'
import { getSupabase, isSupabaseEnabled } from '@/lib/supabase'

/**
 * GET /api/health
 *
 * Diagnostics endpoint — checks if analytics pipeline is working.
 * Tests: env vars → Supabase connection → tables exist → insert/delete test row.
 */
export async function GET() {
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

  // Test 3: Insert + delete a test row to verify write permissions
  const { error: insertErr } = await supabase.from('swaps').insert({
    wallet: '0x_health_check_test',
    source: '_health_check',
    token_in: '0x0000000000000000000000000000000000000000',
    token_in_symbol: 'TEST',
    token_out: '0x0000000000000000000000000000000000000001',
    token_out_symbol: 'TEST',
    amount_in: '0',
    amount_out: '0',
    status: 'failed',
    chain_id: 0,
  })

  checks.canInsert = !insertErr
  if (insertErr) {
    checks.insertError = insertErr.message
  } else {
    // Clean up test row
    await supabase
      .from('swaps')
      .delete()
      .eq('wallet', '0x_health_check_test')
  }

  // Test 4: Count total swaps
  const { count, error: countErr } = await supabase
    .from('swaps')
    .select('*', { count: 'exact', head: true })

  if (!countErr) {
    checks.totalSwaps = count
  }

  // Overall status
  const allOk = checks.swapsTableExists && checks.quotesTableExists && checks.canInsert
  checks.status = allOk ? 'OK' : 'FAIL'

  return NextResponse.json(checks, { status: allOk ? 200 : 503 })
}
