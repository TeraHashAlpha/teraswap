/**
 * GET /api/orders/stats — Order Engine statistics
 *
 * Returns aggregate stats: total orders, active, executed, etc.
 * Useful for the dashboard and monitoring.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  verifyOrdersReadAccess,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function GET(req: NextRequest) {
  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  const wallet = req.nextUrl.searchParams.get('wallet')

  try {
    // [BUGFIX] Helper to build query with optional wallet filter — was previously
    // constructed via baseFilter but never actually applied to the parallel queries
    function ordersQuery() {
      // [fix/order-signature-not-returned] A count (head: true) returns no row, but an orders read names its columns,
      // never `*` (orders-read-select-guard.test.ts); `id` gives the same count.
      let q = supabase!.from('orders').select('id', { count: 'exact', head: true })
      if (wallet) q = q.eq('wallet', wallet.toLowerCase())
      return q
    }

    // Get counts per status in parallel (now all apply wallet filter).
    // [CHORE-DCA-VISIBILITY-AND-STATS] `failed` was previously omitted, so the
    // per-status buckets didn't sum to `total` (recon: 35 total vs 28 counted —
    // the 7 keeper-`failed` orders were invisible). Now counted.
    const [active, executed, cancelled, expired, failed, total] = await Promise.all([
      ordersQuery()
        .eq('status', 'active')
        .then(r => r.count ?? 0),
      ordersQuery()
        .eq('status', 'executed')
        .then(r => r.count ?? 0),
      ordersQuery()
        .eq('status', 'cancelled')
        .then(r => r.count ?? 0),
      ordersQuery()
        .eq('status', 'expired')
        .then(r => r.count ?? 0),
      ordersQuery()
        .eq('status', 'failed')
        .then(r => r.count ?? 0),
      ordersQuery()
        .then(r => r.count ?? 0),
    ])

    // [A97 S-3] One wallet's fills in the last 24 h include its LIVE orders' (their progress, which the executions route
    // shows only with the wallet's read signature): for `?wallet=W` the count is returned only with W's valid read
    // signature, otherwise the field is left out and the fills table is not read. The counts by status above stay open, and
    // the count with no wallet (every wallet's fills together) is unchanged.
    // The signature is checked on EVERY request, so whether it is checked never depends on the query string (CodeQL
    // js/user-controlled-bypass); with no wallet it cannot hold (verifyOrdersReadAccess never throws) and is not needed.
    const auth = await verifyOrdersReadAccess({
      wallet: wallet ?? '',
      issuedAt: req.headers.get(ORDERS_READ_HEADER_ISSUED),
      signature: req.headers.get(ORDERS_READ_HEADER_SIGNATURE),
    })
    const includeRecent = !wallet || auth.ok

    let recentExecutions: number | null = null
    if (includeRecent) {
      // Get recent executions count (last 24h). order_executions has no `wallet`
      // or `executed_at` column — timestamp is `created_at`, wallet is via join to orders.
      const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString()
      let execQuery = supabase
        .from('order_executions')
        .select('*, orders!inner(wallet)', { count: 'exact', head: true })
        .gte('created_at', oneDayAgo)
      // If wallet filter provided, only count executions for that wallet's orders
      if (wallet) {
        execQuery = execQuery.eq('orders.wallet', wallet.toLowerCase())
      }
      recentExecutions = (await execQuery).count
    }

    return NextResponse.json({
      total,
      active,
      executed,
      cancelled,
      expired,
      failed,
      ...(includeRecent ? { recentExecutions24h: recentExecutions ?? 0 } : {}),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
