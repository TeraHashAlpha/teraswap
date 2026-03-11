/**
 * Order Management API Routes v2
 *
 * These routes will be copied to src/app/api/orders/ when the
 * Order Engine is ready for production. For now, they live here
 * as reference implementation.
 *
 * v2 CHANGES:
 * - [M-05] Signature verification on order creation (server-side)
 * - [L-05] Wallet address validation + normalization
 * - Rate limiting via check_order_rate_limit()
 * - Router is now required (part of signed order)
 * - Execution history endpoint for DCA orders
 *
 * Endpoints:
 *   POST   /api/orders          — Create a new order
 *   GET    /api/orders?wallet=  — List orders for a wallet
 *   PATCH  /api/orders/:id      — Cancel an order
 *   GET    /api/orders/active   — List all active orders (for Gelato)
 *   GET    /api/orders/:id/executions — DCA execution history
 */

import { createClient } from '@supabase/supabase-js'
import { ethers } from 'ethers'

// ── Constants ────────────────────────────────────────────────

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/
const MAX_EXPIRY_DAYS = 90 // Orders can't expire more than 90 days from now
const MAX_ACTIVE_ORDERS = 20 // Per wallet

// EIP-712 domain for signature verification
const EIP712_DOMAIN = {
  name: 'TeraSwapOrderExecutor',
  version: '2',
  // chainId and verifyingContract set at runtime
}

const ORDER_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'orderType', type: 'uint8' },
    { name: 'condition', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'priceFeed', type: 'address' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'dcaInterval', type: 'uint256' },
    { name: 'dcaTotal', type: 'uint256' },
  ],
}

// ── Types ────────────────────────────────────────────────────

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
  router: string // [H-01] Required in v2
  dcaInterval?: number
  dcaTotal?: number
}

// ── POST /api/orders — Create order ──────────────────────────

export async function createOrder(body: CreateOrderRequest) {
  const supabase = getSupabase()
  if (!supabase) return { error: 'Supabase not configured' }

  // ── [L-06] Validate address formats ──
  if (!ADDRESS_REGEX.test(body.wallet)) return { error: 'Invalid wallet address format' }
  if (!ADDRESS_REGEX.test(body.tokenIn)) return { error: 'Invalid tokenIn address format' }
  if (!ADDRESS_REGEX.test(body.tokenOut)) return { error: 'Invalid tokenOut address format' }
  if (!ADDRESS_REGEX.test(body.router)) return { error: 'Invalid router address format' }

  // Validate required fields
  if (!body.signature || !body.orderHash) {
    return { error: 'Missing signature or orderHash' }
  }

  if (!body.amountIn || body.amountIn === '0') {
    return { error: 'amountIn must be positive' }
  }

  if (!body.minAmountOut || body.minAmountOut === '0') {
    return { error: 'minAmountOut must be positive' }
  }

  // Validate expiry is in the future and not too far
  const now = Math.floor(Date.now() / 1000)
  if (body.expiry <= now) {
    return { error: 'Order expiry must be in the future' }
  }
  if (body.expiry > now + MAX_EXPIRY_DAYS * 86400) {
    return { error: `Order expiry cannot exceed ${MAX_EXPIRY_DAYS} days` }
  }

  // Validate DCA fields
  if (body.orderType === 'dca') {
    if (!body.dcaInterval || body.dcaInterval < 60) {
      return { error: 'DCA interval must be at least 60 seconds' }
    }
    if (!body.dcaTotal || body.dcaTotal < 2 || body.dcaTotal > 365) {
      return { error: 'DCA must have 2-365 executions' }
    }
  }

  // Validate tokenIn != tokenOut
  if (body.tokenIn.toLowerCase() === body.tokenOut.toLowerCase()) {
    return { error: 'tokenIn and tokenOut must be different' }
  }

  // ── [M-05] Server-side signature verification ──
  const sigValid = verifyOrderSignature(body)
  if (!sigValid.valid) {
    return { error: `Invalid signature: ${sigValid.reason}` }
  }

  // ── Rate limiting ──
  const { data: canCreate } = await supabase.rpc('check_order_rate_limit', {
    p_wallet: body.wallet.toLowerCase(),
    p_max_orders: MAX_ACTIVE_ORDERS,
    p_window_minutes: 60,
  })

  if (!canCreate) {
    return { error: 'Rate limit exceeded. Max 20 active orders per hour.' }
  }

  // ── Insert order ──
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
      price_feed: body.priceFeed.toLowerCase(),
      price_condition: body.priceCondition,
      expiry: body.expiry,
      nonce: body.nonce,
      signature: body.signature,
      order_hash: body.orderHash,
      dca_interval: body.dcaInterval ?? 0,
      dca_total: body.dcaTotal ?? 1,
      router: body.router.toLowerCase(),
      status: 'active',
    })
    .select()
    .single()

  if (error) {
    // Unique constraint on order_hash catches duplicates
    if (error.code === '23505') {
      return { error: 'Order already exists (duplicate hash)' }
    }
    return { error: error.message }
  }

  return { order: data }
}

