/**
 * GET /api/orders/:id/executions — execution history for a single order.
 *
 * Returns both the `order_executions` rows (per-fill detail for DCA, or the
 * single fill row for Limit/SL/TP) AND a slim subset of the parent order's
 * metadata. Bundling the metadata avoids a second round-trip from
 * ExecutionTimeline.tsx and lets it build a synthetic entry when a legacy
 * order has been executed without `order_executions` rows.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const wallet = req.nextUrl.searchParams.get('wallet')

  // [BUGFIX] Require wallet param for authentication — was optional before,
  // allowing anyone to view execution history for any order
  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: 'Missing or invalid wallet parameter' }, { status: 400 })
  }

  const supabase = getSupabase()
  if (!supabase) return NextResponse.json({ executions: [], order: null })

  // Fetch order + ownership + display metadata in one query.
  const { data: order } = await supabase
    .from('orders')
    .select(
      'wallet, token_in_symbol, token_out_symbol, token_in_decimals, token_out_decimals, dca_total, dca_executed, tx_hash, amount_out, gas_used, executed_at, executed_price',
    )
    .eq('id', id)
    .single()

  if (!order || order.wallet !== wallet.toLowerCase()) {
    return NextResponse.json(
      { executions: [], order: null, error: 'Not authorized' },
      { status: 403 },
    )
  }

  const { data, error } = await supabase
    .from('order_executions')
    .select('*')
    .eq('order_id', id)
    .order('execution_number', { ascending: true })

  const orderMeta = {
    token_in_symbol: order.token_in_symbol,
    token_out_symbol: order.token_out_symbol,
    token_in_decimals: order.token_in_decimals,
    token_out_decimals: order.token_out_decimals,
    dca_total: order.dca_total,
    dca_executed: order.dca_executed,
    tx_hash: order.tx_hash,
    amount_out: order.amount_out,
    gas_used: order.gas_used,
    executed_at: order.executed_at,
    executed_price: order.executed_price,
  }

  if (error) return NextResponse.json({ executions: [], order: orderMeta, error: error.message })
  return NextResponse.json({ executions: data ?? [], order: orderMeta })
}
