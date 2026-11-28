// @vitest-environment jsdom
/**
 * [fix/quote-split-followups, A109 S-1/S-2] useQuote's 429 wait against the REAL /api/quote handler, with the REAL
 * limiter (30/min `quote:`) and quote cache over an in-memory KV, on a fake clock. Only the upstream fan-out is a stub.
 *
 * X-RateLimit-Reset says when ONE slot frees, not when this caller is served, so these are the cases where that
 * differs: a bucket other people keep full, and many tabs behind one address. Then the device clock: the reset is the
 * server's time, and is read against the response's own Date.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }))
vi.mock('./useChainId', () => ({ useQuoteChainId: () => 1 }))
vi.mock('./useEthGasCost', () => ({ useEthGasCost: () => ({ estimate: () => ({ eth: 0, usd: 0 }) }) }))
vi.mock('@/lib/gasless-engine', () => ({ analyzeGasless: () => ({ available: false, recommended: false }) }))
vi.mock('@/lib/analytics', () => ({ logQuoteToSupabase: vi.fn() }))
vi.mock('@/lib/chains', async () => ({ ...(await vi.importActual<object>('@/lib/chains')), isChainActive: () => true }))
vi.mock('@/lib/circuit-breaker', () => ({ isSystemHalted: vi.fn().mockResolvedValue(false) }))

const h = vi.hoisted(() => ({ reset: () => {} }))
vi.mock('@/lib/kv', async () => {
  const { createFakeKv } = await import('@/test-utils/fake-kv')
  const fake = createFakeKv()
  h.reset = () => fake.reset()
  return { kv: fake.kv, kvRaw: fake.kv }
})
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<object>('@/lib/api')),
  fetchMetaQuote: async () => {
    const quote = { source: 'velora', toAmount: '98000000', estimatedGas: 0, gasUsd: 0, routes: [] }
    return { best: quote, all: [quote], fetchedAt: Date.now() }
  },
}))

import { renderHook, act, cleanup } from '@testing-library/react'
import { NextRequest } from 'next/server'
import { parseUnits } from 'viem'
import { useQuote } from './useQuote'
import type { Token } from '@/lib/tokens'

const token = (address: string, symbol: string, decimals: number) => ({ address, symbol, name: symbol, decimals, logoURI: '', category: 'Other' }) as Token
const ETH = token('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 'ETH', 18)
const USDC = token('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6)

let GET: (req: NextRequest) => Promise<Response>
const route = (url: URL) => GET(new NextRequest(url, { headers: { 'x-real-ip': '203.0.113.77' } }))
/** Someone else on this address: one unit of `quote:`. No params, so the route charges and answers 400 (429 if full). */
const someoneElse = () => route(new URL('http://localhost/api/quote'))

/** A device clock `skewMs` fast: the server's own clock, which stamps Date and the reset, is that much behind it. */
interface ServerClock { skewMs: number; date: boolean }
let serverClock: ServerClock | null

/** One of the hook's own requests. `at` and `trueReset` are on the test's clock, which is the limiter's. */
interface Seen { at: number; amount: string; status: number; trueReset: number | null }
let seen: Seen[]

async function server(url: URL): Promise<Response> {
  const entry: Seen = { at: Date.now(), amount: url.searchParams.get('amount') ?? '', status: 0, trueReset: null }
  seen[seen.length] = entry
  const res = await route(url)
  entry.status = res.status
  const reset = res.headers.get('x-ratelimit-reset')
  const headers = new Headers(res.headers)
  if (res.status === 429) entry.trueReset = Number(reset)
  if (serverClock) {
    if (reset) headers.set('x-ratelimit-reset', String(Number(reset) - serverClock.skewMs))
    // An HTTP date has whole seconds: toUTCString drops the milliseconds, as Node's own Date header does.
    if (serverClock.date) headers.set('date', new Date(Date.now() - serverClock.skewMs).toUTCString())
  }
  return new Response(await res.text(), { status: res.status, headers })
}

const advance = async (ms: number, step = 100) => {
  for (let left = ms; left > 0; left -= step) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(step, left)) })
}
const mount = (amount: string) => renderHook(() => useQuote(ETH, USDC, amount, true))

/** Every request sent after a refusal, by the same tab, came at or after the reset that refusal stated. */
function expectNeverEarly(mine: Seen[]) {
  mine.slice(1).forEach((r, i) => {
    const before = mine[i]
    if (before.trueReset !== null) expect(r.at, `request ${i + 2} against the reset stated to request ${i + 1}`).toBeGreaterThanOrEqual(before.trueReset)
  })
}

