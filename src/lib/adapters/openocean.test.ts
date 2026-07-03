/**
 * [CHORE-QUOTE-SOURCE-FIXES C1] OpenOcean request-amount units.
 *
 * The OpenOcean v4 API takes the sell amount in HUMAN (decimals-adjusted)
 * units and returns amounts in RAW base units — contract verified live on
 * 2026-07-02: `/v4/1/quote?...&amount=100000` (USDC) echoes
 * `inAmount=100000000000` (6-dec base units) and `outAmount` in the out
 * token's base units. The adapter previously passed the internal RAW
 * base-unit string straight through as `amount`, so every quote priced a
 * trade 10^srcDecimals too large (10^6–10^18×). In exactly-2-responder
 * windows the 3×-median outlier filter mathematically cannot trigger
 * (threshold ≥ 1.5× max), so that garbage quote could WIN the displayed
 * best price. These tests pin the units contract at the adapter boundary.
 *
 * Mocking strategy: stub fetch with a scale-aware responder that mirrors
 * the live API — it interprets the requested `amount` as HUMAN units at a
 * fixed reference price and answers in RAW base units — so a mis-scaled
 * request produces a 10^n-off normalized quote and fails the sane-band
 * assertions (they cannot be satisfied by luck).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import openocean from './openocean'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // 6 decimals
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' // 18 decimals
const FROM = '0x1111111111111111111111111111111111111111'

/** WETH/USDC reference price used by the scale-aware mock. */
const USDC_PER_WETH = 3000

let requestedAmounts: string[] = []

/**
 * Mirror the live v4 contract: read `amount` as HUMAN units, quote at the
 * reference price, respond in the out token's RAW base units.
 */
function mockScaleAwareApi(outToken: 'weth' | 'usdc') {
  return vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const url = new URL(String(args[0]))
    const amountParam = url.searchParams.get('amount') ?? ''
    requestedAmounts.push(amountParam)
    const human = Number(amountParam)
    const outHuman = outToken === 'weth' ? human / USDC_PER_WETH : human * USDC_PER_WETH
    // Scale to base units without float overflow: 9 significant fractional
    // digits, then pad the rest with zeros via BigInt exponentiation.
    const outDecimals = outToken === 'weth' ? 18 : 6
    const fracDigits = Math.min(outDecimals, 9)
    const outRaw = BigInt(Math.round(outHuman * 10 ** fracDigits)) * 10n ** BigInt(outDecimals - fracDigits)
    const payload = {
      code: 200,
      data: { outAmount: outRaw.toString(), estimatedGas: '250000', path: undefined },
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

/** Fixed-payload mock for passthrough assertions. */
function mockFixedApi(outAmount: string) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const url = new URL(String(args[0]))
    requestedAmounts.push(url.searchParams.get('amount') ?? '')
    const payload = { code: 200, data: { outAmount, estimatedGas: '250000' } }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

beforeEach(() => {
  requestedAmounts = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openocean adapter — request amount units [CHORE-QUOTE-SOURCE-FIXES C1]', () => {
  it('fetchQuote sends the sell amount in HUMAN units for a 6-dec token (USDC)', async () => {
    mockScaleAwareApi('weth')
    await openocean.fetchQuote({
      src: USDC, dst: WETH,
      amount: '100000000000', // 100,000 USDC in base units
      srcDecimals: 6, dstDecimals: 18,
    })
    expect(requestedAmounts[0]).toBe('100000')
  })

  it('fetchQuote sends the sell amount in HUMAN units for an 18-dec token (WETH)', async () => {
    mockScaleAwareApi('usdc')
    await openocean.fetchQuote({
      src: WETH, dst: USDC,
      amount: '2500000000000000000', // 2.5 WETH in base units
      srcDecimals: 18, dstDecimals: 6,
    })
    expect(requestedAmounts[0]).toBe('2.5')
  })

  it('normalizes a USDC(6)→WETH(18) quote into a sane band of the reference (not 10^n off)', async () => {
    mockScaleAwareApi('weth')
    const quote = await openocean.fetchQuote({
      src: USDC, dst: WETH,
      amount: '100000000000', // 100,000 USDC → expect ~33.333 WETH @ 3000
      srcDecimals: 6, dstDecimals: 18,
    })
    expect(quote).not.toBeNull()
    const out = BigInt(quote!.toAmount)
    expect(out > 33_000_000_000_000_000_000n).toBe(true)  // > 33.0 WETH
    expect(out < 33_700_000_000_000_000_000n).toBe(true)  // < 33.7 WETH
  })

  it('normalizes a WETH(18)→USDC(6) quote into a sane band of the reference (not 10^n off)', async () => {
    mockScaleAwareApi('usdc')
    const quote = await openocean.fetchQuote({
      src: WETH, dst: USDC,
      amount: '2500000000000000000', // 2.5 WETH → expect ~7,500 USDC @ 3000
      srcDecimals: 18, dstDecimals: 6,
    })
    expect(quote).not.toBeNull()
    const out = BigInt(quote!.toAmount)
    expect(out > 7_400_000_000n).toBe(true)  // > 7,400 USDC
    expect(out < 7_600_000_000n).toBe(true)  // < 7,600 USDC
  })

  it('passes the API outAmount through unchanged (response is already base units)', async () => {
    mockFixedApi('33333333333333333333')
    const quote = await openocean.fetchQuote({
      src: USDC, dst: WETH,
      amount: '100000000000',
      srcDecimals: 6, dstDecimals: 18,
    })
    expect(quote!.toAmount).toBe('33333333333333333333')
  })

  it('renders fractional human amounts exactly (sub-1 amount, no trailing zeros)', async () => {
    mockFixedApi('166666666666666666')
    await openocean.fetchQuote({
      src: USDC, dst: WETH,
      amount: '500000', // 0.5 USDC in base units
      srcDecimals: 6, dstDecimals: 18,
    })
    expect(requestedAmounts[0]).toBe('0.5')
  })

  it('fetchSwapData sends the sell amount in HUMAN units too (same API contract)', async () => {
    mockScaleAwareApi('weth')
    const swapPayload = vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
      const url = new URL(String(args[0]))
      requestedAmounts.push(url.searchParams.get('amount') ?? '')
      const payload = {
        code: 200,
        data: { outAmount: '33333333333333333333', estimatedGas: '250000', to: '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64', data: '0xdead', value: '0' },
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await openocean.fetchSwapData({
      src: USDC, dst: WETH,
      amount: '100000000000',
      srcDecimals: 6, dstDecimals: 18,
      from: FROM, slippage: 0.5,
    })
    expect(swapPayload).toHaveBeenCalled()
    expect(requestedAmounts[requestedAmounts.length - 1]).toBe('100000')
  })
})
