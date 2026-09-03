// @vitest-environment node
/**
 * [SPRINT-9E P3, superseded by ADR-021] 0x uses the v2 ALLOWANCE-HOLDER flow on
 * EVERY chain, so the returned tx.to is always the AllowanceHolder
 * (0x0000000000001fF3684f28c67538d4D072C22734) — the address whitelisted for 0x on
 * 1/8453/42161 in chains/routers.ts. The permit2 endpoint returns a Settler tx.to
 * that rotates with each 0x release and can never be whitelisted; mainnet was the
 * last chain still on it, which is why its execution failed in production
 * 2026-09-03. Endpoint-family coverage lives in zerox.v2-execution-path.test.ts.
 *
 * [fix/zerox-price-endpoint] 0x API v2's /quote endpoints are the firm,
 * signable quote and REQUIRE `taker`
 * (https://docs.0x.org/api-reference/evm-ap-is/swap/permit-2-getquote,
 * https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getquote).
 * The indicative endpoint that does NOT require `taker` is `/price`
 * (https://docs.0x.org/api-reference/evm-ap-is/swap/permit-2-getprice,
 * https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getprice).
 * Since quote-before-wallet (#439) there is never a taker at quote time, so
 * fetchQuote must hit /price, not /quote — the old /quote-without-taker shape
 * was a 400 by construction. `chainId` is REQUIRED on every v2 call per both
 * reference pages above (no mainnet default) — fetchQuote and fetchSwapData
 * both send it unconditionally now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import zerox from './zerox'
import { FEE_RECIPIENT, FEE_BPS, NATIVE_ETH } from '@/lib/constants'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const FROM = '0x1111111111111111111111111111111111111111'
const BASE_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'

let calls: string[]
beforeEach(() => {
  calls = []
  process.env.ZEROX_API_KEY = 'test-0x-key'
  vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const [url] = args as [string]
    calls.push(url)
    return new Response(
      JSON.stringify({
        buyAmount: '1982000000',
        transaction: { to: BASE_ALLOWANCE_HOLDER, data: '0xabc', value: '0', gas: 210000 },
        route: { fills: [{ source: 'Uniswap_V3' }] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
})
afterEach(() => vi.restoreAllMocks())

describe('0x fetchQuote uses the indicative /price endpoint, no taker [fix/zerox-price-endpoint]', () => {
  // [ADR-021] Was '/swap/permit2/price' — mainnet moved to the allowance-holder
  // family so its tx.to is the fixed AllowanceHolder instead of a rotating Settler.
  it('mainnet (chainId 1) hits /swap/allowance-holder/price, with chainId, without taker', async () => {
    await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    expect(calls[0]).toContain('/swap/allowance-holder/price')
    expect(calls[0]).not.toContain('/quote')
    expect(calls[0]).not.toContain('permit2')
    expect(calls[0]).toContain('chainId=1')
    expect(calls[0]).not.toContain('taker=')
  })

  it('Base (chainId 8453) hits /swap/allowance-holder/price, with chainId, without taker', async () => {
    await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 8453 })
    expect(calls[0]).toContain('/swap/allowance-holder/price')
    expect(calls[0]).not.toContain('/quote')
    expect(calls[0]).toContain('chainId=8453')
    expect(calls[0]).not.toContain('taker=')
  })

  it('negative control: the old /quote-without-taker shape is what broke production — asserting the fixed path is NOT /quote proves this test would fail on that shape', async () => {
    await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    // Pre-fix, calls[0] contained '/swap/permit2/quote' with no taker — a 400 by
    // construction (0x v2 /quote requires taker). That shape must never recur.
    expect(calls[0]).not.toMatch(/\/swap\/(permit2|allowance-holder)\/quote/)
  })
})

describe('0x fetchSwapData keeps /quote WITH taker [fix/zerox-price-endpoint]', () => {
  // [ADR-021] Was '/swap/permit2/quote' — see zerox.v2-execution-path.test.ts for
  // why mainnet moved, and for the tx.to/whitelist pin that goes with it.
  it('mainnet (chainId 1) hits /swap/allowance-holder/quote, with chainId and taker', async () => {
    await zerox.fetchSwapData({ src: WETH, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 1 })
    expect(calls[0]).toContain('/swap/allowance-holder/quote')
    expect(calls[0]).not.toContain('permit2')
    expect(calls[0]).toContain('chainId=1')
    expect(calls[0]).toContain(`taker=${FROM}`)
  })

  it('Base (chainId 8453) hits /swap/allowance-holder/quote, with chainId and taker; tx.to = AllowanceHolder', async () => {
    const r = await zerox.fetchSwapData({ src: WETH, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 8453 })
    expect(calls[0]).toContain('/swap/allowance-holder/quote')
    expect(calls[0]).toContain('chainId=8453')
    expect(calls[0]).toContain(`taker=${FROM}`)
    expect(r?.tx?.to?.toLowerCase()).toBe(BASE_ALLOWANCE_HOLDER.toLowerCase())
    expect(r?.toAmount).toBe('1982000000')
  })
})

describe('0x partner fee [SPRINT-9T T1] — present on both /price and /quote', () => {
  for (const chainId of [1, 8453]) {
    it(`fetchQuote (/price) carries swapFeeRecipient/Bps/Token on chain ${chainId}`, async () => {
      await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId })
      expect(calls[0]).toContain(`swapFeeRecipient=${FEE_RECIPIENT}`)
      expect(calls[0]).toContain(`swapFeeBps=${FEE_BPS}`)
      expect(calls[0]).toContain(`swapFeeToken=${WETH}`) // sell side
    })

    it(`fetchSwapData (/quote) carries the SAME fee params on chain ${chainId} (quote == execution)`, async () => {
      await zerox.fetchSwapData({ src: WETH, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId })
      expect(calls[0]).toContain(`swapFeeRecipient=${FEE_RECIPIENT}`)
      expect(calls[0]).toContain(`swapFeeBps=${FEE_BPS}`)
      expect(calls[0]).toContain(`swapFeeToken=${WETH}`)
    })
  }

  it('uses the shared FEE_BPS (10 = 0.1%), not a hardcoded number', () => {
    expect(FEE_BPS).toBe(10)
  })

  it('the normalized toAmount is the 0x buyAmount (already post-fee → honest Compare)', async () => {
    const r = await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    // 0x deducts the swapFee from the sell side, so buyAmount is the post-fee output we surface.
    expect(r?.toAmount).toBe('1982000000')
  })

  // [9T audit fix] 0x v2 requires swapFeeToken to be a collectible ERC-20. Native ETH (the 0xEeee…
  // sentinel) is NOT — so an ETH SELL must charge the fee on the BUY token, not the sell side.
  it('native-ETH SELL charges the fee on the BUY token (sentinel is not a valid 0x fee token)', async () => {
    await zerox.fetchQuote({ src: NATIVE_ETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    expect(calls[0]).toContain(`swapFeeToken=${USDC}`) // buy side
    expect(calls[0]).not.toContain(`swapFeeToken=${NATIVE_ETH}`)
    // still the shared recipient + bps
    expect(calls[0]).toContain(`swapFeeRecipient=${FEE_RECIPIENT}`)
    expect(calls[0]).toContain(`swapFeeBps=${FEE_BPS}`)
  })

  it('native-ETH SELL on swap-build also uses the BUY token (quote == execution)', async () => {
    await zerox.fetchSwapData({ src: NATIVE_ETH, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 8453 })
    expect(calls[0]).toContain(`swapFeeToken=${USDC}`)
  })

  it('ERC-20 SELL keeps the fee on the SELL token (mirrors FeeCollector input charging)', async () => {
    await zerox.fetchSwapData({ src: USDC, dst: WETH, amount: '1000000', from: FROM, slippage: 0.5, chainId: 1 })
    expect(calls[0]).toContain(`swapFeeToken=${USDC}`) // sell side
  })
})

// Fixture reproduces the shape of 0x's own documented example response for
// GET /swap/permit2/price (https://docs.0x.org/api-reference/evm-ap-is/swap/permit-2-getprice),
// with the null placeholder fields the docs show filled in with representative
// values so the mapping is actually exercised end-to-end.
const ZEROX_PRICE_FIXTURE = {
  allowanceTarget: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  blockNumber: '12345678',
  buyAmount: '996500000',
  buyToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  fees: {
    integratorFee: null,
    integratorFees: [{ amount: '1000000000000000', token: '0x4200000000000000000000000000000000000006', type: 'volume' }],
    zeroExFee: null,
    gasFee: null,
  },
  issues: {
    allowance: { actual: '0', spender: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
    balance: { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', actual: '1000000000000000000', expected: '1000000000000000000' },
    simulationIncomplete: false,
    invalidSourcesPassed: [],
  },
  liquidityAvailable: true,
  minBuyAmount: '991536500',
  mode: 'exact-in',
  route: {
    fills: [{ from: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', to: '0xdac17f958d2ee523a2206206994597c13d831ec7', source: 'SolidlyV3', proportionBps: '10000' }],
    tokens: [
      { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' },
      { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT' },
    ],
  },
  sellAmount: '1000000000000000000',
  sellToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  tokenMetadata: {
    buyToken: { buyTaxBps: '0', sellTaxBps: '0', transferTaxBps: '0' },
    sellToken: { buyTaxBps: '0', sellTaxBps: '0', transferTaxBps: '0' },
  },
  totalNetworkFee: '2100000000000000',
  zid: '0x111111111111111111111111',
  // /price has NO `transaction` object (no signable tx for an indicative quote)
  // — the gas estimate is the top-level `gas` field instead.
  gas: '150000',
  gasPrice: '14000000000',
}

describe('0x /price response mapping [fix/zerox-price-endpoint]', () => {
  it('maps buyAmount, route.fills[].source, and the top-level gas field (no transaction object in /price)', async () => {
    vi.restoreAllMocks()
    let capturedUrl = ''
    vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
      const [url] = args as [string]
      capturedUrl = url
      return new Response(JSON.stringify(ZEROX_PRICE_FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const r = await zerox.fetchQuote({ src: USDC, dst: WETH, amount: '1000000000000000000', chainId: 1 })

    expect(capturedUrl).toContain('/swap/allowance-holder/price') // [ADR-021] was permit2
    expect(r?.toAmount).toBe('996500000')
    expect(r?.routes).toEqual(['SolidlyV3'])
    // Never silently 0 — must read the top-level `gas` field since /price has no `transaction`.
    expect(r?.estimatedGas).toBe(150000)
  })
})
