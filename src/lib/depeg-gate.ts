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
 *
 * [FIX-ORACLE-FAIL-CLOSED] It is FAIL-CLOSED. Previously, if either feed was stale/invalid the
 * caller passed null here and the verdict was 'ok' — the swap proceeded as though the peg had been
 * verified when in truth it had not been checked at all. A guard that cannot verify must block, not
 * pass. An unverifiable leg now yields 'unverified', which BLOCKS exactly as 'block' does but
 * carries DIFFERENT copy: a user must never be told an asset is depegged when the truth is that we
 * could not check. The 9G round-integrity + 9V per-feed staleness checks are applied to each leg
 * BEFORE this (see priceFromValidRound) and are not loosened.
 *
 * Note the distinction the hook draws and this module cannot: a token with NO exchange-rate pair is
 * NOT unverified — the depeg check simply does not apply to it (the overwhelmingly common case), and
 * that stays frictionless. Only a token that HAS a pair, whose feeds we then failed to read, is
 * unverified. See useDepegCheck.
 */
import { DEPEG_DIVERGENCE_WARN, DEPEG_DIVERGENCE_BLOCK } from './constants'

/**
 * [FIX-ORACLE-FAIL-CLOSED] 'pending' and 'unverified' are deliberately distinct states, not one
 * "no answer" bucket: in-flight is a normal first render and must stay frictionless, while
 * "we tried and failed" must block. Collapsing them is precisely the fail-open hole this fixes.
 */
export type DepegMode = 'ok' | 'consent' | 'block' | 'unverified' | 'pending'

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
 * [FIX-ORACLE-FAIL-CLOSED] The reads are still in flight — a normal first render, NOT a failure.
 * Frictionless (no message) exactly as before, so an initial render never shows a scary error.
 */
export const PENDING = (symbol: string): DepegCheck => ({ mode: 'pending', divergence: 0, symbol, message: null })

/**
 * [FIX-ORACLE-FAIL-CLOSED] We tried to verify the peg and could not — read error, revert, a missing
 * feed on a registered pair, failed round integrity, or data past the per-feed staleness ceiling.
 * BLOCKS like 'block', but says "we couldn't check", never "the asset is depegged".
 */
export const UNVERIFIED = (symbol: string): DepegCheck => ({
  mode: 'unverified',
  divergence: 0,
  symbol,
  message: symbol
    ? `We couldn't verify ${symbol}'s price right now — try again in a moment.`
    : `We couldn't verify this price right now — try again in a moment.`,
})

/**
 * [FIX-DEPEG-RETRY-WINDOW / M-01] The subset of a TanStack/wagmi read result this gate needs in
 * order to decide whether a read has ever failed. Structural, so it accepts a `useReadContract`
 * result directly without importing wagmi into this pure module.
 */
export interface ReadFailureSignals {
  /** Attempts failed within the CURRENT fetch. Reset to 0 on every new fetch. */
  failureCount?: number | undefined
  /** Times this query has committed an error. Monotonic for the life of the cache entry. */
  errorUpdateCount?: number | undefined
}

/**
 * [FIX-DEPEG-RETRY-WINDOW / M-01] Has this read failed at least once? Used to decide whether an
 * in-flight state may present as PENDING (frictionless) or must present as UNVERIFIED (blocking).
 *
 * BOTH counters are required, and this is the whole substance of the M-01 fix:
 *
 *  - `failureCount` (query-core's `fetchFailureCount`) rises across a retry sequence, but
 *    `fetchState()` resets it to 0 on EVERY new fetch (`query.js:346-356`). It is the only failure
 *    signal during the FIRST retry sequence, before any error has been committed to query state —
 *    and it is useless one poll later.
 *  - `errorUpdateCount` is incremented ONLY by the 'error' action (`query.js:318`) and appears
 *    nowhere in `fetchState`. The library never resets it for the life of the cache entry, so it is
 *    the memory that SURVIVES the 30s `refetchInterval` poll.
 *
 * Relying on `failureCount` alone was the M-01 defect: for a query that has never succeeded
 * (`data === undefined`), each poll's 'fetch' action resets `fetchFailureCount` to 0 AND rewinds
 * `status` to 'pending', so the hook briefly saw `isLoading: true, failureCount: 0, isError: false`
 * — indistinguishable from a first render — and re-opened the gate for ~0.3-1.3s every 30s, during
 * exactly the outage the gate exists to catch.
 */
export function hasReadFailed(read: ReadFailureSignals): boolean {
  return (read.failureCount ?? 0) > 0 || (read.errorUpdateCount ?? 0) > 0
}

/**
 * Pure depeg verdict from a token's MARKET price vs its EXCHANGE RATE (both already integrity +
 * staleness validated by the caller, and both in the SAME unit — each normalised by its own feed
 * decimals before being passed in).
 *
 * [FIX-ORACLE-FAIL-CLOSED] Fail-CLOSED: a null/non-positive leg means the peg could not be checked,
 * so the verdict is 'unverified' (blocking) rather than the old 'ok' (silently passing). Callers
 * must not route an in-flight read through here — pass PENDING instead (see useDepegCheck).
 */
export function evaluateDepeg(
  marketPrice: number | null,
  exchangeRate: number | null,
  symbol: string,
): DepegCheck {
  // Fail-CLOSED: either leg missing/invalid → we could not verify the peg → block, do not pass.
  if (marketPrice == null || exchangeRate == null || marketPrice <= 0 || exchangeRate <= 0) {
    return UNVERIFIED(symbol)
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
