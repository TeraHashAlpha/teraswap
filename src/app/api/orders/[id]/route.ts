/**
 * PATCH /api/orders/:id — Cancel an order
 * GET   /api/orders/:id — Get order details
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
  // [BUGFIX] Require wallet param for authentication — prevent data leakage
  const wallet = req.nextUrl.searchParams.get('wallet')
  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: 'Missing or invalid wallet parameter' }, { status: 400 })
  }

  const supabase = getSupabase()
  if (!supabase) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .eq('wallet', wallet.toLowerCase())
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  return NextResponse.json({ order: data })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = getSupabase()
  if (!supabase) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  const body = await req.json()
  const wallet = body.wallet

  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: 'Invalid wallet' }, { status: 400 })
  }

  // [BUGFIX] Atomic cancel: use WHERE status='active' AND wallet=? in a single
  // UPDATE to prevent TOCTOU race condition where an executor changes status
  // between our check and update.
  const { data: updated, error } = await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('wallet', wallet.toLowerCase())
    .eq('status', 'active')
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!updated || updated.length === 0) {
    // Determine why it failed: order not found, wrong wallet, or wrong status
    const { data: order } = await supabase
      .from('orders')
      .select('wallet, status')
      .eq('id', id)
      .single()

    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    if (order.wallet !== wallet.toLowerCase()) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }
    return NextResponse.json(
      { error: `Cannot cancel order in status: ${order.status}` },
      { status: 409 },
    )
  }

  return NextResponse.json({ ok: true })
}
