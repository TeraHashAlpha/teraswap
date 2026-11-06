/**
 * TeraSwapOrderExecutor v2 — order management, browser side.
 *
 * Every call here goes to OUR API (`/api/orders…`); the database is only ever reached by the server.
 *
 * [fix/user-ip-privacy] There is no Supabase client in the browser any more. This module used to
 * create one with the public anon key and open a Realtime WebSocket (`subscribeToOrders`) straight to
 * `<project>.supabase.co`, filtered by the connected wallet address — so with a wallet connected the
 * database provider saw the visitor's IP and wallet address directly. Order status now comes only from
 * the poll in useOrderEngine (`fetchActiveOrders`, every ORDER_POLL_INTERVAL_MS), which was always the
 * source of truth for transitions and now also carries the DCA fill count and tx hash between them.
 */

import { ordersReadHeaders, ReadAuthRequiredError, ORDER_POLL_MAX_HASHES } from './read-auth'
import type { AutonomousOrderStatus } from './types'

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
  // [FEAT-DCA-FLOOR-TIERS] Nullable; set only for a consent-requiring DCA.
  floor_tier?: string | null
  floor_ack_at?: string | null
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
  // [SPRINT-V3-P2 / ADR-013 §1] Present ONLY for a v3-signed order — the server uses this exact
  // top-level field (not orderData.maxSlippageBps) to decide the v2/v3 verification path.
  maxSlippageBps?: number
  // [SPRINT-P1B] The keccak256 the user actually SIGNED into the struct. MUST be sent for a pinned
  // route: the server rebuilds the EIP-712 message for recovery and falls back to ZeroHash when
  // this is absent, so omitting it would fail recovery with "Signature mismatch".
  routerDataHash?: `0x${string}`
  // [FEAT-DCA-FLOOR-TIERS] The user's acknowledgement; the server re-classifies and may refuse (409).
  floorAck?: { tier: string; acknowledgedAt: string }
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
        // [SPRINT-V3-P2] Omitted entirely (undefined ⇒ dropped by JSON.stringify) for a v2 order.
        ...(params.maxSlippageBps !== undefined ? { maxSlippageBps: params.maxSlippageBps } : {}),
        // [SPRINT-P1B] Omitted for DCA (the server's ZeroHash fallback is then correct, matching
        // what was signed). Sent verbatim for a pinned non-DCA route so recovery uses the SIGNED
        // hash, and so the server can cross-check it against orderData.routerData.
        ...(params.routerDataHash !== undefined ? { routerDataHash: params.routerDataHash } : {}),
        ...(params.floorAck !== undefined ? { floorAck: params.floorAck } : {}),
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
// [AUDIT-W6 / W6-M-01] Reads that include active orders require the session
// read signature (read-auth.ts). Cached headers are attached when present; a
// 401 READ_AUTH_REQUIRED throws ReadAuthRequiredError so useOrderEngine can
// sign once per session and retry.
export async function fetchUserOrders(wallet: string): Promise<OrderRow[]> {
  try {
    const res = await fetch(`/api/orders?wallet=${wallet}`, {
      headers: ordersReadHeaders(wallet) ?? undefined,
    })
    if (res.status === 401) throw new ReadAuthRequiredError()
    if (!res.ok) return []
    const json = await res.json()
    return json.orders ?? []
  } catch (err) {
    if (err instanceof ReadAuthRequiredError) throw err
    console.error('[OrderEngine] fetchUserOrders failed')
    return []
  }
}

// ── Fetch the orders the poll tracks, by order hash ──────────────────────────────────
// [CHORE-DCA-UX-FIXES] Bug 3b: the poll must see an order's TERMINAL transition too ('failed', 'executed',
// 'cancelled', 'expired'), or a failed order stays "active" in the UI forever.
// [fix/user-ip-privacy A76 S-6] It asks for exactly the orders the browser is tracking — the hashes of its locally
// live orders — whatever their status now (so Bug 3b stays fixed). It used to ask for the wallet's 50 newest rows in
// seven statuses: an order older than those 50 never got its update, and every tick re-read up to 50 terminal rows.
// A list longer than ORDER_POLL_MAX_HASHES is split into several requests.
const ORDER_HASH_RE = /^0x[0-9a-fA-F]{64}$/
export async function fetchActiveOrders(wallet: string, orderHashes: readonly string[]): Promise<OrderRow[]> {
  const hashes = [...new Set(orderHashes)].filter((h) => ORDER_HASH_RE.test(h))
  if (hashes.length === 0) return []
  const rows: OrderRow[] = []
  try {
    for (let i = 0; i < hashes.length; i += ORDER_POLL_MAX_HASHES) {
      // [W6-M-01] By-hash reads can include live strategy → same session signature.
      const res = await fetch(`/api/orders?wallet=${wallet}&hashes=${hashes.slice(i, i + ORDER_POLL_MAX_HASHES).join(',')}`, {
        headers: ordersReadHeaders(wallet) ?? undefined,
      })
      if (res.status === 401) throw new ReadAuthRequiredError()
      if (!res.ok) continue
      const json = await res.json()
      rows.push(...(json.orders ?? []))
    }
    return rows
  } catch (err) {
    if (err instanceof ReadAuthRequiredError) throw err
    console.error('[OrderEngine] fetchActiveOrders failed')
    return rows
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
