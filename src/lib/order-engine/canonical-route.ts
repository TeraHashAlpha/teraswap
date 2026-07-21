/**
 * [SPRINT-P1B / ADR-014 option (a)] Canonical pinned-route builder for non-DCA (Limit / Take-Profit)
 * conditional orders on OrderExecutorV3.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 * v3's `executeOrder` REQUIRES a real `routerDataHash` for non-DCA orders (ZeroHash reverts
 * `RouterDataRequired`, a wrong hash reverts `RouterDataMismatch` — TeraSwapOrderExecutorV3.sol
 * :463-465). So the exact swap calldata must be committed at SIGNING time, then replayed verbatim
 * at TRIGGER time — which may be up to 90 days later.
 *
 * That is only sound if the calldata contains NO quote-derived and NO clock-derived bytes.
 * Aggregator calldata (Augustus, 0x, Kyber, Bebop) fails this: it embeds quoted amounts, deadlines
 * and RFQ maker signatures with expiry. A CANONICAL Uniswap V3 route does not — every field below
 * is a pure function of the signed order struct plus static chain config. See ADR-014 for the full
 * options analysis and why aggregator pinning was rejected.
 *
 * ── Field-by-field determinism (SwapRouter02 `exactInputSingle`, selector 0x04e45aaf) ────────
 * | field              | value                                   | why it is deterministic          |
 * |--------------------|-----------------------------------------|----------------------------------|
 * | tokenIn / tokenOut | order.tokenIn / order.tokenOut          | signed into the order struct     |
 * | fee                | the pool tier pinned at creation        | static; committed via the hash   |
 * | recipient          | the OrderExecutorV3 address             | the contract measures its OWN    |
 * |                    |                                         | balance delta (:567/:579) then   |
 * |                    |                                         | forwards to order.owner (:592)   |
 * | amountIn           | netAmount = amountIn − fee              | FEE_BPS/BPS_DENOMINATOR are      |
 * |                    |                                         | `constant` (:131-132) and non-DCA|
 * |                    |                                         | sets executeAmount = amountIn    |
 * |                    |                                         | (:500) ⇒ fully deterministic     |
 * | amountOutMinimum   | the SIGNED order.minAmountOut           | signed; the binding on-chain     |
 * |                    |                                         | floor is max(oracleFloor, this)  |
 * |                    |                                         | at :532-554 regardless           |
 * | sqrtPriceLimitX96  | 0                                       | constant — no price limit        |
 *
 * NOTE — no `deadline`. SwapRouter02's `exactInputSingle` has NO deadline field (unlike the
 * original SwapRouter, selector 0x414bf389, whose struct carries one). The time bound is enforced
 * on-chain by the executor itself: `block.timestamp > order.expiry` reverts `OrderExpired`
 * (:454). So the pinned calldata commits no clock at all — strictly better for determinism.
 *
 * This module is PURE: no network, no Date, no randomness. That is asserted by its tests.
 */

import { encodeAbiParameters, keccak256, isAddress } from 'viem'

/** SwapRouter02 `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`. */
export const SWAPROUTER02_EXACT_INPUT_SINGLE_SELECTOR = '0x04e45aaf' as const

/**
 * The SwapRouter02 params tuple — 7 fields, NO deadline. Mirrors the shape the repo already
 * decodes in `src/lib/calldata-decoder.ts` (`tryDecodeV3ExactInputSingle`) and encodes in
 * `src/lib/calldata-recipient.test.ts`, so the pinned bytes stay decodable by the review UI.
 */
export const EXACT_INPUT_SINGLE_PARAMS = [
  {
    name: 'params',
    type: 'tuple',
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  },
] as const

/** The four canonical Uniswap V3 fee tiers. A tier outside this set is rejected fail-closed. */
export const CANONICAL_FEE_TIERS = [100, 500, 3000, 10000] as const
export type CanonicalFeeTier = (typeof CANONICAL_FEE_TIERS)[number]

/**
 * Mirror of TeraSwapOrderExecutorV3.sol's fee constants (:131-132). These are Solidity
 * `constant`s compiled into the immutable bytecode — there is no setter, so replicating them
 * here cannot drift. `types.test.ts`-style drift guarding is covered by the unit tests.
 */
export const ORDER_FEE_BPS = 10n
export const ORDER_BPS_DENOMINATOR = 10_000n

/**
 * The exact amount the executor will approve and the router will pull.
 *
 * Contract (:518-519):
 *   fee       = executeAmount * FEE_BPS / BPS_DENOMINATOR   // floor division
 *   netAmount = executeAmount - fee
 * For non-DCA, executeAmount = order.amountIn (:500). Solidity integer division floors, so this
 * uses BigInt division to match bit-for-bit — including the small-amount case where the fee
 * floors to 0 and netAmount === amountIn.
 */
