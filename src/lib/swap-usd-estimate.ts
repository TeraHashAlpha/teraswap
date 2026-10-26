/**
 * [CHORE-ORACLE-VALUE-FAILCLOSED / TM-P2] Client-side trade-value estimate for the
 * unverified-swap gate (SwapBox), extracted pure for direct unit testing (same pattern
 * as mev-preference.ts).
 *
 * Value = max(inputUsd, outputUsd), where each side prices via (in order):
 *   1. chain-keyed USD-stable membership (≈$1 — lib/chains/stablecoins canon),
 *   2. the side's Chainlink price when the hook has one,
 *   3. [feat/swap-price-tiers D2] the SERVER's reference price for that leg (GET
 *      /api/swap-price-tier — the ADR-024 quorum: a `priced` or `single-source` leg),
 *      so the value thresholds apply from the priced value even without Chainlink,
 *   4. the conservative ETH/WETH ≈ $2k fallback (unchanged INT-01 heuristic —
 *      deliberately LOW so it under- rather than over-estimates only mildly; the gate
 *      compares against fixed $1k/$10k thresholds).
 *
 * The old estimate priced the INPUT side only, so an unpriceable input yielded $0 and
 * the >$10k oracle block silently never fired (threat model PR #277, P2 MED — the
 * aToken-incident bypass). `priced: false` means NEITHER side is priceable: the caller
 * must never read it as "$0". Since feat/swap-price-tiers (owner D3, 2026-10-26) that
 * case is no longer a client block: the server's tier drives informed CONSENT and
 * /api/swap's 409 `unpriced_ack_required` is the binding control; this mirror is UX.
 */

import { isNativeETH, type Token } from '@/lib/tokens'
import { isUsdStablecoin } from '@/lib/chains/stablecoins'

/** Conservative ETH fallback used since INT-01 while the Chainlink price loads. */
const ETH_FALLBACK_USD = 2_000

export interface SwapUsdEstimate {
  /** max(inputUsd, outputUsd); 0 when nothing prices — check `priced`, never trust 0. */
  usd: number
  /** false = NEITHER side priceable → no value-based limit can apply (the server decides: consent). */
  priced: boolean
}

function sideUsd(
  token: Token | null,
  amount: number | null,
  chainlinkPrice: number | null,
  referencePrice: number | null | undefined,
  chainId: number,
): number | null {
  if (!token || amount == null || !Number.isFinite(amount) || amount <= 0) return null
  if (isUsdStablecoin(token.symbol, chainId)) return amount
  if (chainlinkPrice != null) return amount * chainlinkPrice
  // [feat/swap-price-tiers D2] Before the ETH constant: a real quorum price for WETH beats the
  // deliberately-low fallback, and an exotic leg gets its first client-side USD value at all.
  if (referencePrice != null && Number.isFinite(referencePrice) && referencePrice > 0) return amount * referencePrice
  if (isNativeETH(token) || token.symbol === 'WETH') return amount * ETH_FALLBACK_USD
  return null
}

export function estimateSwapUsd(args: {
  tokenIn: Token | null
  tokenOut: Token | null
  /** Human-readable input amount (already de-scaled). */
  amountIn: number
  /** Human-readable quoted output amount; null when there is no quote yet. */
  amountOut: number | null
  chainlinkPriceIn: number | null
  chainlinkPriceOut: number | null
  /** [feat/swap-price-tiers D2] The server tier's per-leg USD reference (priced / single-source leg), if any. */
  referencePriceIn?: number | null
  referencePriceOut?: number | null
  chainId: number
}): SwapUsdEstimate {
  const { tokenIn, tokenOut, amountIn, amountOut, chainlinkPriceIn, chainlinkPriceOut, referencePriceIn, referencePriceOut, chainId } = args
  if (!Number.isFinite(amountIn) || amountIn <= 0) return { usd: 0, priced: false }

  const inUsd = sideUsd(tokenIn, amountIn, chainlinkPriceIn, referencePriceIn, chainId)
  const outUsd = sideUsd(tokenOut, amountOut, chainlinkPriceOut, referencePriceOut, chainId)
  if (inUsd == null && outUsd == null) return { usd: 0, priced: false }

  return { usd: Math.max(inUsd ?? 0, outUsd ?? 0), priced: true }
}
