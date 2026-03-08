/**
 * Order Management API Routes (draft)
 *
 * These routes will be copied to src/app/api/orders/ when the
 * Order Engine is ready for production. For now, they live here
 * as reference implementation.
 *
 * Endpoints:
 *   POST   /api/orders          — Create a new order
 *   GET    /api/orders?wallet=  — List orders for a wallet
 *   PATCH  /api/orders/:id      — Cancel an order
 *   GET    /api/orders/active   — List all active orders (for Gelato)
 */

import { createClient } from '@supabase/supabase-js'

// Types matching the Supabase schema
interface CreateOrderRequest {
  wallet: string
  orderType: 'limit' | 'stop_loss' | 'dca'
  tokenIn: string
  tokenInSymbol: string
  tokenOut: string
  tokenOutSymbol: string
  amountIn: string
  minAmountOut: string
  targetPrice: string
  priceFeed: string
  priceCondition: 'above' | 'below'
  expiry: number
  nonce: number
  signature: string
  orderHash: string
  dcaInterval?: number
  dcaTotal?: number
  router?: string
}

// ── POST /api/orders — Create order ──────────────────────

export async function createOrder(body: CreateOrderRequest) {
  const supabase = getSupabase()
  if (!supabase) return { error: 'Supabase not configured' }

  // Validate required fields
  if (!body.wallet || !body.signature || !body.tokenIn || !body.tokenOut) {
    return { error: 'Missing required fields' }
  }

  // Validate expiry is in the future
  if (body.expiry <= Math.floor(Date.now() / 1000)) {
    return { error: 'Order expiry must be in the future' }
  }

  // Validate DCA fields
  if (body.orderType === 'dca') {
    if (!body.dcaInterval || body.dcaInterval < 60) {
      return { error: 'DCA interval must be at least 60 seconds' }
    }
    if (!body.dcaTotal || body.dcaTotal < 2) {
      return { error: 'DCA must have at least 2 executions' }
    }
  }

  const { data, error } = await supabase
    .from('orders')
    .insert({
      wallet: body.wallet.toLowerCase(),
      order_type: body.orderType,
      token_in: body.tokenIn.toLowerCase(),
      token_in_symbol: body.tokenInSymbol,
      token_out: body.tokenOut.toLowerCase(),
      token_out_symbol: body.tokenOutSymbol,
      amount_in: body.amountIn,
      min_amount_out: body.minAmountOut,
      target_price: body.targetPrice,
      price_feed: body.priceFeed,
      price_condition: body.priceCondition,
      expiry: body.expiry,
      nonce: body.nonce,
      signature: body.signature,
      order_hash: body.orderHash,
      dca_interval: body.dcaInterval ?? 0,
      dca_total: body.dcaTotal ?? 1,
      router: body.router ?? '',
      status: 'active',
    })
    .select()
    .single()

  if (error) return { error: error.message }
  return { order: data }
}

// ── GET /api/orders?wallet= — List user's orders ─────────

export async function listOrders(wallet: string, status?: string) {
  const supabase = getSupabase()
  if (!supabase) return { orders: [] }

  let query = supabase
    .from('orders')
    .select('*')
    .eq('wallet', wallet.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(50)

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) return { orders: [], error: error.message }
  return { orders: data ?? [] }
}

// ── PATCH /api/orders/:id — Cancel order ─────────────────

export async function cancelOrder(orderId: string, wallet: string) {
  const supabase = getSupabase()
  if (!supabase) return { error: 'Supabase not configured' }

  // Only allow the order owner to cancel
  const { data: order } = await supabase
    .from('orders')
    .select('wallet, status')
    .eq('id', orderId)
    .single()

  if (!order) return { error: 'Order not found' }
  if (order.wallet !== wallet.toLowerCase()) return { error: 'Not authorized' }
  if (order.status !== 'active') return { error: `Cannot cancel order in status: ${order.status}` }

  const { error } = await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)

  if (error) return { error: error.message }
  return { ok: true }
}

// ── GET /api/orders/active — All active orders (for Gelato) ──

export async function getActiveOrders() {
  const supabase = getSupabase()
  if (!supabase) return { orders: [] }

  const now = Math.floor(Date.now() / 1000)

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'active')
    .gt('expiry', now)
    .limit(100)

  if (error) return { orders: [], error: error.message }
  return { orders: data ?? [] }
}

// ── Helper ──

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}