export function computeNetAmountIn(amountIn: bigint): bigint {
  const fee = (amountIn * ORDER_FEE_BPS) / ORDER_BPS_DENOMINATOR
  return amountIn - fee
}

export interface BuildCanonicalRouteParams {
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  /** The SIGNED gross order.amountIn (wei). The builder derives netAmount itself. */
  amountIn: bigint
  /** The SIGNED order.minAmountOut (wei) — becomes amountOutMinimum verbatim. */
  minAmountOut: bigint
  /** Pool fee tier pinned at creation; committed into routerDataHash. */
  feeTier: CanonicalFeeTier
  /** SwapRouter02 for this chain (must already be whitelisted on the executor). */
  router: `0x${string}`
  /** The OrderExecutorV3 address — the swap output recipient (see module header). */
  recipient: `0x${string}`
}

export interface CanonicalRoute {
  /** The router the order struct must commit to (`order.router`). */
  router: `0x${string}`
  /** The full pinned calldata — persisted to Supabase and replayed verbatim by the keeper. */
  routerData: `0x${string}`
  /** keccak256(routerData) — goes into the SIGNED order struct as `routerDataHash`. */
  routerDataHash: `0x${string}`
  /** The net amount encoded into the calldata (amountIn − protocol fee). */
  netAmountIn: bigint
  /** Echoed back so callers can persist/display the pinned tier. */
  feeTier: CanonicalFeeTier
}

/**
 * Build the deterministic pinned route for a non-DCA v3 order.
 *
 * Fail-closed on every input the contract would otherwise revert on, so a malformed route can
 * never reach a signature prompt.
 */
export function buildCanonicalRoute(p: BuildCanonicalRouteParams): CanonicalRoute {
  if (!p.router || !isAddress(p.router)) {
    throw new Error('canonical-route: router is required and must be a valid address')
  }
  if (!p.recipient || !isAddress(p.recipient)) {
    throw new Error('canonical-route: recipient (OrderExecutorV3) is required and must be a valid address')
  }
  if (!p.tokenIn || !isAddress(p.tokenIn) || !p.tokenOut || !isAddress(p.tokenOut)) {
    throw new Error('canonical-route: tokenIn/tokenOut must be valid addresses')
  }
  if (p.tokenIn.toLowerCase() === p.tokenOut.toLowerCase()) {
    throw new Error('canonical-route: tokenIn and tokenOut cannot be the same token')
  }
  if (!CANONICAL_FEE_TIERS.includes(p.feeTier)) {
    throw new Error(
      `canonical-route: unsupported fee tier ${p.feeTier} — must be one of ${CANONICAL_FEE_TIERS.join(', ')}`,
    )
  }
  if (p.amountIn <= 0n) {
    throw new Error('canonical-route: amountIn must be > 0')
  }
  // The contract reverts InvalidMinOutput on a zero min (:443) and the floor is
  // max(oracleFloor, minAmountOut) (:532-554) — a zero here would be a blind fill.
  if (p.minAmountOut <= 0n) {
    throw new Error('canonical-route: minAmountOut must be > 0')
  }

  const netAmountIn = computeNetAmountIn(p.amountIn)
  if (netAmountIn <= 0n) {
    throw new Error('canonical-route: netAmountIn resolved to 0 — amountIn is too small to route')
  }

  const encoded = encodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, [
    {
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      fee: p.feeTier,
      recipient: p.recipient,
      amountIn: netAmountIn,
      amountOutMinimum: p.minAmountOut,
      sqrtPriceLimitX96: 0n,
    },
  ])

  const routerData = `${SWAPROUTER02_EXACT_INPUT_SINGLE_SELECTOR}${encoded.slice(2)}` as `0x${string}`

  return {
    router: p.router,
    routerData,
    routerDataHash: keccak256(routerData),
    netAmountIn,
    feeTier: p.feeTier,
  }
}

/**
 * Verify that pinned calldata still hashes to the value committed in the signed order struct.
 * Used API-side (reject a tampered/mismatched body) and keeper-side (pre-flight before spending
 * gas — the contract enforces it again at :465 regardless).
 */
export function verifyRouterDataHash(
  routerData: `0x${string}` | null | undefined,
  routerDataHash: `0x${string}` | null | undefined,
): boolean {
  if (!routerData || !routerDataHash) return false
  if (!/^0x[0-9a-fA-F]*$/.test(routerData) || routerData.length < 10) return false
  if (!/^0x[0-9a-fA-F]{64}$/.test(routerDataHash)) return false
  try {
    return keccak256(routerData).toLowerCase() === routerDataHash.toLowerCase()
  } catch {
    return false
  }
}