// ── GET /api/orders?wallet= — List user's orders ─────────────

export async function listOrders(wallet: string, status?: string) {
  const supabase = getSupabase()
  if (!supabase) return { orders: [] }

  if (!ADDRESS_REGEX.test(wallet)) return { orders: [], error: 'Invalid wallet address' }

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

// ── PATCH /api/orders/:id — Cancel order ─────────────────────

export async function cancelOrder(orderId: string, wallet: string) {
  const supabase = getSupabase()
  if (!supabase) return { error: 'Supabase not configured' }

  if (!ADDRESS_REGEX.test(wallet)) return { error: 'Invalid wallet address' }

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
    .order('created_at', { ascending: true }) // Oldest first (priority)
    .limit(100)

  if (error) return { orders: [], error: error.message }
  return { orders: data ?? [] }
}

// ── GET /api/orders/:id/executions — DCA execution history ───

export async function getOrderExecutions(orderId: string, wallet: string) {
  const supabase = getSupabase()
  if (!supabase) return { executions: [] }

  // Verify ownership
  const { data: order } = await supabase
    .from('orders')
    .select('wallet')
    .eq('id', orderId)
    .single()

  if (!order || order.wallet !== wallet.toLowerCase()) {
    return { executions: [], error: 'Not authorized' }
  }

  const { data, error } = await supabase
    .from('order_executions')
    .select('*')
    .eq('order_id', orderId)
    .order('execution_number', { ascending: true })

  if (error) return { executions: [], error: error.message }
  return { executions: data ?? [] }
}

// ── Helpers ──────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

/**
 * [M-05] Verify EIP-712 signature matches the order data.
 * This prevents submitting orders with tampered data.
 */
function verifyOrderSignature(body: CreateOrderRequest): { valid: boolean; reason?: string } {
  try {
    const chainId = parseInt(process.env.CHAIN_ID || '1')
    const verifyingContract = process.env.ORDER_EXECUTOR_ADDRESS

    if (!verifyingContract) {
      return { valid: false, reason: 'ORDER_EXECUTOR_ADDRESS not set' }
    }

    const domain = {
      ...EIP712_DOMAIN,
      chainId,
      verifyingContract,
    }

    const orderTypeEnum = body.orderType === 'limit' ? 0 : body.orderType === 'stop_loss' ? 1 : 2
    const conditionEnum = body.priceCondition === 'above' ? 0 : 1

    const message = {
      owner: body.wallet,
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      amountIn: body.amountIn,
      minAmountOut: body.minAmountOut,
      orderType: orderTypeEnum,
      condition: conditionEnum,
      targetPrice: body.targetPrice,
      priceFeed: body.priceFeed,
      expiry: body.expiry,
      nonce: body.nonce,
      router: body.router,
      dcaInterval: body.dcaInterval ?? 0,
      dcaTotal: body.dcaTotal ?? 1,
    }

    // Recover signer from EIP-712 typed data signature
    const recoveredAddress = ethers.verifyTypedData(
      domain,
      ORDER_TYPES,
      message,
      body.signature,
    )

    if (recoveredAddress.toLowerCase() !== body.wallet.toLowerCase()) {
      return { valid: false, reason: `Signer mismatch: expected ${body.wallet}, got ${recoveredAddress}` }
    }

    return { valid: true }
  } catch (err: any) {
    return { valid: false, reason: err.message || 'Signature verification failed' }
  }
}
