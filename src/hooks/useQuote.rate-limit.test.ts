// @vitest-environment jsdom
/**
 * [fix/quote-rate-limit-normal-use] useQuote and the 429.
 *
 * Owner, production: after two token changes "Rate limit exceeded" appeared and stayed until the Swap tab was left. The
 * backoff (up to 120 s) and its error outlived the pair they belonged to. A change of pair, amount or chain now clears
 * both and fetches at once; while limited the hook says how long the wait is, and the retry happens by itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ chainId: 1 }))
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }))
vi.mock('./useChainId', () => ({ useQuoteChainId: () => h.chainId }))
vi.mock('./useEthGasCost', () => ({ useEthGasCost: () => ({ estimate: () => ({ eth: 0, usd: 0 }) }) }))
vi.mock('@/lib/gasless-engine', () => ({ analyzeGasless: () => ({ available: false, recommended: false }) }))
vi.mock('@/lib/analytics', () => ({ logQuoteToSupabase: vi.fn() }))
vi.mock('@/lib/chains', async () => ({ ...(await vi.importActual<object>('@/lib/chains')), isChainActive: () => true }))

import { renderHook, act, cleanup } from '@testing-library/react'
import { useQuote } from './useQuote'
import type { Token } from '@/lib/tokens'

const token = (address: string, symbol: string, decimals: number) => ({ address, symbol, name: symbol, decimals, logoURI: '', category: 'Other' }) as Token
const WETH = token('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 18)
const USDC = token('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6)
const USDT = token('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 6)

/** The answer /api/quote gives for the request in `url` (it echoes what it answers). */
function ok(url: URL, extra: Record<string, unknown> = {}) {
  const q = url.searchParams
  const quote = { source: 'velora', toAmount: '2950000000', estimatedGas: 0, gasUsd: 0, routes: [] }
  return new Response(
    JSON.stringify({
      best: quote, all: [quote], fetchedAt: Date.now(),
      tokenIn: q.get('src'), tokenOut: q.get('dst'), chainId: Number(q.get('chainId') ?? 1),
      decimalsIn: Number(q.get('srcDecimals')), decimalsOut: Number(q.get('dstDecimals')), amountIn: q.get('amount'),
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
const limited = () =>
  new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }), { status: 429, headers: { 'content-type': 'application/json' } })
const never = () => new Promise<Response>(() => {})

type Answer = (url: URL) => Response | Promise<Response>
let answer: Answer
let requests: { url: URL; at: number }[]

interface Props { tin: Token; tout: Token; amount: string }
const mount = (initial: Props = { tin: WETH, tout: USDC, amount: '1' }) =>
  renderHook((p: Props) => useQuote(p.tin, p.tout, p.amount, true), { initialProps: initial })

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
  h.chainId = 1
  requests = []
  answer = ok
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push({ url, at: Date.now() })
    return Promise.resolve(answer(url))
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A hook that has just been refused for WETH→USDC; whatever is asked next never answers. */
async function limitedHook() {
  answer = limited
  const hook = mount()
  await advance(1)
  expect(hook.result.current.error).toMatch(/rate limit/i)
  answer = never
  return hook
}

describe('useQuote: a new selection clears the 429', () => {
  it('a token change clears the error and the backoff and fetches at once', async () => {
    const { result, rerender } = await limitedHook()
    rerender({ tin: WETH, tout: USDT, amount: '1' })
    await advance(0)
    expect(result.current.error).toBeNull()
    expect(result.current.retryIn).toBeNull()
    expect(requests).toHaveLength(2)
    expect(requests[1].url.searchParams.get('dst')).toBe(USDT.address)
    expect(requests[1].at).toBe(requests[0].at + 1)
  })

  it('an amount change does the same as soon as the amount settles', async () => {
    const { result, rerender } = await limitedHook()
    rerender({ tin: WETH, tout: USDC, amount: '2' })
    await advance(500)
    expect(result.current.error).toBeNull()
    expect(result.current.retryIn).toBeNull()
    expect(requests).toHaveLength(2)
    expect(requests[1].url.searchParams.get('amount')).toBe('2000000000000000000')
  })

  it('a chain change does the same', async () => {
    const { result, rerender } = await limitedHook()
    h.chainId = 8453
    rerender({ tin: WETH, tout: USDC, amount: '1' })
    await advance(0)
    expect(result.current.error).toBeNull()
    expect(result.current.retryIn).toBeNull()
    expect(requests).toHaveLength(2)
    expect(requests[1].url.searchParams.get('chainId')).toBe('8453')
  })

  it('after a cleared backoff the next 429 waits 30 s again, not the old pair\'s longer wait', async () => {
    answer = limited
    const { result, rerender } = mount()
    await advance(1)
    await advance(30_000) // second 429: this pair now waits 60 s
    expect(requests).toHaveLength(2)
    rerender({ tin: WETH, tout: USDT, amount: '1' }) // refused too
    await advance(0)
    expect(requests).toHaveLength(3)
    expect(result.current.retryIn).toBe(30)
    await advance(29_000)
    expect(requests).toHaveLength(3)
    await advance(1_000)
    expect(requests).toHaveLength(4)
  })

  it('while limited it counts the wait down, retries by itself and clears', async () => {
    answer = limited
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(30)
    await advance(10_000)
    expect(result.current.retryIn).toBe(20)
    expect(requests).toHaveLength(1)
    answer = ok
    await advance(20_000)
    expect(requests).toHaveLength(2)
    expect(result.current.error).toBeNull()
    expect(result.current.retryIn).toBeNull()
    expect(result.current.meta?.best.source).toBe('velora')
  })

  it('a 429 that lands for a request the user has already left changes nothing', async () => {
    let refuseFirst: (r: Response) => void = () => {}
    answer = () => new Promise<Response>((resolve) => { refuseFirst = resolve })
    const { result, rerender } = mount()
    await advance(1)
    const stale = refuseFirst
    answer = ok
    rerender({ tin: WETH, tout: USDT, amount: '1' })
    await advance(1)
    await act(async () => { stale(limited()) })
    await advance(0)
    expect(result.current.error).toBeNull()
    expect(result.current.meta).not.toBeNull()
    await advance(15_000)
    expect(requests).toHaveLength(3) // still the normal 15 s cadence
  })
})

describe('useQuote: the 429 wait follows the server', () => {
  /** A refusal that says when the window frees, as /api/quote does (epoch ms). */
  const limitedWith = (reset: string) =>
    new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'X-RateLimit-Reset': reset },
    })
  /** A server whose window frees at `freesAt`: it refuses until then, and says so each time. */
  const windowUntil = (freesAt: number): Answer => (url) => (Date.now() < freesAt ? limitedWith(String(freesAt)) : ok(url))

  it('a 60 s window recovers at about 60 s with one retry, and the countdown shows that wait', async () => {
    answer = windowUntil(Date.now() + 60_000)
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(61) // the 60 s the server gave, plus the 1 s margin
    await advance(10_000)
    expect(result.current.retryIn).toBe(51)
    await advance(50_500)
    expect(requests).toHaveLength(1)
    await advance(500)
    expect(requests).toHaveLength(2)
    expect(requests[1].at - requests[0].at).toBeLessThanOrEqual(61_000)
    expect(result.current.error).toBeNull()
    expect(result.current.retryIn).toBeNull()
    expect(result.current.meta).not.toBeNull()
    await advance(15_000)
    expect(requests).toHaveLength(3) // back on the normal cadence
  })

  it('a window that freed while the refusal was on its way is retried after the margin alone', async () => {
    let n = 0
    answer = (url) => (++n === 1 ? limitedWith(String(Date.now() - 200)) : ok(url))
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(1)
    await advance(1_000)
    expect(requests).toHaveLength(2)
    expect(result.current.error).toBeNull()
  })

  it('a reset further off than 120 s waits 120 s', async () => {
    answer = windowUntil(Date.now() + 500_000)
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(120)
    await advance(119_000)
    expect(requests).toHaveLength(1)
    await advance(1_000)
    expect(requests).toHaveLength(2)
  })

  it.each([
    ['missing', () => null],
    ['empty', () => ''],
    ['not a number', () => 'soon'],
    ['not a whole number', () => `${Date.now() + 5_000}.5`],
    ['a minute in the past', () => String(Date.now() - 60_000)],
    ['in seconds, not milliseconds', () => String(Math.floor(Date.now() / 1000) + 60)],
    ['more than an hour ahead', () => String(Date.now() + 3_600_001)],
  ] as [string, () => string | null][])('a header that is %s keeps the doubling (30, 60, 120 s); a near reset on the fourth refusal waits the 120 s step', async (_label, header) => {
    let good = false
    answer = () => {
      if (good) return limitedWith(String(Date.now() + 20_000))
      const value = header()
      return value === null ? limited() : limitedWith(value)
    }
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(30)
    await advance(30_000)
    expect(requests).toHaveLength(2)
    expect(result.current.retryIn).toBe(60)
    await advance(60_000)
    expect(requests).toHaveLength(3)
    expect(result.current.retryIn).toBe(120)
    good = true
    await advance(120_000)
    expect(requests).toHaveLength(4)
    // [A109 S-1] CHANGED EXPECTATION (WAS 21): THE FOURTH REFUSAL IN A ROW WAITS AT LEAST 120 S, WHATEVER THE HEADER SAYS.
    expect(result.current.retryIn).toBe(120)
  })

  it('the doubling counts refusals in a row, not the waits the server gave', async () => {
    let n = 0
    answer = () => (++n === 1 ? limitedWith(String(Date.now() + 4_000)) : limited())
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(5)
    await advance(5_000)
    expect(requests).toHaveLength(2)
    expect(result.current.retryIn).toBe(60) // today's second refusal, not 2 x 5 s
  })

  it('a short wait never aborts its own slow retry', async () => {
    let n = 0
    answer = (url) => {
      if (++n === 1) return limitedWith(String(Date.now() + 1_000))
      return new Promise<Response>((resolve) => setTimeout(() => resolve(ok(url)), 5_000))
    }
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(2)
    await advance(2_000 + 5_000)
    expect(requests).toHaveLength(2) // the 2 s timer did not supersede the request on the wire
    expect(result.current.meta).not.toBeNull()
    expect(result.current.retryIn).toBeNull()
  })

  it('…but a retry that hangs for a whole poll interval is superseded', async () => {
    let n = 0
    answer = (url) => {
      if (++n === 1) return limitedWith(String(Date.now() + 1_000))
      return n === 2 ? never() : ok(url)
    }
    const { result } = mount()
    await advance(1)
    await advance(2_000)
    expect(requests).toHaveLength(2)
    await advance(14_000)
    expect(requests).toHaveLength(2)
    await advance(2_000)
    expect(requests).toHaveLength(3)
    expect(requests[2].at - requests[1].at).toBe(16_000)
    expect(result.current.meta).not.toBeNull()
  })
})

