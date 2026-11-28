// @vitest-environment jsdom
/**
 * [fix/quote-rate-limit-normal-use] When the split analysis asks /api/quote, and what that costs.
 *
 * Before: one run on EVERY new quote (each 15 s poll, and in v1 every keystroke while the old quote was on screen), 11
 * requests a run. One idle tab at $10,000 hit the 30/min limit after 31 s.
 * Now: one request per analysis; it runs when the pair or the SETTLED amount has held 1.5 s. While a split is the
 * selected route its refresh rides on every quote poll; while none is, it is a request of its own, at most once a minute
 * [fix/quote-split-followups, A108 S-1: a poll that carried it waited for the slowest of 12 fan-outs].
 *
 * The REAL split router runs here. Only the network is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { parseUnits } from 'viem'
import { useSplitRoute } from './useSplitRoute'
import { fetchSplitQuotes, findBestSplit } from '@/lib/split-router'
import { SPLIT_ELIGIBLE_SOURCES, splitSubAmounts } from '@/lib/split-routing-types'
import { isExecutableSource } from '@/lib/executable-sources'
import { createSplitPollChannel, type PolledSplit, type SplitPollChannel } from '@/lib/split-poll'
import { makeQuoteKey } from '@/lib/quote-identity'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/api'
import type { Token } from '@/lib/tokens'

const token = (address: string, symbol: string, decimals: number) => ({ address, symbol, name: symbol, decimals, logoURI: '', category: 'Other' }) as Token
const ETH = token('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 'ETH', 18)
const USDC = token('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6)
const USDT = token('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 6)

const SOURCES = ['velora', 'kyberswap', 'uniswapv3', '0x', '1inch', 'curve', 'cowswap'] as const

/** A small seeded generator (mulberry32): the same seed always builds the same quote set. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** What every source answers at `amount` (wei of ETH → USDC base units), each with its own price impact; some are absent. */
function quotesFor(seed: number, amount: string): NormalizedQuote[] {
  const out: NormalizedQuote[] = []
  SOURCES.forEach((source, i) => {
    const bySource = rng(seed * 31 + i)
    const factor = 0.996 + bySource() * 0.006
    const impact = 0.2e-6 + bySource() * 1.2e-6
    if (rng(seed * 97 + i * 13 + Number(BigInt(amount) % 1000003n))() < 0.12) return // no route at this size
    const usd = (Number(BigInt(amount) / 10n ** 12n) / 1e6) * 3000
    const toAmount = BigInt(Math.floor(usd * factor * (1 - Math.min(0.3, usd * impact)) * 1e6)).toString()
    out.push({ source, toAmount, estimatedGas: 0, gasUsd: Math.round(bySource() * 500) / 100, routes: [] } as NormalizedQuote)
  })
  return out.sort((a, b) => (BigInt(b.toAmount) > BigInt(a.toAmount) ? 1 : -1))
}

type Tagged = MetaQuoteResult & { identity: ReturnType<typeof makeQuoteKey> & { fetchedAt: number }; split?: PolledSplit }

function metaFor(seed: number, amount: string, tokenOut: Token = USDC, extra: Partial<Tagged> = {}): Tagged {
  const raw = parseUnits(amount, 18).toString()
  const all = quotesFor(seed, raw)
  return {
    best: all[0], all, fetchedAt: Date.now(),
    identity: { ...makeQuoteKey({ chainId: 1, tokenIn: ETH.address, tokenOut: tokenOut.address, amountRaw: raw, decimalsIn: 18, decimalsOut: 6 }), fetchedAt: Date.now() },
    ...extra,
  }
}

const batchFor = (seed: number, amount: string) => ({
  status: 'ok' as const,
  quotes: Object.fromEntries(splitSubAmounts(parseUnits(amount, 18)).map((sub) => [sub, quotesFor(seed, sub)])),
})

/** Today's analysis, verbatim: one answer per sub-amount, filtered, through the real router. */
async function todaysSplit(seed: number, amount: string) {
  const raw = parseUnits(amount, 18).toString()
  const seedMeta = metaFor(seed, amount)
  const map = await fetchSplitQuotes(
    async (sub) => quotesFor(seed, sub).filter((q) => SPLIT_ELIGIBLE_SOURCES.has(q.source) && isExecutableSource(q.source, 1)),
    raw,
    seedMeta.all.filter((q) => isExecutableSource(q.source, 1)),
  )
  return findBestSplit(map, raw, seedMeta.best)
}

