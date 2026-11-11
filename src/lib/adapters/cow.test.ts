/**
 * Unit tests for src/lib/adapters/cow.ts — [11-L-02] validator ordering.
 *
 * Pins that parseCowOrderParams validates the CoW /quote response BEFORE
 * any BigInt() conversion happens. Previously, BigInt(quote.buyAmount) ran
 * first and could throw a raw SyntaxError on a non-numeric buyAmount; now
 * the validator rejects first with a tagged error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// [W7-L-01] The fail-soft branch fires a server-only, fire-and-forget dynamic
// import of the fee-zeroing monitor (guarded by `typeof window === 'undefined'`,
// true in this node-env suite). Mock it to a no-op so the tests never make a
// real KV call — the monitor's own alert logic is covered by cow-fee-monitor.test.ts.
vi.mock('@/lib/cow-fee-monitor', () => ({ recordCowFeeZeroing: vi.fn(async () => {}) }))

import cowAdapter, { pollCowOrderStatus, submitCowOrder, __resetCow429LogForTests } from './cow'
import { FEE_RECIPIENT, FEE_BPS, NATIVE_ETH } from '@/lib/constants'

const VALID_QUOTE = {
  sellToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  buyToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  sellAmount: '1000000',
  buyAmount: '500000000000000000',
  validTo: 9_999_999_999,
  appData: '{}',
  appDataHash: '0x' + 'a'.repeat(64),
  feeAmount: '1000',
  kind: 'sell',
  partiallyFillable: false,
  sellTokenBalance: 'erc20',
  buyTokenBalance: 'erc20',
  receiver: '0x1111111111111111111111111111111111111111',
}

function mockFetchOnce(payload: unknown, ok = true) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: ok ? 200 : 400,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('cow adapter — validator runs before BigInt (11-L-02)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const swapParams = {
    src: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    dst: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    amount: '1000000',
    from: '0x2222222222222222222222222222222222222222',
    slippage: 0.5,
    srcDecimals: 6,
    dstDecimals: 18,
  }

  it('throws tagged malformed-response error (not SyntaxError) when buyAmount is non-numeric', async () => {
    mockFetchOnce({ id: 42, quote: { ...VALID_QUOTE, buyAmount: 'not_a_number' } })

    await expect(cowAdapter.fetchSwapData(swapParams)).rejects.toThrow(
      /malformed \/quote response/,
    )
    // The error MUST not be a SyntaxError thrown by a bare BigInt() call.
    await expect(cowAdapter.fetchSwapData(swapParams)).rejects.not.toThrow(SyntaxError)
  })

  it('throws tagged malformed-response error when buyAmount is missing', async () => {
    const { buyAmount: _omit, ...withoutBuyAmount } = VALID_QUOTE
    mockFetchOnce({ id: 42, quote: withoutBuyAmount })

    await expect(cowAdapter.fetchSwapData(swapParams)).rejects.toThrow(
      /malformed \/quote response/,
    )
  })

  it('throws tagged malformed-response error when the whole shape is wrong', async () => {
    mockFetchOnce({ id: 42, quote: { sellToken: 'garbage' } })

    await expect(cowAdapter.fetchSwapData(swapParams)).rejects.toThrow(
      /malformed \/quote response/,
    )
  })

  it('happy path: valid quote returns a NormalizedQuote with slippage-adjusted buyAmount', async () => {
    mockFetchOnce({ id: 42, quote: VALID_QUOTE })

    const result = await cowAdapter.fetchSwapData(swapParams)
    expect(result).not.toBeNull()
    expect(result?.source).toBe('cowswap')
    expect(result?.toAmount).toBe(VALID_QUOTE.buyAmount)
    expect(result?.cowOrderParams).toBeDefined()
    // 0.5% slippage on 500000000000000000 → 497500000000000000.
    expect(result?.cowOrderParams?.buyAmount).toBe('497500000000000000')
  })
})

// ─────────────────────────────────────────────────────────────
// [SPRINT-9T T2] CoW partner fee in appData + fail-soft.
// ─────────────────────────────────────────────────────────────
describe('cow adapter — partner fee [SPRINT-9T T2]', () => {
  const SELL = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const BUY = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  const swapParams = { src: SELL, dst: BUY, amount: '1000000', from: '0x2222222222222222222222222222222222222222', slippage: 0.5, srcDecimals: 6, dstDecimals: 18 }

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

  function captureBodies(responder: (callIndex: number) => Response) {
    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as { body?: string } | undefined
      bodies.push(JSON.parse((init?.body as string) ?? '{}'))
      return responder(bodies.length)
    })
    return bodies
  }

  afterEach(() => vi.restoreAllMocks())

  it('quote-path appData carries partnerFee { bps: FEE_BPS, recipient: FEE_RECIPIENT }', async () => {
    const bodies = captureBodies(() => json({ id: 1, quote: VALID_QUOTE }))
    await cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' })
    const appData = JSON.parse(bodies[0].appData as string)
    expect(appData.metadata.partnerFee).toEqual({ bps: FEE_BPS, recipient: FEE_RECIPIENT })
    expect(appData.version).toBe('1.1.0') // schema version that supports partnerFee (v0.1.0 sub-schema)
  })

  it('order-path appData carries the SAME partnerFee + referrer (quote == order appData)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bodies = captureBodies(() => json({ id: 1, quote: VALID_QUOTE }))
    await cowAdapter.fetchSwapData(swapParams)
    const appData = JSON.parse(bodies[0].appData as string)
    expect(appData.metadata.partnerFee).toEqual({ bps: FEE_BPS, recipient: FEE_RECIPIENT })
    expect(appData.metadata.referrer.address).toBe(FEE_RECIPIENT)
  })

  it('uses the SHARED FEE_BPS (10 = 0.1%), not a hardcoded number', () => {
    expect(FEE_BPS).toBe(10)
  })

  it('FAILS SOFT to fee-free appData when CoW rejects the partnerFee schema — quoting never breaks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bodies = captureBodies((n) =>
      n === 1
        ? json({ errorType: 'InvalidAppData', description: 'invalid appData: partnerFee not allowed' }, 400)
        : json({ id: 7, quote: VALID_QUOTE }),
    )
    const result = await cowAdapter.fetchSwapData(swapParams)
    expect(result?.source).toBe('cowswap') // still produced a usable order
    // First attempt HAD the fee; the retry DROPPED it.
    expect(JSON.parse(bodies[0].appData as string).metadata.partnerFee).toBeDefined()
    expect(JSON.parse(bodies[1].appData as string).metadata.partnerFee).toBeUndefined()
    // Structured warning logged for ops.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cow_partner_fee_failsoft'))
  })

  it('does NOT fail soft on a non-appData error (NoLiquidity throws, exactly one request)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bodies = captureBodies(() => json({ errorType: 'NoLiquidity', description: 'NoLiquidity' }, 400))
    await expect(cowAdapter.fetchSwapData(swapParams)).rejects.toThrow(/CoW quote 400/)
    expect(bodies.length).toBe(1) // no silent fee-free retry on a real error
  })
})

// ─────────────────────────────────────────────────────────────
// [SPRINT-9W] Chain-aware wrapped-native mapping (Base MEV-protection fix).
// ─────────────────────────────────────────────────────────────
describe('cow adapter — chain-aware wrapped-native [SPRINT-9W]', () => {
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const MAINNET_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  const BASE_WETH = '0x4200000000000000000000000000000000000006'
  const orderParams = { src: NATIVE_ETH, dst: USDC, amount: '1000000000000000000', from: '0x2222222222222222222222222222222222222222', slippage: 0.5, srcDecimals: 18, dstDecimals: 6 }

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
  function captureBodies(responder: () => Response) {
    const bodies: Array<Record<string, unknown>> = []
    vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as { body?: string } | undefined
      bodies.push(JSON.parse((init?.body as string) ?? '{}'))
      return responder()
    })
    return bodies
  }

  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('Base native-ETH SELL → quote request carries Base WETH 0x4200…0006 (not mainnet WETH)', async () => {
    const bodies = captureBodies(() => json({ id: 1, quote: VALID_QUOTE }))
    await cowAdapter.fetchQuote({ src: NATIVE_ETH, dst: USDC, amount: '1000000000000000000', chainId: 8453 })
    expect(bodies[0].sellToken).toBe(BASE_WETH)
  })

  it('mainnet native-ETH SELL → mainnet WETH 0xC02a… (byte-identical)', async () => {
    const bodies = captureBodies(() => json({ id: 1, quote: VALID_QUOTE }))
    await cowAdapter.fetchQuote({ src: NATIVE_ETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    expect(bodies[0].sellToken).toBe(MAINNET_WETH)
  })

  it('order build (fetchSwapData) uses the SAME Base mapping as the quote', async () => {
    const bodies = captureBodies(() => json({ id: 1, quote: VALID_QUOTE }))
    await cowAdapter.fetchSwapData({ ...orderParams, chainId: 8453 })
    expect(bodies[0].sellToken).toBe(BASE_WETH)
  })

  it('native-ETH as the BUY token also maps to the chain WETH (Base)', async () => {
    const bodies = captureBodies(() => json({ id: 1, quote: VALID_QUOTE }))
    await cowAdapter.fetchQuote({ src: USDC, dst: NATIVE_ETH, amount: '1000000', chainId: 8453 })
    expect(bodies[0].buyToken).toBe(BASE_WETH)
  })

  it('ERC20→ERC20 is unchanged on Base (no native mapping applied)', async () => {
    const bodies = captureBodies(() => json({ id: 1, quote: VALID_QUOTE }))
    await cowAdapter.fetchQuote({ src: USDC, dst: BASE_WETH, amount: '1000000', chainId: 8453 })
    expect(bodies[0].sellToken).toBe(USDC)
    expect(bodies[0].buyToken).toBe(BASE_WETH)
  })
})

describe('pollCowOrderStatus — poll fetches are time-bounded [RQ-2026-06-11]', () => {
  it('a hanging status fetch cannot stall the poll: resolves expired by the deadline', async () => {
    vi.useFakeTimers()
    try {
      // Upstream hangs forever (stalled connection) — the per-poll timeout must
      // bound each request so the loop still terminates at maxWaitMs.
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never settles */ })))

      const poll = pollCowOrderStatus('0x' + 'ee'.repeat(56), 10_000)
      // Drive well past maxWaitMs (covers per-poll timeouts + sleeps).
      await vi.advanceTimersByTimeAsync(60_000)

      const result = await Promise.race([
        poll,
        Promise.resolve('STILL_HANGING' as const),
      ])
      expect(result).toEqual({ status: 'expired' })
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})