/** A refusal that carries `reset` as X-RateLimit-Reset and, when given, `date` as Date. */
const refusal = (reset: string, date?: string) =>
  new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'X-RateLimit-Reset': reset, ...(date === undefined ? {} : { Date: date }) },
  })
/** Seconds between one request and the next. */
const gapsS = () => requests.slice(1).map((r, i) => (r.at - requests[i].at) / 1000)

describe('useQuote: a tab that keeps being refused slows down [A109 S-1]', () => {
  // The audit's case: 601 requests in 10 minutes before this fix, 7 on main.
  it.each([
    ['now', 0],
    ['900 ms ago', -900],
  ] as [string, number][])('a server always answering "reset = %s": free once, then 30, 60, 120 s; at most 8 requests in 10 minutes', async (_label, offset) => {
    answer = () => refusal(String(Date.now() + offset))
    mount()
    await advance(1)
    for (let second = 0; second < 599; second++) await advance(1_000)
    expect(requests.length).toBeLessThanOrEqual(8)
    expect(gapsS()).toEqual([1, 30, 60, 120, 120, 120, 120])
  })

  it('a reset longer than the step is still followed', async () => {
    const aheadMs = [4_000, 45_000, 10_000, 130_000]
    let n = 0
    answer = () => refusal(String(Date.now() + aheadMs[n++]))
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(5) // first in a row: the header's own time
    await advance(5_000)
    expect(result.current.retryIn).toBe(46) // second: 46 s beats the 30 s step
    await advance(46_000)
    expect(result.current.retryIn).toBe(60) // third: the 60 s step beats 11 s
    await advance(60_000)
    expect(result.current.retryIn).toBe(120) // fourth: capped
    expect(requests).toHaveLength(4)
  })

  it('a success starts the count again', async () => {
    let n = 0
    answer = (url) => (++n === 3 ? ok(url) : refusal(String(Date.now() + 2_000)))
    const { result } = mount()
    await advance(1)
    await advance(3_000)
    expect(result.current.retryIn).toBe(30) // second refusal in a row
    await advance(30_000)
    expect(result.current.error).toBeNull()
    await advance(15_000) // the next poll is refused: first of a new row
    expect(requests).toHaveLength(4)
    expect(result.current.retryIn).toBe(3)
  })

  it.each([
    ['pair', { tin: WETH, tout: USDT, amount: '1' }, 0],
    ['amount', { tin: WETH, tout: USDC, amount: '2' }, 500],
  ] as [string, Props, number][])('a new %s starts the count again', async (_label, next, settleMs) => {
    answer = () => refusal(String(Date.now() + 2_000))
    const { result, rerender } = mount()
    await advance(1)
    await advance(3_000)
    expect(result.current.retryIn).toBe(30)
    rerender(next)
    await advance(settleMs)
    expect(result.current.retryIn).toBe(3)
  })

  it('a new chain starts the count again', async () => {
    answer = () => refusal(String(Date.now() + 2_000))
    const { result, rerender } = mount()
    await advance(1)
    await advance(3_000)
    expect(result.current.retryIn).toBe(30)
    h.chainId = 8453
    rerender({ tin: WETH, tout: USDC, amount: '1' })
    await advance(0)
    expect(result.current.retryIn).toBe(3)
  })
})