beforeAll(async () => {
  vi.stubEnv('RATE_LIMIT_SALT', 'a109-limiter-test-salt-a109-limiter-test-salt')
  GET = (await import('@/app/api/quote/route')).GET as never
})

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  h.reset()
  ;(await import('@/lib/kv-rate-limiter'))._internal.reset()
  const cache = await import('@/lib/meta-quote-cache')
  cache._internal.localQuoteDampenerCache.clear()
  cache._internal.inFlightQuotes.clear()
  seen = []
  serverClock = null
  vi.stubGlobal('fetch', vi.fn((input: unknown) => server(new URL(String(input), 'http://localhost'))))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useQuote 429 on a shared address, real limiter', () => {
  it('one tab, bucket kept full by another consumer for 5 minutes: at most 8 refusals, none asked early', async () => {
    // one unit every 2 s, so a slot frees every 2 s and the other consumer takes it
    for (let i = 0; i < 30; i++) { await someoneElse(); await vi.advanceTimersByTimeAsync(2_000) }
    const hook = mount('0.0333')
    for (let step = 0; step < 3_000; step++) { await someoneElse(); await advance(100) }
    const refused = seen.filter((r) => r.status === 429)
    expect(refused.length, 'the tab really was crowded out').toBeGreaterThanOrEqual(3)
    expect(refused.length).toBeLessThanOrEqual(8)
    expectNeverEarly(seen)
    expect(hook.result.current.retryIn, 'still counting down to its next try').toBeGreaterThan(0)
  }, 120_000)

  // THE GOAL'S TARGET ("10 tabs behind one address: refusals per minute no higher than main's") IS NOT MET, and cannot
  // be with its rule (owner, 2026-11-28: keep the rule, pin what it does). Main in this same set-up: [10,10,0,10,10,10].
  // Minute 1 is the rule's "a first refusal follows the header": every refused tab is told the same reset.
  it('10 tabs behind one address, 6 minutes: the refusals a minute, pinned as measured', async () => {
    const hooks: ReturnType<typeof mount>[] = []
    for (let i = 0; i < 10; i++) { hooks[i] = mount(`0.03${10 + i}`); await advance(1_300) }
    const start = Date.now()
    await advance(360_000)
    const perMinute = (status: number) => Array.from({ length: 6 }, (_, m) =>
      seen.filter((r) => r.status === status && r.at - start >= m * 60_000 && r.at - start < (m + 1) * 60_000).length)
    expect(perMinute(429)).toEqual([19, 1, 9, 10, 9, 9])
    expect(perMinute(200), 'served a minute; main in this set-up: [20,30,30,20,20,20]').toEqual([21, 30, 30, 29, 30, 30])
    for (let i = 0; i < 10; i++) {
      const amount = parseUnits(`0.03${10 + i}`, 18).toString()
      const mine = seen.filter((r) => r.amount === amount)
      expect(mine.some((r) => r.status === 200), `tab ${i + 1} was served`).toBe(true)
      expectNeverEarly(mine)
    }
  }, 120_000)
})

describe('useQuote 429, a lone visitor whose window is spent, real limiter', () => {
  /** Spends the 30 slots at one instant and mounts at that instant: the longest wait the limiter can state, 60 s. */
  async function spentThenAsks(startMs: number) {
    vi.setSystemTime(1_800_000_000_000 + startMs)
    for (let i = 0; i < 30; i++) expect((await someoneElse()).status).toBe(400)
    const hook = mount('0.0333')
    await advance(1)
    expect(seen.map((r) => r.status)).toEqual([429])
    return hook
  }

  async function expectOneRetryWithin62s(hook: ReturnType<typeof mount>) {
    await advance(62_500)
    expect(seen.slice(0, 2).map((r) => r.status)).toEqual([429, 200])
    expect(seen[1].at - seen[0].at).toBeLessThanOrEqual(62_000)
    expect(seen.filter((r) => r.status === 429)).toHaveLength(1)
    expectNeverEarly(seen)
    expect(hook.result.current.error).toBeNull()
    expect(hook.result.current.meta?.best.source).toBe('velora')
  }

  it('one retry, recovered within 62 s', async () => {
    await expectOneRetryWithin62s(await spentThenAsks(0))
  })

  // `startMs` .999 is the worst case for a Date header: it drops 999 ms.
  it.each([
    ['2 s fast', 2_000],
    ['5 minutes fast', 300_000],
    ['5 minutes slow', -300_000],
  ] as [string, number][])('device clock %s, correct Date header: one retry, never early, within 62 s', async (_label, skewMs) => {
    for (const startMs of [0, 999]) {
      h.reset()
      ;(await import('@/lib/kv-rate-limiter'))._internal.reset()
      seen = []
      serverClock = { skewMs, date: true }
      const hook = await spentThenAsks(startMs + (startMs ? 120_000 : 0))
      await expectOneRetryWithin62s(hook)
      hook.unmount()
    }
  })

  it('no Date header: the device clock is the reference, as before (5 minutes slow reads 6 minutes ahead: 120 s)', async () => {
    serverClock = { skewMs: -300_000, date: false }
    const hook = await spentThenAsks(0)
    expect(hook.result.current.retryIn).toBe(120)
  })

  it('no Date header, device 5 minutes fast: the reset reads as long past, so the 30 s doubling, as before', async () => {
    serverClock = { skewMs: 300_000, date: false }
    const hook = await spentThenAsks(0)
    expect(hook.result.current.retryIn).toBe(30)
  })
})