// [fix/user-ip-privacy A76 S-1] submitCowOrder / pollCowOrderStatus run in the BROWSER (useSwap, v1 and v2, after the
// wallet signed). They must talk to our own origin only: the site's CSP has no CoW host, and a direct call to
// api.cow.fi hands CoW the visitor's IP. Before this fix both called `${getCowApiBase(chainId)}/…`.
describe('CoW submit + poll go through /api/cow/*, never api.cow.fi [A76 S-1]', () => {
  const UID = '0x' + 'cd'.repeat(56)
  const ORDER = {
    ...VALID_QUOTE,
    sellToken: VALID_QUOTE.sellToken as `0x${string}`,
    buyToken: VALID_QUOTE.buyToken as `0x${string}`,
    appDataHash: VALID_QUOTE.appDataHash as `0x${string}`,
    receiver: VALID_QUOTE.receiver as `0x${string}`,
    kind: 'sell' as const,
    sellTokenBalance: 'erc20' as const,
    buyTokenBalance: 'erc20' as const,
    from: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    quoteId: 7,
    signingScheme: 'eip712' as const,
  }
  afterEach(() => vi.restoreAllMocks())

  it.each([1, 8453, 42161])('chain %i: the signed order is POSTed to /api/cow/orders?chainId=<chain>', async (chainId) => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(UID), { status: 201 }))
    await expect(submitCowOrder(ORDER, '0x' + '1'.repeat(130), chainId)).resolves.toBe(UID)
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/cow/orders?chainId=${chainId}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({ signature: '0x' + '1'.repeat(130), from: ORDER.from, quoteId: 7 })
  })

  it("a rejected submit keeps CoW's description in the error", async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errorType: 'InsufficientBalance', description: 'order owner must have funds' }), { status: 400 }))
    await expect(submitCowOrder(ORDER, '0x' + '1'.repeat(130), 8453)).rejects.toThrow('CoW order submit 400: order owner must have funds')
  })

  it('the poll reads /api/cow/order-status, then /api/cow/trades once filled', async () => {
    const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input) =>
      String(input).startsWith('/api/cow/order-status')
        ? new Response(JSON.stringify({ status: 'fulfilled' }), { status: 200 })
        : new Response(JSON.stringify([{ txHash: '0xabc', executedBuyAmount: '42' }]), { status: 200 }),
    )
    await expect(pollCowOrderStatus(UID, 10_000, 42161)).resolves.toEqual({ status: 'fulfilled', txHash: '0xabc', executedBuyAmount: '42' })
    const urls = spy.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual([`/api/cow/order-status?chainId=42161&uid=${UID}`, `/api/cow/trades?chainId=42161&orderUid=${UID}`])
    for (const u of urls) expect(u).not.toMatch(/cow\.fi|^https?:/)
  })
})

