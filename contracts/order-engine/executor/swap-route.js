/**
 * swap-route.js — pure builders for the keeper's /api/quote + /api/swap requests.
 *
 * Extracted from executor.js so they are unit-testable without importing
 * executor.js (which runs the keeper on import). They mirror the frontend's
 * instant-swap flow (src/hooks/useSwap.ts → /api/quote then /api/swap), which is
 * the contract /api/swap actually enforces.
 *
 * Why this exists — the keeper used to POST { source: "best", ... } with no
 * token decimals, which /api/swap rejects on Base (and any chain):
 *   1. `source: "best"` is not an AGGREGATOR_APIS key → the source allow-list
 *      (route.ts) returns 400 { code: "INVALID_SOURCE" }. The frontend never
 *      sends "best" — it first GETs /api/quote, which returns the best CONCRETE
 *      source, then POSTs /api/swap with that source.
 *   2. Absent srcDecimals/dstDecimals default to 18 server-side, so a non-18-dec
 *      output token (e.g. USDC = 6) is mis-scaled and the DefiLlama price guard
 *      blocks with 422 (output "100% below fair value"). The frontend always
 *      sends token decimals.
 * Captured 400/422 bodies + the exact mismatch are in FEEDBACK.md.
 *
 * Mainnet keeps byte-identical chainId handling (from chore/keeper-swap-chainid):
 * /api/quote and /api/swap treat an absent chainId as the mainnet default, so
 * for CHAIN_ID=1 (or absent) chainId is omitted from both requests.
 * [chore/keeper-swap-payload-fix]
 */

/** Mainnet chain id — the /api/quote + /api/swap default; chainId is omitted for
 *  it so the requests stay byte-identical on mainnet. */
export const MAINNET_CHAIN_ID = 1

/** Keeper swap slippage tolerance (%), unchanged from the original request. */
export const KEEPER_SLIPPAGE = 0.5

/** True when a non-mainnet chain id should be sent explicitly. */
function isExplicitChain(chainId) {
  return chainId != null && Number(chainId) !== MAINNET_CHAIN_ID
}

/**
 * Build the GET path for /api/quote — the keeper has no UI quote step, so it must
 * ask the meta-quote which concrete source wins before building swap calldata.
 * @param {object} p
 * @param {string} p.tokenIn   sell token address
 * @param {string} p.tokenOut  buy token address
 * @param {string} p.amount    sell amount (raw bigint string)
 * @param {number} [p.srcDecimals] sell token decimals (default 18)
 * @param {number} [p.dstDecimals] buy token decimals (default 18)
 * @param {number} [p.chainId] target chain; omitted on mainnet / when absent
 * @returns {string} path like "/api/quote?src=…&dst=…&amount=…&srcDecimals=…&dstDecimals=…[&chainId=…]"
 */
export function buildQuotePath({ tokenIn, tokenOut, amount, srcDecimals = 18, dstDecimals = 18, chainId }) {
  const qs = new URLSearchParams({
    src: tokenIn,
    dst: tokenOut,
    amount: String(amount),
    srcDecimals: String(srcDecimals),
    dstDecimals: String(dstDecimals),
  })
  if (isExplicitChain(chainId)) {
    qs.set("chainId", String(Number(chainId)))
  }
  return `/api/quote?${qs.toString()}`
}

/**
 * Build the JSON body for POST /api/swap, mirroring the frontend useSwap call.
 * `source` MUST be a concrete AGGREGATOR_APIS source (e.g. from /api/quote's
 * best.source) — never "best" — or /api/swap returns 400 INVALID_SOURCE.
 * @param {object} p
 * @param {string} p.source     concrete aggregator source (required)
 * @param {string} p.tokenIn    sell token address
 * @param {string} p.tokenOut   buy token address
 * @param {string} p.amount     sell amount (raw bigint string)
 * @param {string} p.from       caller (the OrderExecutor contract)
 * @param {number} [p.srcDecimals] sell token decimals (default 18)
 * @param {number} [p.dstDecimals] buy token decimals (default 18)
 * @param {number} [p.chainId]  target chain; omitted on mainnet / when absent
 * @returns {object} request body matching the /api/swap param contract
 */
