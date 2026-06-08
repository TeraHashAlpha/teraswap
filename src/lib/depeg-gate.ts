/**
 * [SPRINT-9W-oracle] cbETH depeg / manipulation circuit-breaker — a SECOND, independent safety
 * verdict alongside the 9J price-impact gate.
 *
 * For an asset with BOTH a market price feed and an exchange-rate (redemption) feed (see
 * getExchangeRatePair), compute the divergence between them:
 *     divergence = |market − exchangeRate| / exchangeRate
 * The exchange-rate feed is slow (24h) and manipulation-resistant; the market feed is what cbETH
 * actually trades at. In normal conditions they agree to within ≪1%. A large gap means a depeg, a
 * pool attack, or a MANIPULATED market feed (which the manipulation-resistant ER catches even
 * though the market feed is the swap-price reference). This is informed-consent at WARN and a hard
 * block at BLOCK, mirroring the 9J band shape.
 *
 * IMPORTANT (rule #9): this does NOT change the swap-price reference (still the market feed, 9V).
 * It is fail-open: if EITHER feed is stale/invalid the caller passes null here and the verdict is
 * 'ok' (a feed outage is NOT a depeg — fall back to the existing no-oracle calm warning +
 * multi-source path; do not hard-block). The 9G round-integrity + 9V per-feed staleness checks are
 * applied to each leg BEFORE this (see priceFromValidRound) and are not loosened.
 */
import { DEPEG_DIVERGENCE_WARN, DEPEG_DIVERGENCE_BLOCK } from './constants'

export type DepegMode = 'ok' | 'consent' | 'block'

export interface DepegCheck {
  mode: DepegMode
  /** |market − ER| / ER, e.g. 0.05 = 5%. 0 when there is no verdict (no pair / a feed unavailable). */
  divergence: number
  /** Asset symbol for the warning copy, e.g. "cbETH". Empty when there is no pair. */
  symbol: string
  message: string | null
}

const OK = (symbol: string, divergence = 0): DepegCheck => ({ mode: 'ok', divergence, symbol, message: null })

/**
 * Pure depeg verdict from a token's MARKET price vs its EXCHANGE RATE (both already integrity +
 * staleness validated by the caller, and both in the SAME unit — each normalised by its own feed
 * decimals before being passed in). Fail-open: a null/non-positive input → 'ok' (no verdict), so a
 * feed outage never produces a false depeg block.
 */
export function evaluateDepeg(
  marketPrice: number | null,
  exchangeRate: number | null,
  symbol: string,
): DepegCheck {
  // Fail-open: either leg missing/invalid → no divergence verdict (feed outage ≠ depeg).
  if (marketPrice == null || exchangeRate == null || marketPrice <= 0 || exchangeRate <= 0) {
    return OK(symbol)
  }

  const divergence = Math.abs(marketPrice - exchangeRate) / exchangeRate
  const pct = (divergence * 100).toFixed(1)

  if (divergence >= DEPEG_DIVERGENCE_BLOCK) {
    return {
      mode: 'block',
      divergence,
      symbol,
      message: `${symbol} is trading ${pct}% off its exchange rate — likely a depeg or oracle manipulation. Swap blocked for your safety.`,
    }
  }

  if (divergence >= DEPEG_DIVERGENCE_WARN) {
    return {
      mode: 'consent',
      divergence,
      symbol,
      message: `${symbol} is trading ${pct}% off its exchange rate — possible depeg. Verify before swapping.`,
    }
  }

  return OK(symbol, divergence)
}

/**
 * [SPRINT-9W-oracle] Validate a Chainlink UI round and return the decimal-normalised price, or null
 * if it fails any gate. Mirrors the server `validateRoundData` (9G) + `useChainlinkPrice` staleness
 * (9V) exactly — answer>0, complete round, started, and age within the PER-FEED staleness ceiling —
 * so the depeg legs use the same integrity bar as every other oracle read. Decimals are applied
 * here (per-leg), so callers can compare prices from feeds with different decimals safely.
 */
export function priceFromValidRound(
  round: readonly [bigint, bigint, bigint, bigint, bigint] | undefined,
  decimals: number | undefined,
  stalenessSec: number,
  nowSec: number,
): number | null {
  if (!round || decimals == null) return null
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = round
  if (answer <= 0n) return null               // 9G: positive answer
  if (answeredInRound < roundId) return null  // 9G: complete (non-stale) round
  if (startedAt <= 0n) return null            // 9G: round actually started
  if (nowSec - Number(updatedAt) > stalenessSec) return null // 9V: per-feed staleness
  return Number(answer) / 10 ** decimals
}
