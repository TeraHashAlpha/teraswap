/**
 * swap-route.js — pure builder for the keeper's /api/swap request body.
 *
 * Extracted from executor.js (fetchSwapRoute) so it is unit-testable without
 * importing executor.js, which runs the keeper on import. It mirrors the
 * frontend instant-swap contract (src/hooks/useSwap.ts → src/app/api/swap/route.ts):
 * the swap parameters — including chainId — are sent in the JSON BODY.
 *
 * chainId is what fixes "Swap API error: 400" for Base DCA chunks: without it
 * /api/swap defaults to mainnet (chainId=1) and cannot route Base tokens
 * (AERO, Base WETH 0x4200…0006), returning no route. With chainId=8453 the
 * route resolves on Base.
 *
 * Mainnet is byte-identical: /api/swap treats an absent chainId as the mainnet
 * default, so for CHAIN_ID=1 (or an absent/null chainId) the field is omitted
 * and the request body matches the legacy keeper request exactly.
 * [chore/keeper-swap-chainid]
 */

/** Mainnet chain id — the /api/swap default; chainId is omitted for it so the
 *  request stays byte-identical to the pre-fix keeper body. */
export const MAINNET_CHAIN_ID = 1

/** Keeper swap slippage tolerance (%), unchanged from the original request. */
export const KEEPER_SLIPPAGE = 0.5

/**
 * Build the JSON body for POST /api/swap.
 * @param {object} p
 * @param {string} p.tokenIn   sell token address
 * @param {string} p.tokenOut  buy token address
 * @param {string} p.amount    sell amount (raw bigint string)
 * @param {string} p.from      caller (the OrderExecutor contract)
 * @param {string} p.router    preferred router
 * @param {number} [p.chainId] target chain; omitted on mainnet / when absent
 * @returns {object} request body matching the /api/swap param contract
 */
export function buildSwapRoutePayload({ tokenIn, tokenOut, amount, from, router, chainId }) {
  const payload = {
    source: "best",
    src: tokenIn,
    dst: tokenOut,
    amount,
    from,
    slippage: KEEPER_SLIPPAGE,
    preferredRouter: router,
  }

  // chainId is a BODY field on /api/swap. Include it only for a non-mainnet
  // chain: /api/swap treats absent chainId as the mainnet default, so omitting
  // it for CHAIN_ID=1 keeps the mainnet request byte-identical.
  if (chainId != null && Number(chainId) !== MAINNET_CHAIN_ID) {
    payload.chainId = Number(chainId)
  }

  return payload
}