export function buildSwapRoutePayload({
  source, tokenIn, tokenOut, amount, from, srcDecimals = 18, dstDecimals = 18, chainId,
}) {
  if (!source || typeof source !== "string") {
    throw new Error("buildSwapRoutePayload: a concrete `source` is required (got " + JSON.stringify(source) + "); fetch /api/quote best.source first — never send 'best'")
  }

  const payload = {
    source,
    src: tokenIn,
    dst: tokenOut,
    amount,
    from,
    slippage: KEEPER_SLIPPAGE,
    // Token decimals are required for correct output scaling; without them the
    // server defaults to 18 and the DefiLlama price guard 422s non-18-dec tokens.
    srcDecimals,
    dstDecimals,
  }

  // chainId is a BODY field on /api/swap. Include it only for a non-mainnet
  // chain: /api/swap treats absent chainId as the mainnet default, so omitting
  // it for CHAIN_ID=1 keeps the mainnet request byte-identical.
  if (isExplicitChain(chainId)) {
    payload.chainId = Number(chainId)
  }

  return payload
}

// ── Per-chunk NET amount (mirrors TeraSwapOrderExecutor.executeOrder) ────────
// [chore/dca-router-chainaware] The contract takes the 0.1% fee in tokenIn FIRST
// and `forceApprove(order.router, netAmount)` — so the keeper must build the swap
// for netAmount, not the full chunk. For DCA the per-chunk executeAmount uses the
// contract's CUMULATIVE formula (last chunk = remainder, eliminating dust). These
// constants mirror the on-chain FEE_BPS=10 / BPS_DENOMINATOR=10000.
export const FEE_BPS = 10n
export const BPS_DENOMINATOR = 10000n

/**
 * @param {object} p
 * @param {string|bigint} p.amountIn  the order's TOTAL signed amountIn
 * @param {number} [p.dcaTotal]       number of DCA chunks (required when isDca)
 * @param {number} [p.execCount]      chunks already executed (dca_executed); default 0
 * @param {boolean} p.isDca           DCA order?
 * @returns {string} the netAmount (raw bigint string) the swap calldata must use
 */
export function computeNetChunkAmount({ amountIn, dcaTotal, execCount = 0, isDca }) {
  const total = BigInt(amountIn)
  let executeAmount
  if (isDca) {
    const dt = BigInt(dcaTotal)
    if (dt <= 0n) throw new Error("computeNetChunkAmount: dcaTotal must be > 0 for a DCA order")
    const n = BigInt(execCount)
    const cumulativeTarget = (total * (n + 1n)) / dt
    const previouslyExecuted = (total * n) / dt
    executeAmount = cumulativeTarget - previouslyExecuted
    // Contract: the FINAL execution gets the exact remainder (no dust).
    if (n === dt - 1n) executeAmount = total - previouslyExecuted
  } else {
    executeAmount = total
  }
  const fee = (executeAmount * FEE_BPS) / BPS_DENOMINATOR
  return (executeAmount - fee).toString()
}

// ── Committed router → /api/swap source ─────────────────────────────────────
// [chore/dca-router-chainaware] A conditional order commits a specific
// `order.router` (EIP-712 signed). The keeper must build calldata for THAT router,
// so it requests the /api/swap source that targets it (NOT the unconstrained best
// source). Keyed by lowercased router address (addresses are globally unique, so
// this is chain-agnostic). MUST mirror the frontend whitelist
// (src/lib/order-engine/config.ts) AND the on-chain whitelistedRouters() of each
// OrderExecutor. The keeper additionally verifies tx.to === order.router before
// sending, so a stale entry fails safe (skip) rather than mis-routing funds.
const ROUTER_SOURCE = {
  // Base (8453) — verified whitelisted on 0x135B339902Ea4E0fB4CF059961dc8856bA1D2598
  "0x6a000f20005980200259b80c5102003040001068": "velora",    // ParaSwap/Velora Augustus V6
  "0x2626664c2603336e57b271c5c0b26f421741e481": "uniswapv3",  // Uniswap SwapRouter02
  // Mainnet (1) — unchanged
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch",      // 1inch v6
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x",         // 0x Exchange Proxy
}

/** Resolve the /api/swap source for a committed order.router, or null if unknown. */
export function sourceForRouter(router) {
  if (!router || typeof router !== "string") return null
  return ROUTER_SOURCE[router.toLowerCase()] ?? null
}
