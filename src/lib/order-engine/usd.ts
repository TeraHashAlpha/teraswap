/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] Approximate USD valuation, shared with the analytics route (#228).
 *
 * Single source of truth for the approximate price table so the DCA dashboard's per-fill USD and the
 * analytics dashboard's volume agree. `fillUsd` returns null when the token has no known price so the
 * UI can render "—" instead of a fabricated "$0" (the "do not fabricate USD" rule).
 *
 * ── SCOPE POLICY [FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE / INC-2026-08-07-001 follow-up 1] ───────
 * DISPLAY AND ANALYTICS ONLY. This table may label a number for a human. It may NOT:
 *   - price anything a user SIGNS  (closed by #408 — the parameters were removed from
 *     `DeriveSigningMinParams`, so it is a compile error, not a convention), or
 *   - price anything that GATES    (closed here — the DCA min-chunk dust guard and the per-buy
 *     floor copy now read the live Chainlink → DefiLlama price the signing floor itself rests on).
 *
 * These are ROUNDED, HAND-EDITED CONSTANTS, not quotes, and they go stale silently and badly: at
 * the time of the incident this table said `ETH: 3500` while the Base ETH/USD feed read 1911.90
 * (~83% high) and `CBETH: 3600` against a real ~2204. A wrong label costs a wrong label. A wrong
 * gate lets through what it exists to stop, and a wrong signature is unfillable forever — order
 * ef85438b reverted 516 times. That asymmetry is the entire reason for this boundary.
 *
 * Render every value from here as approximate ("~$…" / "≈"), never as a price. Enforced by
 * `usd-scope-guard.test.ts`, which fails if a gating or signing module imports this table.
 */

import { formatUnits } from 'viem'

// Approximate USD prices for valuation when no on-chain/stored USD exists. Mirrors the values the
// analytics route uses for DCA/limit/stop-loss fills. Keyed by UPPERCASE symbol.
// Keys are UPPERCASE to match the toUpperCase() lookup below — mixed-case literals (stETH, cbETH, …)
// would be dead keys that never resolve, silently dropping their USD to "—".
// [FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE] The values are deliberately NOT refreshed here. Editing
// 3500 to today's number would fix the reading and leave the defect — a hand-maintained constant is
// stale again by the next edit. The fix is the scope boundary above; the table's only remaining job
// is an order-of-magnitude label on historical fills.
export const APPROX_PRICES: Record<string, number> = {
  ETH: 3500, WETH: 3500, STETH: 3500, WSTETH: 4000, CBETH: 3600, RETH: 3800,
  USDC: 1, USDT: 1, DAI: 1, FRAX: 1, LUSD: 1, SUSD: 1, CRVUSD: 1, GHO: 1, PYUSD: 1,
  WBTC: 95000, RENBTC: 95000, TBTC: 95000,
  UNI: 12, LINK: 18, AAVE: 200, MKR: 1500, CRV: 0.5, LDO: 2,
}

/**
 * USD value of a raw (smallest-unit) token amount using the real decimals + the approximate price.
 * Returns null when the amount is unparseable OR the symbol has no known price — callers render "—".
 *
 * [FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE] APPROXIMATE — display/analytics only. Never a gate input
 * and never a signing input; see the module header for why the distinction is load-bearing.
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
