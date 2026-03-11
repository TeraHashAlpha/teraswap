/**
 * GET /api/orders/:id/executions — DCA execution history
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
  if (!supabase) return NextResponse.json({ executions: [] })

  // Verify ownership
  const { data: order } = await supabase
    .from('orders')
    .select('wallet')
    .eq('id', id)
    .single()

  if (!order || order.wallet !== wallet.toLowerCase()) {
    return NextResponse.json({ executions: [], error: 'Not authorized' }, { status: 403 })
  }

  const { data, error } = await supabase
    .from('order_executions')
    .select('*')
    .eq('order_id', id)
    .order('execution_number', { ascending: true })

  if (error) return NextResponse.json({ executions: [], error: error.message })
  return NextResponse.json({ executions: data ?? [] })
}
