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
  ] as [string, () => string | null][])('a header that is %s keeps the doubling (30, 60, 120 s); a good one is then followed', async (_label, header) => {
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
    expect(result.current.retryIn).toBe(21)
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
