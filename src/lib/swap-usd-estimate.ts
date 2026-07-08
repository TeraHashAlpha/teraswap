/**
 * [CHORE-ORACLE-VALUE-FAILCLOSED / TM-P2] Client-side trade-value estimate for the
 * unverified-swap gate (SwapBox), extracted pure for direct unit testing (same pattern
 * as mev-preference.ts).
 *
 * Value = max(inputUsd, outputUsd), where each side prices via (in order):
 *   1. chain-keyed USD-stable membership (≈$1 — lib/chains/stablecoins canon),
 *   2. the side's Chainlink price when the hook has one,
 *   3. the conservative ETH/WETH ≈ $2k fallback (unchanged INT-01 heuristic —
 *      deliberately LOW so it under- rather than over-estimates only mildly; the gate
 *      compares against fixed $1k/$10k thresholds).
 *
 * The old estimate priced the INPUT side only, so an unpriceable input yielded $0 and
 * the >$10k oracle block silently never fired (threat model PR #277, P2 MED — the
 * aToken-incident bypass). `priced: false` means NEITHER side is priceable: the caller
 * must treat that as HIGH-RISK (block), never as "$0". The server /api/swap gate is the
 * binding control; this mirror is UX.
 */

import { isNativeETH, type Token } from '@/lib/tokens'
import { isUsdStablecoin } from '@/lib/chains/stablecoins'

/** Conservative ETH fallback used since INT-01 while the Chainlink price loads. */
const ETH_FALLBACK_USD = 2_000

export interface SwapUsdEstimate {
  /** max(inputUsd, outputUsd); 0 when nothing prices — check `priced`, never trust 0. */
  usd: number
  /** false = NEITHER side priceable → high-risk, the gate must fire. */
  priced: boolean
}

function sideUsd(
  token: Token | null,
  amount: number | null,
  chainlinkPrice: number | null,
  chainId: number,
): number | null {
  if (!token || amount == null || !Number.isFinite(amount) || amount <= 0) return null
  if (isUsdStablecoin(token.symbol, chainId)) return amount
  if (chainlinkPrice != null) return amount * chainlinkPrice
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
  chainId: number
}): SwapUsdEstimate {
  const { tokenIn, tokenOut, amountIn, amountOut, chainlinkPriceIn, chainlinkPriceOut, chainId } = args
  if (!Number.isFinite(amountIn) || amountIn <= 0) return { usd: 0, priced: false }

  const inUsd = sideUsd(tokenIn, amountIn, chainlinkPriceIn, chainId)
  const outUsd = sideUsd(tokenOut, amountOut, chainlinkPriceOut, chainId)
  if (inUsd == null && outUsd == null) return { usd: 0, priced: false }

  return { usd: Math.max(inUsd ?? 0, outUsd ?? 0), priced: true }
}
