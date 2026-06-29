/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] Approximate USD valuation, shared with the analytics route (#228).
 *
 * Single source of truth for the approximate price table so the DCA dashboard's per-fill USD and the
 * analytics dashboard's volume agree. `fillUsd` returns null when the token has no known price so the
 * UI can render "—" instead of a fabricated "$0" (the "do not fabricate USD" rule).
 */

import { formatUnits } from 'viem'

// Approximate USD prices for valuation when no on-chain/stored USD exists. Mirrors the values the
// analytics route uses for DCA/limit/stop-loss fills. Keyed by UPPERCASE symbol.
// Keys are UPPERCASE to match the toUpperCase() lookup below — mixed-case literals (stETH, cbETH, …)
// would be dead keys that never resolve, silently dropping their USD to "—".
export const APPROX_PRICES: Record<string, number> = {
  ETH: 3500, WETH: 3500, STETH: 3500, WSTETH: 4000, CBETH: 3600, RETH: 3800,
  USDC: 1, USDT: 1, DAI: 1, FRAX: 1, LUSD: 1, SUSD: 1, CRVUSD: 1, GHO: 1, PYUSD: 1,
  WBTC: 95000, RENBTC: 95000, TBTC: 95000,
  UNI: 12, LINK: 18, AAVE: 200, MKR: 1500, CRV: 0.5, LDO: 2,
}

/**
 * USD value of a raw (smallest-unit) token amount using the real decimals + the approximate price.
 * Returns null when the amount is unparseable OR the symbol has no known price — callers render "—".
 */
export function fillUsd(
  rawAmount: string | null | undefined,
  decimals: number,
  symbol: string | null | undefined,
): number | null {
  if (rawAmount == null || rawAmount === '') return null
  const price = APPROX_PRICES[(symbol ?? '').toUpperCase()]
  if (price == null) return null
  try {
    const human = Number(formatUnits(BigInt(String(rawAmount).split('.')[0]), decimals))
    if (!Number.isFinite(human)) return null
    return human * price
  } catch {
    return null
  }
}