describe('useQuote: the reset is read against the response\'s own Date [A109 S-2]', () => {
  /** A server whose clock is `behindMs` behind this device, stating a reset 20 s ahead of its own clock. */
  const stated = (behindMs: number, date: (serverNow: number) => string | undefined) => () => {
    const serverNow = Date.now() - behindMs
    return refusal(String(serverNow + 20_000), date(serverNow))
  }

  it.each([
    ['2 s fast', 2_000],
    ['5 minutes fast', 300_000],
    ['5 minutes slow', -300_000],
  ] as [string, number][])('a device clock %s does not change the wait', async (_label, behindMs) => {
    answer = stated(behindMs, (t) => new Date(t).toUTCString())
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(21)
  })

  it.each([
    ['missing', () => undefined],
    ['empty', () => ''],
    ['unparseable', () => 'yesterday-ish'],
  ] as [string, () => string | undefined][])('a Date that is %s leaves the device clock as the reference, as before', async (_label, date) => {
    answer = stated(5_000, date) // 20 s ahead of a clock 5 s behind: 15 s ahead of the device
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(16)
  })
})

describe('useQuote: the two mutants A109 found alive [S-3]', () => {
  // Kills "a reset up to 30 s in the past is accepted": accepted, either would be retried after the 1 s margin.
  it.each([2_000, 30_000])('a reset %i ms in the past is not "free now": it takes the 30 s step', async (past) => {
    answer = () => refusal(String(Date.now() - past))
    const { result } = mount()
    await advance(1)
    expect(result.current.retryIn).toBe(30)
    await advance(29_000)
    expect(requests).toHaveLength(1)
    await advance(1_000)
    expect(requests).toHaveLength(2)
  })

  // Kills "the timer guard also applies outside a backoff". A manual refresh leaves a request 5 s old at the tick.
  it('outside a backoff a timer tick replaces a request in flight, as on main', async () => {
    let first = true
    answer = (url) => {
      if (!first) return never()
      first = false
      return ok(url)
    }
    const { result } = mount()
    await advance(10_000)
    await act(async () => { result.current.refresh() })
    expect(requests).toHaveLength(2)
    await advance(5_000) // the 15 s tick, with the refresh 5 s on the wire
    expect(requests).toHaveLength(3)
    // every new fetch aborts the previous controller, answered or not: the second was still on the wire
    const aborted = vi.mocked(fetch).mock.calls.map((call) => call[1]!.signal!.aborted)
    expect(aborted).toEqual([true, true, false])
  })
})

describe('useQuote: the poll carries the split refresh when the split hook asks for it', () => {
  const batch = { status: 'ok', quotes: { '500000000000000000': [] } }

  it('adds split=1 only to a request the registered split hook wants, and tags the batch with when it arrived', async () => {
    answer = (url) => ok(url, url.searchParams.get('split') === '1' ? { split: batch } : {})
    const { result } = mount()
    await advance(1)
    expect(requests[0].url.searchParams.has('split')).toBe(false)
    expect(result.current.meta?.split).toBeUndefined()

    const asked: string[] = []
    const unregister = result.current.splitPoll.register((key) => { asked.push(key.amountRaw); return true })
    await advance(15_000)
    expect(requests).toHaveLength(2) // the refresh costs no extra request
    expect(requests[1].url.searchParams.get('split')).toBe('1')
    expect(asked).toEqual(['1000000000000000000'])
    expect(result.current.meta?.split).toEqual({ ...batch, receivedAt: Date.now() - 1 }) // the poll fired 1 ms ago

    unregister()
    await advance(15_000)
    expect(requests[2].url.searchParams.has('split')).toBe(false)
    expect(result.current.meta?.split).toBeUndefined()
  })
})