/** A seed whose analysis recommends a split (so the hook selects it), and one whose analysis does not. */
let RECOMMENDED = 0
let NOT_RECOMMENDED = 0
/** A seed whose analysis recommends a split at 4 ETH. */
let RECOMMENDED_AT_4 = 0

let requests: URL[] = []
let serveSeed = 1
let deferMs: number | null = null

beforeEach(async () => {
  if (!RECOMMENDED || !NOT_RECOMMENDED) {
    for (let seed = 1; seed < 400 && (!RECOMMENDED || !NOT_RECOMMENDED); seed++) {
      const route = await todaysSplit(seed, '3.3333')
      if (route.isSplit && route.improvementBps >= 10) RECOMMENDED ||= seed
      else NOT_RECOMMENDED ||= seed
    }
  }
  for (let seed = 1; seed < 400 && !RECOMMENDED_AT_4; seed++) {
    const route = await todaysSplit(seed, '4')
    if (route.isSplit && route.improvementBps >= 10) RECOMMENDED_AT_4 = seed
  }
  vi.useFakeTimers({ now: 5_000_000 })
  requests = []
  serveSeed = RECOMMENDED
  deferMs = null
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    const amount = url.searchParams.get('amount')!
    // Answers both shapes: the batched request, and (as origin/main asked) one sub-amount at a time.
    const split = url.searchParams.get('split') !== '1'
      ? undefined
      : deferMs !== null
        ? { status: 'deferred', retryAfterMs: deferMs }
        : { status: 'ok', quotes: Object.fromEntries(splitSubAmounts(BigInt(amount)).map((sub) => [sub, quotesFor(serveSeed, sub)])) }
    const all = quotesFor(serveSeed, amount)
    return new Response(JSON.stringify({ best: all[0], all, fetchedAt: Date.now(), ...(split ? { split } : {}) }), { status: 200 })
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

interface Props { meta: Tagged | null; amount: string; tokenOut: Token }
function mount(initial: Partial<Props> = {}, channel: SplitPollChannel = createSplitPollChannel()) {
  const props: Props = { meta: metaFor(serveSeed, '3.3333'), amount: '3.3333', tokenOut: USDC, ...initial }
  const hook = renderHook((p: Props) => useSplitRoute(p.meta, ETH, p.tokenOut, p.amount, true, 1, channel), { initialProps: props })
  const set = (next: Partial<Props>) => { Object.assign(props, next); hook.rerender({ ...props }) }
  const wants = (amount = props.amount, tokenOut = props.tokenOut) =>
    channel.wants(makeQuoteKey({ chainId: 1, tokenIn: ETH.address, tokenOut: tokenOut.address, amountRaw: parseUnits(amount, 18).toString(), decimalsIn: 18, decimalsOut: 6 }))
  /** The next quote poll, with the split batch on it when the hook asked for one. */
  const poll = async (opts: { seed?: number; batch?: PolledSplit | 'ride' } = {}) => {
    const seed = opts.seed ?? serveSeed
    const ride = wants()
    const split: PolledSplit | undefined =
      opts.batch && opts.batch !== 'ride' ? opts.batch : ride ? { ...batchFor(seed, props.amount), receivedAt: Date.now() } : undefined
    set({ meta: metaFor(seed, props.amount, props.tokenOut, split ? { split } : {}) })
    await advance(0)
    return ride
  }
  return { ...hook, set, wants, poll }
}

describe('useSplitRoute: one request per analysis', () => {
  it('waits until the pair and amount have held 1.5 s, then asks ONCE for the whole analysis', async () => {
    mount()
    await advance(1_400)
    expect(requests).toHaveLength(0)
    await advance(200)
    expect(requests).toHaveLength(1)
    expect(requests[0].pathname).toBe('/api/quote')
    expect(requests[0].searchParams.get('split')).toBe('1')
    expect(requests[0].searchParams.get('amount')).toBe(parseUnits('3.3333', 18).toString())
    await advance(10_000)
    expect(requests).toHaveLength(1)
  })

  it('typing a small amount over a large quote asks nothing: a quote for another amount is never analysed (v1)', async () => {
    const large = metaFor(serveSeed, '3.3333')
    const hook = mount({ meta: large })
    await advance(2_000)
    requests = []
    for (const typed of ['3.333', '3.33', '3.3', '3.', '3', '', '0', '0.', '0.0', '0.01', '0.012', '0.0123']) {
      hook.set({ amount: typed }) // the large quote is still the one on screen
      await advance(150)
    }
    await advance(3_000)
    expect(requests).toHaveLength(0)
    expect(hook.result.current.splitResult).toBeNull()
    expect(hook.result.current.useSplit).toBe(false)
  })

  it('a change of token or amount clears the old analysis and selection at once, and analyses the new one after 1.5 s', async () => {
    const hook = mount()
    await advance(1_600)
    expect(hook.result.current.useSplit).toBe(true)
    hook.set({ tokenOut: USDT, meta: null })
    await advance(0)
    expect(hook.result.current.splitResult).toBeNull()
    expect(hook.result.current.useSplit).toBe(false)
    hook.set({ meta: metaFor(serveSeed, '3.3333', USDT) })
    await advance(1_400)
    expect(requests).toHaveLength(1)
    await advance(200)
    expect(requests).toHaveLength(2)
    expect(requests[1].searchParams.get('dst')).toBe(USDT.address)
  })
})

describe('useSplitRoute: same quotes, same split result', () => {
  it('equals today\'s per-amount analysis over 25 seeded quote sets, from one request each', async () => {
    let splits = 0
    for (let seed = 1; seed <= 25; seed++) {
      serveSeed = seed
      requests = []
      const expected = await todaysSplit(seed, '3.3333')
      const hook = mount({ meta: metaFor(seed, '3.3333') })
      await advance(1_600)
      expect(requests, `seed ${seed}`).toHaveLength(1)
      expect(hook.result.current.splitResult?.bestSplit, `seed ${seed}`).toEqual(expected)
      expect(hook.result.current.splitRecommended, `seed ${seed}`).toBe(expected.isSplit && expected.improvementBps >= 10)
      expect(hook.result.current.useSplit, `seed ${seed}`).toBe(expected.isSplit && expected.improvementBps >= 10)
      if (expected.isSplit) splits++
      hook.unmount()
    }
    expect(splits, 'the seeds really exercise split routes').toBeGreaterThan(3)
  })

  it('a refresh that rode on a poll equals today\'s analysis for that poll\'s quotes, without a request of its own', async () => {
    const hook = mount()
    await advance(1_600)
    requests = []
    const nextSeed = RECOMMENDED + 1
    await advance(13_400)
    expect(await hook.poll({ seed: nextSeed })).toBe(true)
    expect(hook.result.current.splitResult?.bestSplit).toEqual(await todaysSplit(nextSeed, '3.3333'))
    expect(hook.result.current.splitResult?.fetchedAt).toBe(Date.now())
    expect(requests).toHaveLength(0)
  })
})

describe('useSplitRoute: refresh cadence', () => {
  it('while a split is SELECTED every poll is asked to carry it, and no request of its own is made', async () => {
    const hook = mount()
    await advance(1_600)
    expect(hook.result.current.useSplit).toBe(true)
    for (let i = 0; i < 4; i++) {
      await advance(15_000)
      expect(await hook.poll()).toBe(true)
      expect(Date.now() - hook.result.current.splitResult!.fetchedAt).toBe(0)
    }
    expect(requests).toHaveLength(1)
  })

  // CHANGED EXPECTATION [fix/quote-split-followups, A108 S-1]: AN UNSELECTED SPLIT'S REFRESH USED TO RIDE ON THE POLL
  // ONCE A MINUTE. NOW NO POLL EVER CARRIES IT; IT IS A REQUEST OF ITS OWN, ON THE SAME ONCE-A-MINUTE RULE.
  it('while NO split is selected no poll carries it; the refresh is a request of its own, at most once a minute', async () => {
    serveSeed = NOT_RECOMMENDED
    const hook = mount({ meta: metaFor(NOT_RECOMMENDED, '3.3333') })
    await advance(1_600)
    expect(hook.result.current.useSplit).toBe(false)
    const rode: boolean[] = []
    const asked: number[] = []
    for (let i = 0; i < 8; i++) {
      await advance(15_000)
      rode.push(await hook.poll())
      asked.push(requests.length)
    }
    expect(rode).toEqual(Array(8).fill(false))
    // analysed at 1.5 s; polls at 16.6, 31.6, 46.6 ask nothing; 61.6 asks (60 s on); then three do not, then it asks again
    expect(asked).toEqual([1, 1, 1, 2, 2, 2, 2, 3])
    for (const url of requests) expect(url.searchParams.get('split')).toBe('1')
    expect(Date.now() - hook.result.current.splitResult!.fetchedAt).toBe(0)
  })

  it('a refresh of its own prices the same quotes into the same split as the router run per amount', async () => {
    serveSeed = NOT_RECOMMENDED
    const hook = mount({ meta: metaFor(NOT_RECOMMENDED, '3.3333') })
    await advance(1_600)
    serveSeed = RECOMMENDED
    await advance(60_000)
    expect(await hook.poll()).toBe(false)
    expect(requests).toHaveLength(2)
    expect(hook.result.current.splitResult?.bestSplit).toEqual(await todaysSplit(RECOMMENDED, '3.3333'))
    expect(hook.result.current.useSplit).toBe(true)
    await advance(15_000)
    expect(await hook.poll()).toBe(true) // selected now: the next refresh rides
    expect(requests).toHaveLength(2)
  })

  it('a poll for another amount or token is never asked to carry the split', async () => {
    const hook = mount()
    await advance(1_600)
    expect(hook.wants()).toBe(true)
    expect(hook.wants('2')).toBe(false)
    expect(hook.wants('3.3333', USDT)).toBe(false)
  })

  it('a quote that drops out for a moment does not re-run the analysis', async () => {
    const hook = mount()
    await advance(1_600)
    const before = hook.result.current.splitResult
    hook.set({ meta: null })
    await advance(100)
    expect(hook.result.current.splitResult).toBeNull()
    hook.set({ meta: metaFor(serveSeed, '3.3333') })
    await advance(3_000)
    expect(requests).toHaveLength(1)
    expect(hook.result.current.splitResult).toBe(before)
  })
})

describe('useSplitRoute: a spent split bucket', () => {
  // CHANGED EXPECTATION [fix/quote-split-followups]: NOTHING IS SELECTED HERE, SO THE RETRY AFTER THE SERVER'S WAIT IS
  // A REQUEST OF ITS OWN; IT USED TO RIDE ON THE POLL.
  it('shows nothing and no error, then asks again only after the server\'s wait, never on a poll', async () => {
    deferMs = 20_000
    const hook = mount()
    await advance(1_600)
    expect(requests).toHaveLength(1)
    expect(hook.result.current.splitResult).toBeNull()
    expect(hook.result.current.useSplit).toBe(false)
    await advance(13_400)
    expect(await hook.poll()).toBe(false)
    expect(requests).toHaveLength(1) // 15 s: the wait is not over
    await advance(6_000)
    expect(hook.wants()).toBe(false)
    expect(requests).toHaveLength(1) // over, but it is a new quote that asks, not a timer
    deferMs = null
    await advance(9_000)
    expect(await hook.poll()).toBe(false)
    expect(requests).toHaveLength(2)
  })

  it('a retry of its own that FAILS after the wait is not repeated on every later poll', async () => {
    deferMs = 20_000
    const hook = mount()
    await advance(1_600)
    const failing = vi.fn(async (input: unknown) => {
      requests.push(new URL(String(input), 'http://localhost'))
      return new Response('{"error":"upstream"}', { status: 502 })
    })
    vi.stubGlobal('fetch', failing)
    await advance(28_400)
    await hook.poll() // 30 s: the wait is over, so it asks once, and the ask fails
    expect(requests).toHaveLength(2)
    for (let i = 0; i < 3; i++) {
      await advance(15_000)
      await hook.poll()
    }
    expect(requests, 'back on the once-a-minute rule').toHaveLength(2)
    await advance(15_000)
    await hook.poll()
    expect(requests).toHaveLength(3)
  })

  it('a deferred refresh keeps the last analysis with its OLD timestamp, so it goes stale', async () => {
    const hook = mount()
    await advance(1_600)
    const stamped = hook.result.current.splitResult!.fetchedAt
    await advance(15_000)
    await hook.poll({ batch: { status: 'deferred', retryAfterMs: 30_000, receivedAt: Date.now() } })
    expect(hook.result.current.splitResult?.fetchedAt).toBe(stamped)
    expect(hook.wants()).toBe(false)
  })
})

describe('useSplitRoute: falling back to the single route', () => {
  it('unselects the split and a later recommendation for the same trade does not re-select it; the user still can', async () => {
    const hook = mount()
    await advance(1_600)
    act(() => hook.result.current.fallBackToSingle())
    expect(hook.result.current.useSplit).toBe(false)
    await advance(61_000)
    // CHANGED EXPECTATION [fix/quote-split-followups]: THE 60 s REFRESH OF AN UNSELECTED SPLIT NO LONGER RIDES THE POLL.
    expect(await hook.poll()).toBe(false)
    expect(requests).toHaveLength(2)
    expect(hook.result.current.splitRecommended).toBe(true)
    expect(hook.result.current.useSplit).toBe(false)
    act(() => hook.result.current.toggleSplit())
    expect(hook.result.current.useSplit).toBe(true)
  })

  it('…also once a deferral\'s wait is over, and not while it runs', async () => {
    const hook = mount()
    await advance(1_600)
    await advance(15_000)
    await hook.poll({ batch: { status: 'deferred', retryAfterMs: 30_000, receivedAt: Date.now() } })
    act(() => hook.result.current.toggleSplit()) // off
    requests = []
    await advance(5_000)
    act(() => hook.result.current.toggleSplit()) // on, 25 s of the wait left
    await advance(0)
    expect(requests).toHaveLength(0)
    act(() => hook.result.current.toggleSplit())
    await advance(26_000)
    await act(async () => { hook.result.current.toggleSplit() })
    await advance(0)
    expect(requests).toHaveLength(1)
  })

  it('selecting a split whose analysis is older than 15 s refreshes it at once', async () => {
    const hook = mount()
    await advance(1_600)
    act(() => hook.result.current.toggleSplit()) // off
    await advance(20_000)
    requests = []
    await act(async () => { hook.result.current.toggleSplit() })
    await advance(0)
    expect(requests).toHaveLength(1)
    expect(Date.now() - hook.result.current.splitResult!.fetchedAt).toBe(0)
  })
})

describe('useSplitRoute: a split switched off by hand', () => {
  /** Polls 15 s apart, so the unselected analysis is refreshed (and recommends the split) again and again. */
  async function polls(hook: ReturnType<typeof mount>, n: number) {
    for (let i = 0; i < n; i++) {
      await advance(15_000)
      await hook.poll()
    }
  }
  async function switchedOff() {
    const hook = mount()
    await advance(1_600)
    expect(hook.result.current.useSplit).toBe(true)
    act(() => hook.result.current.toggleSplit())
    requests = []
    return hook
  }

  it('stays off for the same pair and amount, whatever a later recommended analysis says', async () => {
    const hook = await switchedOff()
    await polls(hook, 12)
    expect(requests.length, 'it really was analysed again').toBeGreaterThanOrEqual(2)
    expect(hook.result.current.splitRecommended).toBe(true)
    expect(hook.result.current.useSplit).toBe(false)
  })

  it('stays off across them, and switched back on by hand it is selected and later analyses keep it so', async () => {
    const hook = await switchedOff()
    await polls(hook, 5)
    expect(hook.result.current.useSplit).toBe(false)
    await act(async () => { hook.result.current.toggleSplit() }) // on
    await polls(hook, 2)
    expect(hook.result.current.useSplit).toBe(true)
  })

  it('a new amount resets the choice', async () => {
    const hook = await switchedOff()
    await polls(hook, 5)
    expect(hook.result.current.useSplit).toBe(false)
    serveSeed = RECOMMENDED_AT_4
    hook.set({ amount: '4', meta: metaFor(serveSeed, '4') })
    await advance(1_600)
    expect(hook.result.current.useSplit).toBe(true)
  })

  it('a new pair resets the choice, and so does coming back to the first one', async () => {
    const hook = await switchedOff()
    await polls(hook, 5)
    expect(hook.result.current.useSplit).toBe(false)
    hook.set({ tokenOut: USDT, meta: metaFor(serveSeed, '3.3333', USDT) })
    await advance(1_600)
    expect(hook.result.current.useSplit).toBe(true)
    hook.set({ tokenOut: USDC, meta: metaFor(serveSeed, '3.3333') })
    await advance(1_600)
    expect(hook.result.current.useSplit).toBe(true)
  })
})
