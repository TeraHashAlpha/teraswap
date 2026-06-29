/**
 * TeraSwapOrderExecutor v2 — Supabase order management
 *
 * Client-side Supabase client for order CRUD.
 * Uses the public anon key (RLS enforces wallet-based access).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ORDERS_TABLE, SUPABASE_EXECUTIONS_TABLE } from './config'
import type { AutonomousOrderStatus } from './types'

// ── Client singleton ─────────────────────────────────────
let _client: SupabaseClient | null = null

function getClient(): SupabaseClient | null {
  if (_client) return _client

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) return null

  _client = createClient(url, key, {
    auth: { persistSession: false },
  })
  return _client
}

// ── Supabase order row type ──────────────────────────────
export interface OrderRow {
  id: string
  wallet: string
  order_hash: string
  order_type: 'limit' | 'stop_loss' | 'dca'
  status: AutonomousOrderStatus
  // [CHORE-DCA-POSITIONS-DASHBOARD] Chain the order executes on; drives BaseScan links + chain-keyed
  // logos. Nullable for legacy rows (consumers default to mainnet=1).
  chain_id?: number | null
  token_in: string
  token_out: string
  token_in_symbol: string | null
  token_out_symbol: string | null
  // [CHORE-DCA-POSITIONS-DASHBOARD] Real token decimals (persisted at create time). Previously ignored
  // by rowToOrder (hardcoded 18) → wrong amounts for non-18 tokens like USDC(6).
  token_in_decimals?: number | null
  token_out_decimals?: number | null
  amount_in: string
  min_amount_out: string
  target_price: string
  price_feed: string
  expiry: string                // ISO timestamp
  nonce: number
  router: string
  dca_interval: number | null
  dca_total: number | null
  dca_executed: number
  signature: string
  order_data: Record<string, unknown>  // full Order struct as JSON
  tx_hash: string | null
  amount_out: string | null
  error: string | null
  created_at: string
  executed_at: string | null
}

// ── Execution row type ───────────────────────────────────
export interface ExecutionRow {
  id: string
  order_id: string
  execution_number: number
  amount_in: string
  amount_out: string
  tx_hash: string
  created_at: string
}

// ── Create order (via server-side API — bypasses RLS) ────
export async function createOrderInSupabase(params: {
  wallet: string
  // [CHORE-ORDER-API-CHAIN-AWARE] The chainId the order was SIGNED under (= the chainId passed to
  // getOrderExecutorDomain at sign time). The backend derives its verify domain from THIS value, so
  // sent == signed and recovery is byte-identical to the signing domain.
  chainId: number
  orderHash: string
  orderType: 'limit' | 'stop_loss' | 'dca'
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  targetPrice: string
  priceFeed: string
  priceCondition: 'above' | 'below'
  expiry: Date
  nonce: number
  router: string
  // [CHORE-DCA-PRELAUNCH-FIXES Fix 2] Canonical DCA params taken from the SIGNED struct
  // (never null on the write path) — single source of truth, no second default here.
  dcaInterval: number
  dcaTotal: number
  signature: string
  orderData: Record<string, unknown>
  tokenInSymbol: string
  tokenOutSymbol: string
  tokenInDecimals: number
  tokenOutDecimals: number
}): Promise<OrderRow | null> {
  // Submitting order via API

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: params.wallet,
        // [CHORE-ORDER-API-CHAIN-AWARE] Backend derives the verify domain from this signed chainId.
        chainId: params.chainId,
        orderHash: params.orderHash,
        orderType: params.orderType,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        tokenInSymbol: params.tokenInSymbol,
        tokenOutSymbol: params.tokenOutSymbol,
        amountIn: params.amountIn,
        minAmountOut: params.minAmountOut,
        targetPrice: params.targetPrice,
        priceFeed: params.priceFeed,
        priceCondition: params.priceCondition,
        expiry: Math.floor(params.expiry.getTime() / 1000),
        nonce: params.nonce,
        router: params.router,
        dcaInterval: params.dcaInterval,
        dcaTotal: params.dcaTotal,
        signature: params.signature,
        orderData: params.orderData,
        tokenInDecimals: params.tokenInDecimals,
        tokenOutDecimals: params.tokenOutDecimals,
      }),
    })

    const json = await res.json()
    if (!res.ok) {
      console.error('[OrderEngine] API error:', json.error)
      throw new Error(json.error || `API error ${res.status}`)
    }

    // Order saved successfully
    return json.order ?? null
  } catch (err) {
    console.error('[OrderEngine] createOrder failed:', err)
    throw err
  }
}

// ── Fetch user's orders (via API route — server-side Supabase) ──
export async function fetchUserOrders(wallet: string): Promise<OrderRow[]> {
  try {
    const res = await fetch(`/api/orders?wallet=${wallet}`)
    if (!res.ok) return []
    const json = await res.json()
    return json.orders ?? []
  } catch {
    console.error('[OrderEngine] fetchUserOrders failed')
    return []
  }
}

// ── Fetch orders the poll tracks (live + terminal) for a wallet ──────────────
// [CHORE-DCA-UX-FIXES] Bug 3b: this feeds useOrderEngine's poll. It MUST include the terminal
// statuses, not just the live ones — otherwise, when the keeper marks an order 'failed' (or
// 'executed'/'cancelled'/'expired'), the poll never sees the transition and the order stays "active"
// in the UI forever / silently vanishes from where the user expected it. Including the terminal
// statuses lets the poll move a failed order to "Failed" so it never vanishes.
const POLL_STATUSES = 'active,executing,partially_filled,executed,failed,cancelled,expired'
export async function fetchActiveOrders(wallet: string): Promise<OrderRow[]> {
  try {
    const res = await fetch(`/api/orders?wallet=${wallet}&status=${POLL_STATUSES}`)
    if (!res.ok) return []
    const json = await res.json()
    return json.orders ?? []
  } catch {
    console.error('[OrderEngine] fetchActiveOrders failed')
    return []
  }
}

// [FULL-H-01] Authentication produced by the caller (a wallet EIP-712
// signature over the CancelOrder message). Resolved lazily against the
// Supabase row id, which is only known after the hash lookup below.
export interface CancelAuth {
  signature: string
  chainId: number
}

// ── Cancel order in Supabase (via API route) ─────────────
export async function cancelOrderInSupabase(
  wallet: string,
  orderHash: string,
  // [FULL-H-01] Sign the CancelOrder message for the resolved Supabase row
  // id. The endpoint now rejects unsigned cancels, so callers that want the
  // Supabase row marked cancelled MUST provide this.
  sign?: (orderId: string) => Promise<CancelAuth>,
): Promise<boolean> {
  try {
    // Find the order by hash first, then cancel via [id] route
    const orders = await fetchUserOrders(wallet)
    const order = orders.find(o => o.order_hash === orderHash && o.status === 'active')
    if (!order) return false

    const body: Record<string, unknown> = { wallet }
    if (sign) {
      const auth = await sign(order.id)
      body.signature = auth.signature
      body.chainId = auth.chainId
    }

    const res = await fetch(`/api/orders/${order.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    console.error('[OrderEngine] cancelOrder failed')
    return false
  }
}

// ── Fetch DCA executions ─────────────────────────────────
export async function fetchDCAExecutions(orderId: string): Promise<ExecutionRow[]> {
  const client = getClient()
  if (!client) return []

  const { data, error } = await client
    .from(SUPABASE_EXECUTIONS_TABLE)
    .select('*')
    .eq('order_id', orderId)
    .order('execution_number', { ascending: true })

  if (error) {
    console.error('[OrderEngine] Supabase executions fetch error:', error.message)
    return []
  }
  return data ?? []
}

// ── Subscribe to order status changes ────────────────────
export function subscribeToOrders(
  wallet: string,
  onUpdate: (order: OrderRow) => void,
): (() => void) {
  const client = getClient()
  if (!client) return () => {}

  const channel = client
    .channel(`orders:${wallet.toLowerCase()}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: SUPABASE_ORDERS_TABLE,
        filter: `wallet=eq.${wallet.toLowerCase()}`,
      },
      (payload) => {
        onUpdate(payload.new as OrderRow)
      },
    )
    .subscribe()

  return () => { client.removeChannel(channel) }
}
