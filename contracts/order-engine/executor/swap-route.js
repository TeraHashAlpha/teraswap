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
