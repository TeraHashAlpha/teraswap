/**
 * [feat/ui-v2-fiat-value] Approximate USD prices for the fiat lines. DISPLAY ONLY.
 *
 * The SAME source the Portfolio uses (`usePortfolio.ts` `fetchPricesBatched`): `GET /api/portfolio/prices?tokens=…&chainId=…`, which is
 * DefiLlama behind our server (the visitor's IP never reaches it) with the route's own 60 s edge cache. This store adds no provider
 * and no RPC: it only asks that route, for the tokens currently on screen, and shares the answer between every line on the card.
 *
 *  - Requests made in the same tick are merged into one call per chain (Sell, Receive and the fee line are three consumers, one request).
 *  - Refreshed every 60 s, like the Portfolio, and paused in a hidden tab (`setVisibleInterval`).
 *  - A token the route does not price, a failed call, or a price older than ten minutes is `null`: the line renders nothing.
 *
 * The price is an estimate (a third-party aggregate, not the Chainlink figure the swap is gated on). It must never reach a gate, a
 * minimum output, a tier, a consent, calldata or a signature; `fiat-scope-guard.test.ts` fails if any such path imports this module.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { setVisibleInterval } from '@/lib/visible-interval'

const REFRESH_MS = 60_000
const MAX_AGE_MS = 600_000
const BATCH = 100 // the route's own cap per call

interface Entry {
  /** null = looked up and not priced. */
  price: number | null
  /** When the price was last confirmed. */
  at: number
}

const entries = new Map<string, Entry>()
/** key → consumers currently showing it. */
const wanted = new Map<string, number>()
/** key → last attempt (success or failure), for the 60 s gate between calls. */
const tried = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0
let stopTimer: (() => void) | null = null
let scheduled = false
let pending = 0

const keyOf = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`
const emit = () => {
  version++
  listeners.forEach((l) => l())
}

/** Test-only. */
export function _resetApproxPrices(): void {
  entries.clear()
  wanted.clear()
  tried.clear()
  stopTimer?.()
  stopTimer = null
  scheduled = false
  pending = 0
  emit()
}

/** Drop prices that were not confirmed for ten minutes (a failing route must not leave an old figure on screen), so render never reads the clock. */
function expire(nowMs: number): void {
  let dropped = false
  for (const [k, e] of entries) {
    if (nowMs - e.at > MAX_AGE_MS) {
      entries.delete(k)
      dropped = true
    }
  }
  if (dropped) emit()
}

async function refresh(nowMs: number): Promise<void> {
  expire(nowMs)
  const byChain = new Map<number, string[]>()
  for (const key of wanted.keys()) {
    const last = tried.get(key)
    if (last !== undefined && nowMs - last < REFRESH_MS - 1_000) continue // a second of timer jitter must not skip a whole tick
    const [chain, addr] = key.split(':')
    const list = byChain.get(Number(chain)) ?? []
    list.push(addr)
    byChain.set(Number(chain), list)
  }
  for (const [chainId, addrs] of byChain) {
    for (let i = 0; i < addrs.length; i += BATCH) {
      const batch = addrs.slice(i, i + BATCH)
      for (const a of batch) tried.set(keyOf(chainId, a), nowMs)
      pending++
      try {
        const res = await fetch(`/api/portfolio/prices?tokens=${encodeURIComponent(batch.join(','))}&chainId=${chainId}`)
        if (!res.ok) continue
        const data = (await res.json()) as { prices?: Record<string, number> }
        for (const a of batch) {
          const p = data.prices?.[a]
          entries.set(keyOf(chainId, a), { price: typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null, at: Date.now() })
        }
        emit()
      } catch {
        /* keep what we have; the next tick retries */
      } finally {
        pending--
      }
    }
  }
}

function schedule() {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    void refresh(Date.now())
  })
}

function want(key: string): () => void {
  wanted.set(key, (wanted.get(key) ?? 0) + 1)
  if (!stopTimer) stopTimer = setVisibleInterval(() => void refresh(Date.now()), REFRESH_MS)
  schedule()
  return () => {
    const n = (wanted.get(key) ?? 1) - 1
    if (n <= 0) wanted.delete(key)
    else wanted.set(key, n)
    if (wanted.size === 0 && stopTimer) {
      stopTimer()
      stopTimer = null
    }
  }
}

/** The number of price calls in flight (tests). */
export function _pendingPriceCalls(): number {
  return pending
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * The approximate USD price of one token on a chain, or null (no token, no price, or too old). Registers interest so the store fetches
 * it; the token address is passed exactly as the Portfolio passes it (the native token's sentinel address included).
 */
export function useApproxUsdPrice(chainId: number, address: string | undefined): number | null {
  const key = address ? keyOf(chainId, address) : null
  useEffect(() => (key ? want(key) : undefined), [key])
  useSyncExternalStore(subscribe, () => version, () => 0)
  if (!key) return null
  return entries.get(key)?.price ?? null
}
