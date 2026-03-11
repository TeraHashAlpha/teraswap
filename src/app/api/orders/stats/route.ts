/**
 * GET /api/orders/stats — Order Engine statistics
 *
 * Returns aggregate stats: total orders, active, executed, etc.
 * Useful for the dashboard and monitoring.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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
      let q = supabase!.from('orders').select('*', { count: 'exact', head: true })
      if (wallet) q = q.eq('wallet', wallet.toLowerCase())
      return q
    }

    // Get counts per status in parallel (now all apply wallet filter)
    const [active, executed, cancelled, expired, total] = await Promise.all([
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
        .then(r => r.count ?? 0),
    ])

    // Get recent executions count (last 24h)
    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString()
    let execQuery = supabase
      .from('order_executions')
      .select('*', { count: 'exact', head: true })
      .gte('executed_at', oneDayAgo)
    // If wallet filter provided, only count executions for that wallet's orders
    if (wallet) {
      execQuery = execQuery.eq('wallet', wallet.toLowerCase())
    }
    const { count: recentExecutions } = await execQuery

    return NextResponse.json({
      total,
      active,
      executed,
      cancelled,
      expired,
      recentExecutions24h: recentExecutions ?? 0,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
