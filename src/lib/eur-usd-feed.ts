/**
 * [feat/ui-v2-fiat-value] The Chainlink EUR / USD feed used to show euro amounts. DISPLAY ONLY: a euro figure feeds no gate,
 * minimum output, tier, consent, calldata or signature, and nothing under those paths may import this module (pinned by
 * `fiat-scope-guard.test.ts` in the fiat folder of the v2 tree).
 *
 * The address comes from `src/config/eur-usd-feed.json`, which `scripts/fiat/build-eur-usd-feed.mjs` generates from Chainlink's
 * reference-data directory and confirms on-chain; it is never typed here. The shared feed registry (`chains/chainlink-feeds.ts`)
 * is keyed by TOKEN address and holds no fiat/fiat pair on any chain, so this is a separate, chain-keyed table with the same
 * columns (heartbeat, maxStaleness) as `dca-feed-registrations.json`.
 *
 * Pure and client-safe (no viem client, no server imports): the route reads the chain, the browser only re-checks freshness.
 */
import config from '@/config/eur-usd-feed.json'
import { DEFAULT_CHAIN_ID } from '@/lib/chains/registry'

export interface EurUsdFeed {
  /** The chain the feed lives on (the active chain's row, else mainnet's). */
  chainId: number
  feed: `0x${string}`
  description: string
  decimals: number
  heartbeat: number
  /** Seconds. Older than this and the rate is stale: the euro option is disabled, dollars are shown. */
  maxStaleness: number
}

interface Row {
  feed: string
  description: string
  decimals: number
  heartbeat: number
  maxStaleness: number
}

const ROWS = config.chains as Record<string, Row | undefined>

function rowFor(chainId: number): EurUsdFeed | null {
  const r = ROWS[String(chainId)]
  return r ? { chainId, feed: r.feed as `0x${string}`, description: r.description, decimals: r.decimals, heartbeat: r.heartbeat, maxStaleness: r.maxStaleness } : null
}

/**
 * The feed for the ACTIVE chain when the table has one; where the chain has none, the mainnet feed (the caller reads it through the
 * server). `null` only when neither exists, which the caller shows as "EUR rate unavailable".
 */
export function resolveEurUsdFeed(chainId: number): EurUsdFeed | null {
  return rowFor(chainId) ?? rowFor(DEFAULT_CHAIN_ID)
}

/** The body of `GET /api/fiat/eur-usd`. */
export interface EurRatePayload {
  /** USD per 1 EUR, e.g. 1.0849. */
  rate: number
  /** Unix seconds of the on-chain round. */
  updatedAt: number
  /** Seconds; the server's own ceiling for this feed, echoed so the browser re-checks against the same number. */
  maxStaleness: number
}

/** The shape check for a response body: anything else is "unavailable", never a guess. */
export function parseEurRatePayload(x: unknown): EurRatePayload | null {
  if (typeof x !== 'object' || x === null) return null
  const { rate, updatedAt, maxStaleness } = x as Record<string, unknown>
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return null
  if (typeof maxStaleness !== 'number' || !Number.isFinite(maxStaleness) || maxStaleness <= 0) return null
  return { rate, updatedAt, maxStaleness }
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** The FX market closes Friday 22:00 UTC and reopens Sunday 22:00 UTC; the grace runs to Monday 01:00 UTC (51 h after the close). [owner decision] */
const FX_CLOSED_WINDOW_MS = 51 * HOUR_MS

/** The most recent Friday 22:00 UTC at or before `nowMs`. */
export function lastFxCloseMs(nowMs: number): number {
  const d = new Date(nowMs)
  const today2200 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22)
  const daysSinceFriday = (d.getUTCDay() - 5 + 7) % 7
  const close = today2200 - daysSinceFriday * DAY_MS
  return close > nowMs ? close - 7 * DAY_MS : close
}

/** True from Friday 22:00 UTC until Monday 01:00 UTC: the market is closed (or has only just reopened) and no new round is expected. */
export function isFxClosedWindow(nowMs: number): boolean {
  return nowMs - lastFxCloseMs(nowMs) < FX_CLOSED_WINDOW_MS
}

/**
 * Fresh = usable for display AT THE MOMENT OF READING (a cached payload ages out).
 *  - Any time: a round no older than the feed's ceiling (`maxStaleness`, the 25 h = heartbeat + 1 h of a weekday).
 *  - While the FX market is closed (Friday 22:00 UTC to Sunday 22:00 UTC, with grace until Monday 01:00 UTC): also the last round published
 *    before the close, provided it was itself within the ceiling AT the close. A feed that was already stale when the market closed stays stale.
 *  - Outside that window an older round is stale: dollars are shown and the euro option is disabled. A round from the future (beyond a
 *    minute of clock skew) is never trusted.
 */
export function isEurRateFresh(p: EurRatePayload, nowMs: number): boolean {
  const ageSec = nowMs / 1000 - p.updatedAt
  if (ageSec < -60) return false
  if (ageSec <= p.maxStaleness) return true
  if (!isFxClosedWindow(nowMs)) return false
  return p.updatedAt * 1000 >= lastFxCloseMs(nowMs) - p.maxStaleness * 1000
}