describe('cow adapter — 429 Retry-After reaches the circuit breaker (fix/monitor-self-source-alerts)', () => {
  const SELL = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const BUY = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  const reply429 = (headers: Record<string, string>) =>
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ description: 'rate limited' }), { status: 429, headers: { 'Content-Type': 'application/json', ...headers } }),
    )

  afterEach(() => vi.restoreAllMocks())

  it('embeds retryAfterMs=<n> when CoW sends Retry-After (seconds)', async () => {
    reply429({ 'Retry-After': '45' })
    await expect(cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' })).rejects.toThrow(/CoW 429.*retryAfterMs=45000/)
  })

  it('the breaker then backs off for exactly that long, not the fixed 5-minute fallback', async () => {
    const { CircuitBreaker, classifyFailure } = await import('./circuit-breaker')
    reply429({ 'Retry-After': '45' })
    const err = await cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' }).catch((e: unknown) => e)
    expect(classifyFailure(err)).toMatchObject({ status: 429, retryAfterMs: 45_000 })
    const cb = new CircuitBreaker('cowswap')
    cb.onFailure(err)
    expect(cb.getInfo().cooldownRemaining).toBeLessThanOrEqual(45_000)
    expect(cb.getInfo().cooldownRemaining).toBeGreaterThan(40_000)
  })

  it('no Retry-After header: message unchanged, breaker keeps its fixed rate-limit cooldown', async () => {
    reply429({})
    const err = await cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' }).catch((e: unknown) => e)
    expect((err as Error).message).not.toContain('retryAfterMs')
    expect((err as Error).message).toContain('CoW 429')
  })

  it('a non-numeric Retry-After (HTTP-date) is ignored, never NaN', async () => {
    reply429({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' })
    const err = await cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' }).catch((e: unknown) => e)
    expect((err as Error).message).not.toContain('retryAfterMs')
  })
})


describe('cow adapter — the first 429 of the process is logged ONCE, structured [feat/retire-force-mev C3]', () => {
  const SELL = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const BUY = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  const body = JSON.stringify({ errorType: 'RateLimited', description: 'x'.repeat(400) })
  const reply = () =>
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(body, {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30', 'X-RateLimit-Limit': '10', 'RateLimit-Policy': '10;w=1', 'CF-Ray': '8d1-FRA', Server: 'cloudflare', 'X-Api-Key-Echo': 'should-not-appear' },
      }),
    )
  const firstLines = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('cow_quote_429_first'))

  beforeEach(() => __resetCow429LogForTests())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('one JSON line: status, Retry-After, the allowlisted rate-limit/cf-ray/server headers, region, ≤ 200 body chars', async () => {
    vi.stubEnv('VERCEL_REGION', 'iad1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reply()
    await expect(cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' })).rejects.toThrow(/CoW 429/)
    const lines = firstLines(warn)
    expect(lines).toHaveLength(1)
    const j = JSON.parse(lines[0])
    expect(j).toMatchObject({ event: 'cow_quote_429_first', status: 429, retryAfter: '30', region: 'iad1', endpoint: 'https://api.cow.fi/mainnet/api/v1/quote' })
    expect(j.headers).toEqual({ 'retry-after': '30', 'x-ratelimit-limit': '10', 'ratelimit-policy': '10;w=1', 'cf-ray': '8d1-FRA', server: 'cloudflare' })
    expect(j.body).toHaveLength(200)
    expect(lines[0]).not.toContain('should-not-appear') // only allowlisted response headers; nothing from the request
  })

  it('a second 429 in the same process logs nothing more', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reply()
    await cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' }).catch(() => {})
    await cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' }).catch(() => {})
    expect(firstLines(warn)).toHaveLength(1)
  })

  it('the request shape is unchanged: POST <base>/quote, headers Content-Type + Accept only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spy = reply()
    await cowAdapter.fetchQuote({ src: SELL, dst: BUY, amount: '1000000' }).catch(() => {})
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.cow.fi/mainnet/api/v1/quote')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(
      ['appData', 'buyToken', 'buyTokenBalance', 'from', 'kind', 'partiallyFillable', 'sellAmountBeforeFee', 'sellToken', 'sellTokenBalance', 'signingScheme'].sort(),
    )
  })
})
