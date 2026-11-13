/**
 * [feat/ui-v2-fiat-value] The EUR / USD rate reader. DISPLAY ONLY.
 *
 * One cached read of `GET /api/fiat/eur-usd` (the Chainlink feed, resolved by `@/lib/eur-usd-feed`: the active chain's row, else
 * mainnet's through the server). It is fetched only when something needs it (the visitor chose euros, or the currency switch is open),
 * at most once an hour, and shared by every consumer. It is plain HTTP to our own origin: no browser RPC, so the rpc-budget does not move.
 *
 * Fail-closed in one direction: a payload is `ok` only while its on-chain round is younger than the feed's ceiling AT THE MOMENT OF READING
 * (`isEurRateFresh`). A failed fetch, a bad body or an aged-out round is `unavailable`: dollars are shown and the euro option is disabled.
 * An old rate is never shown silently.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { setVisibleInterval } from '@/lib/visible-interval'
import { isEurRateFresh, parseEurRatePayload, resolveEurUsdFeed, type EurRatePayload } from '@/lib/eur-usd-feed'

export const EUR_RATE_UNAVAILABLE_TITLE = 'EUR rate unavailable'
const REFRESH_MS = 3_600_000
const RETRY_MS = 300_000
const TICK_MS = 60_000

type Raw = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; payload: EurRatePayload; at: number } | { phase: 'failed'; at: number }

let raw: Raw = { phase: 'idle' }
/** `raw` judged at the last change or tick. A stable object: render reads it and never the clock. */
let judged: EurRate = { status: 'loading' }
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Re-judge `raw` at `nowMs`; notify only when the answer changed (an aged-out payload flips ok → unavailable). */
export function rejudge(nowMs: number = Date.now()): void {
  const next = judgeEurRate(raw, nowMs)
  if (next.status === judged.status && (next.status !== 'ok' || (judged.status === 'ok' && judged.usdPerEur === next.usdPerEur))) return
  judged = next
  emit()
}

function set(next: Raw) {
  raw = next
  judged = judgeEurRate(raw, Date.now())
  emit()
}

/** Test-only. */
export function _resetEurRate(): void {
  raw = { phase: 'idle' }
  judged = { status: 'loading' }
  inflight = null
  emit()
}

/** Fetch unless a read is in flight or the last answer is recent enough (an hour after a success, five minutes after a failure). */
export function loadEurRate(chainId: number, nowMs: number = Date.now()): Promise<void> {
  const feed = resolveEurUsdFeed(chainId)
  if (!feed) {
    if (raw.phase !== 'failed') set({ phase: 'failed', at: nowMs })
    return Promise.resolve()
  }
  if (inflight) return inflight
  if (raw.phase === 'ready' && nowMs - raw.at < REFRESH_MS) return Promise.resolve()
  if (raw.phase === 'failed' && nowMs - raw.at < RETRY_MS) return Promise.resolve()
  if (raw.phase === 'idle') set({ phase: 'loading' })
  inflight = (async () => {
    try {
      // The feed's own chain, so the whole app shares one edge-cached answer.
      const res = await fetch(`/api/fiat/eur-usd?chainId=${feed.chainId}`)
      const payload = res.ok ? parseEurRatePayload(await res.json()) : null
      if (payload && isEurRateFresh(payload, Date.now())) set({ phase: 'ready', payload, at: Date.now() })
      else set({ phase: 'failed', at: Date.now() })
    } catch {
      set({ phase: 'failed', at: Date.now() })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export type EurRate = { status: 'loading' } | { status: 'ok'; usdPerEur: number } | { status: 'unavailable' }

/** Pure: the raw state judged at `nowMs`. */
export function judgeEurRate(r: Raw, nowMs: number): EurRate {
  if (r.phase === 'idle' || r.phase === 'loading') return { status: 'loading' }
  if (r.phase === 'failed') return { status: 'unavailable' }
  return isEurRateFresh(r.payload, nowMs) ? { status: 'ok', usdPerEur: r.payload.rate } : { status: 'unavailable' }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * @param enabled false → no fetch is started (the visitor is on dollars and nothing is asking); the answer, if another consumer
 *   already loaded it, is still returned.
 */
export function useEurRate(chainId: number, enabled: boolean): EurRate {
  const answer = useSyncExternalStore(subscribe, () => judged, () => judged)
  useEffect(() => {
    if (!enabled) return
    void loadEurRate(chainId)
    // A tick re-judges the age (a payload that aged out flips to unavailable) and is a fetch only an hour after a success or five
    // minutes after a failure (loadEurRate gates it). Paused in a hidden tab, with one tick on return.
    return setVisibleInterval(() => {
      rejudge()
      void loadEurRate(chainId)
    }, TICK_MS)
  }, [chainId, enabled])
  return answer
}
