/**
 * [SPRINT-ORDER-ENGINE-TESTS #5] Unit tests for the CoW limit-order API helpers.
 *
 * src/lib/limit-order-api.ts had 0% coverage. These tests exercise the pure
 * math (computeBuyAmount), the EIP-712 param builder (buildLimitOrderParams —
 * with a fake timer so validTo is deterministic), and every fetch-backed call
 * (fetchCurrentPrice / submitLimitOrder / fetchLimitOrderStatus / cancelLimitOrder)
 * by stubbing global fetch at the boundary.
 *
 * Mainnet-behaviour assertions (CoW base URL, appData appCode/referrer/orderClass,
 * NATIVE_ETH→WETH resolution, feeAmount '0') are byte-identical to the current code
 * and constants, so a regression in any of these flips a test red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  computeBuyAmount,
  buildLimitOrderParams,
  fetchCurrentPrice,
  submitLimitOrder,
  fetchLimitOrderStatus,
  cancelLimitOrder,
} from './limit-order-api'
import {
  AGGREGATOR_APIS,
  NATIVE_ETH,
  WETH_ADDRESS,
  FEE_RECIPIENT,
} from './constants'
import type { LimitOrderConfig } from './limit-order-types'
import type { Token } from './tokens'

const COW_BASE = AGGREGATOR_APIS.cowswap.base // 'https://api.cow.fi/mainnet/api/v1'

// ── fetch stub helpers ──────────────────────────────────────
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Minimal Response-like object good enough for the code under test. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

// ── Token fixtures ──────────────────────────────────────────
const WETH_TOKEN: Token = {
  address: WETH_ADDRESS,
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const ETH_TOKEN: Token = {
  address: NATIVE_ETH,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const USDC_TOKEN: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}

function makeConfig(overrides: Partial<LimitOrderConfig> = {}): LimitOrderConfig {
  return {
    tokenIn: WETH_TOKEN,
    tokenOut: USDC_TOKEN,
    sellAmount: '1000000000000000000', // 1 WETH
    targetPrice: 2000, // 2000 USDC per WETH
    kind: 'sell',
    expirySeconds: 3600,
    partiallyFillable: true,
    slippage: 0,
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════
// computeBuyAmount
// ════════════════════════════════════════════════════════════
describe('computeBuyAmount', () => {
  it('same decimals (diff 0): no decimal rescale, just price scaling', () => {
    // 1e18 * 2000, 18→18 decimals stays at 18-decimal scale
    expect(computeBuyAmount('1000000000000000000', 2000, 18, 18)).toBe(
      '2000000000000000000000',
    )
  })

  it('passes a unit price straight through when decimals match', () => {
    expect(computeBuyAmount('12345', 1, 18, 18)).toBe('12345')
  })

  it('buyDecimals > sellDecimals: scales UP by 10^diff', () => {
    // 1 USDC (1e6, 6 dec) @ price 1 → 18-dec token: multiply by 10^12
    expect(computeBuyAmount('1000000', 1, 6, 18)).toBe('1000000000000000000')
  })

  it('buyDecimals < sellDecimals: scales DOWN by 10^|diff|', () => {
    // 1 WETH (1e18, 18 dec) @ price 1 → 6-dec token: divide by 10^12
    expect(computeBuyAmount('1000000000000000000', 1, 18, 6)).toBe('1000000')
  })

  it('worked example: 1 WETH @ 2000, 18→6 decimals = 2000 USDC (2000e6)', () => {
    expect(computeBuyAmount('1000000000000000000', 2000, 18, 6)).toBe('2000000000')
  })

  it("sellAmount '0' yields '0' regardless of price/decimals", () => {
    expect(computeBuyAmount('0', 2000, 18, 6)).toBe('0')
  })

  it('large value stays an exact bigint string (no float overflow)', () => {
    // 1e24 wei @ price 1500, 18→18 decimals → 1.5e27, exact
    expect(computeBuyAmount('1000000000000000000000000', 1500, 18, 18)).toBe(
      '1500000000000000000000000000',
    )
  })
})

// ════════════════════════════════════════════════════════════
// buildLimitOrderParams
// ════════════════════════════════════════════════════════════
describe('buildLimitOrderParams', () => {
  const FROM = '0x1111111111111111111111111111111111111111'
  // Pin wall clock so validTo is deterministic: 1_700_000_000_000 ms ⇒ 1_700_000_000 s
  const FIXED_NOW_MS = 1_700_000_000_000
  const FIXED_NOW_S = 1_700_000_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW_MS)
  })

  it('resolves NATIVE_ETH tokenIn to WETH_ADDRESS for sellToken', () => {
    const params = buildLimitOrderParams(makeConfig({ tokenIn: ETH_TOKEN }), FROM)
    expect(params.sellToken).toBe(WETH_ADDRESS)
  })

  it('resolves NATIVE_ETH tokenOut to WETH_ADDRESS for buyToken', () => {
    const params = buildLimitOrderParams(
      makeConfig({ tokenIn: USDC_TOKEN, tokenOut: ETH_TOKEN }),
      FROM,
    )
    expect(params.buyToken).toBe(WETH_ADDRESS)
  })

  it('leaves a non-ETH token address unchanged (WETH passthrough)', () => {
    const params = buildLimitOrderParams(makeConfig(), FROM)
    expect(params.sellToken).toBe(WETH_ADDRESS)
    expect(params.buyToken).toBe(USDC_TOKEN.address)
  })

  it('receiver equals the from address', () => {
    const params = buildLimitOrderParams(makeConfig(), FROM)
    expect(params.receiver).toBe(FROM)
    expect(params.from).toBe(FROM)
  })

  it('sellAmount passes through unchanged', () => {
    const params = buildLimitOrderParams(makeConfig({ sellAmount: '777' }), FROM)
    expect(params.sellAmount).toBe('777')
  })

  it('buyAmount equals computeBuyAmount(sellAmount, price, inDec, outDec)', () => {
    const config = makeConfig() // 1 WETH @ 2000, 18→6
    const params = buildLimitOrderParams(config, FROM)
    expect(params.buyAmount).toBe(
      computeBuyAmount(
        config.sellAmount,
        config.targetPrice,
        config.tokenIn.decimals,
        config.tokenOut.decimals,
      ),
    )
    // and that concrete value is 2000 USDC
    expect(params.buyAmount).toBe('2000000000')
  })

  it('validTo = floor(now/1000) + expirySeconds (deterministic with fake timer)', () => {
    const params = buildLimitOrderParams(makeConfig({ expirySeconds: 3600 }), FROM)
    expect(params.validTo).toBe(FIXED_NOW_S + 3600)
  })

  it("feeAmount is always '0' (CoW limit orders are zero-fee)", () => {
    const params = buildLimitOrderParams(makeConfig(), FROM)
    expect(params.feeAmount).toBe('0')
  })

  it('appData JSON encodes TeraSwap appCode, FEE_RECIPIENT referrer, and limit orderClass', () => {
    const params = buildLimitOrderParams(makeConfig(), FROM)
    const appData = JSON.parse(params.appData)
    expect(appData.appCode).toBe('TeraSwap')
    expect(appData.metadata.referrer.address).toBe(FEE_RECIPIENT)
    expect(appData.metadata.orderClass.orderClass).toBe('limit')
  })

  it('kind and partiallyFillable pass through from config', () => {
    const params = buildLimitOrderParams(
      makeConfig({ kind: 'buy', partiallyFillable: false }),
      FROM,
    )
    expect(params.kind).toBe('buy')
    expect(params.partiallyFillable).toBe(false)
  })

  it('sets erc20 token balances and eip712 signing scheme', () => {
    const params = buildLimitOrderParams(makeConfig(), FROM)
    expect(params.sellTokenBalance).toBe('erc20')
    expect(params.buyTokenBalance).toBe('erc20')
    expect(params.signingScheme).toBe('eip712')
  })
})

// ════════════════════════════════════════════════════════════
// fetchCurrentPrice
// ════════════════════════════════════════════════════════════
describe('fetchCurrentPrice', () => {
  it('POSTs to `${COW_BASE}/quote` and normalizes buyAmount/sellAmount by decimals', async () => {
    // sell 1 WETH (1e18, 18 dec), quote buy 2000 USDC (2000e6, 6 dec) ⇒ price 2000
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ quote: { buyAmount: '2000000000' } }),
    )
    const price = await fetchCurrentPrice(
      WETH_ADDRESS,
      USDC_TOKEN.address,
      '1000000000000000000',
      18,
      6,
    )
    expect(price).toBe(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${COW_BASE}/quote`)
    expect(init.method).toBe('POST')
  })

  it('resolves NATIVE_ETH sell/buy tokens to WETH in the request body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ quote: { buyAmount: '1000000000000000000' } }),
    )
    await fetchCurrentPrice(NATIVE_ETH, NATIVE_ETH, '1000000000000000000', 18, 18)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.sellToken).toBe(WETH_ADDRESS)
    expect(body.buyToken).toBe(WETH_ADDRESS)
  })

  it('returns 0 when res.ok is false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500))
    const price = await fetchCurrentPrice(
      WETH_ADDRESS,
      USDC_TOKEN.address,
      '1000000000000000000',
      18,
      6,
    )
    expect(price).toBe(0)
  })

  it('returns 0 when quote.buyAmount is missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ quote: {} }))
    const price = await fetchCurrentPrice(
      WETH_ADDRESS,
      USDC_TOKEN.address,
      '1000000000000000000',
      18,
      6,
    )
    expect(price).toBe(0)
  })

  it('computes a sub-1 price for a USDC→WETH direction', async () => {
    // sell 2000 USDC (2000e6, 6 dec), buy 1 WETH (1e18, 18 dec) ⇒ price 1/2000 = 0.0005
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ quote: { buyAmount: '1000000000000000000' } }),
    )
    const price = await fetchCurrentPrice(
      USDC_TOKEN.address,
      WETH_ADDRESS,
      '2000000000',
      6,
      18,
    )
    expect(price).toBeCloseTo(0.0005, 12)
  })
})

// ════════════════════════════════════════════════════════════
// submitLimitOrder
// ════════════════════════════════════════════════════════════
describe('submitLimitOrder', () => {
  const ORDER_PARAMS = {
    sellToken: WETH_ADDRESS,
    buyToken: USDC_TOKEN.address,
    receiver: '0x1111111111111111111111111111111111111111',
    sellAmount: '1000000000000000000',
    buyAmount: '2000000000',
    validTo: 1_700_003_600,
    appData: '{}',
    appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: true,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    from: '0x1111111111111111111111111111111111111111',
    signingScheme: 'eip712',
  } as ReturnType<typeof buildLimitOrderParams>

  it('POSTs to `${COW_BASE}/orders` and returns the parsed uid on ok', async () => {
    const UID =
      '0xabc1230000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
    fetchMock.mockResolvedValueOnce(jsonResponse(UID))
    const uid = await submitLimitOrder(ORDER_PARAMS, '0xsig')
    expect(uid).toBe(UID)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${COW_BASE}/orders`)
    expect(init.method).toBe('POST')
    // signature is attached to the submitted body
    expect(JSON.parse(init.body).signature).toBe('0xsig')
  })

  it('throws an Error containing the HTTP status when !ok', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ description: 'bad order' }, false, 400),
    )
    await expect(submitLimitOrder(ORDER_PARAMS, '0xsig')).rejects.toThrow(/400/)
  })

  it('surfaces the API description in the thrown message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ description: 'InsufficientAllowance' }, false, 400),
    )
    await expect(submitLimitOrder(ORDER_PARAMS, '0xsig')).rejects.toThrow(
      /InsufficientAllowance/,
    )
  })
})

// ════════════════════════════════════════════════════════════
// fetchLimitOrderStatus
// ════════════════════════════════════════════════════════════
describe('fetchLimitOrderStatus', () => {
  const UID = '0xdeadbeef'

  it('computes filledPercent = executedSell/totalSell*100 for an open order', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 'open',
        sellAmount: '1000000000000000000',
        executedSellAmount: '250000000000000000', // 25%
        executedBuyAmount: '500000000',
      }),
    )
    const res = await fetchLimitOrderStatus(UID)
    expect(res.status).toBe('open')
    expect(res.filledPercent).toBe(25)
    expect(res.executedSellAmount).toBe('250000000000000000')
    expect(res.executedBuyAmount).toBe('500000000')
    expect(res.txHash).toBeUndefined()
    // only the status endpoint is hit for a non-fulfilled order
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${COW_BASE}/orders/${UID}`)
  })

  it('filledPercent is 0 when totalSell is 0 (no divide-by-zero)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 'open', sellAmount: '0', executedSellAmount: '0' }),
    )
    const res = await fetchLimitOrderStatus(UID)
    expect(res.filledPercent).toBe(0)
  })

  it("a 'fulfilled' order also fetches /trades and returns the settlement txHash", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'fulfilled',
          sellAmount: '1000000000000000000',
          executedSellAmount: '1000000000000000000', // 100%
          executedBuyAmount: '2000000000',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ txHash: '0xsettlement' }]))
    const res = await fetchLimitOrderStatus(UID)
    expect(res.status).toBe('fulfilled')
    expect(res.filledPercent).toBe(100)
    expect(res.txHash).toBe('0xsettlement')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(`${COW_BASE}/trades?orderUid=${UID}`)
  })

  it('fulfilled order leaves txHash undefined when the trades fetch is not ok', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'fulfilled',
          sellAmount: '1000000000000000000',
          executedSellAmount: '1000000000000000000',
          executedBuyAmount: '2000000000',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([], false, 503))
    const res = await fetchLimitOrderStatus(UID)
    expect(res.txHash).toBeUndefined()
  })

  it('throws an Error containing the status when the order fetch is not ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404))
    await expect(fetchLimitOrderStatus(UID)).rejects.toThrow(/404/)
  })
})

// ════════════════════════════════════════════════════════════
// cancelLimitOrder
// ════════════════════════════════════════════════════════════
describe('cancelLimitOrder', () => {
  const UID = '0xfeedface'

  it('DELETEs `${COW_BASE}/orders/${uid}` and resolves on ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}))
    await expect(cancelLimitOrder(UID, '0xsig')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${COW_BASE}/orders/${UID}`)
    expect(init.method).toBe('DELETE')
    const body = JSON.parse(init.body)
    expect(body.signature).toBe('0xsig')
    expect(body.orderUids).toEqual([UID])
  })

  it('throws an Error containing the status when !ok', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ description: 'not your order' }, false, 401),
    )
    await expect(cancelLimitOrder(UID, '0xsig')).rejects.toThrow(/401/)
  })
})
