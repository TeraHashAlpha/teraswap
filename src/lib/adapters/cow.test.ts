/**
 * Unit tests for src/lib/adapters/cow.ts — [11-L-02] validator ordering.
 *
 * Pins that parseCowOrderParams validates the CoW /quote response BEFORE
 * any BigInt() conversion happens. Previously, BigInt(quote.buyAmount) ran
 * first and could throw a raw SyntaxError on a non-numeric buyAmount; now
 * the validator rejects first with a tagged error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import cowAdapter from './cow'
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
