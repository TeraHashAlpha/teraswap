// @vitest-environment node
/**
 * [SPRINT-9E P3] 0x must be chain-aware. On mainnet it uses the v2 permit2 flow
 * (byte-identical). On Base it must use the v2 ALLOWANCE-HOLDER flow so the
 * returned tx.to is the AllowanceHolder (0x0000000000001fF3684f28c67538d4D072C22734)
 * — the address whitelisted for 0x on Base in chains/routers.ts. The permit2
 * endpoint returns a Settler/Permit2 tx.to that would fail the Base whitelist.
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

describe('0x chain-aware endpoint [SPRINT-9E]', () => {
  it('mainnet (chainId 1) uses the permit2 quote endpoint, no chainId param — byte-identical', async () => {
    await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    expect(calls[0]).toContain('/swap/permit2/quote')
    expect(calls[0]).not.toContain('allowance-holder')
    expect(calls[0]).not.toContain('chainId=')
  })

  it('Base (chainId 8453) uses the allowance-holder quote endpoint + chainId param', async () => {
    await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 8453 })
    expect(calls[0]).toContain('/swap/allowance-holder/quote')
    expect(calls[0]).toContain('chainId=8453')
  })

  it('Base swap returns tx.to = AllowanceHolder via the allowance-holder endpoint', async () => {
    const r = await zerox.fetchSwapData({ src: WETH, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 8453 })
    expect(calls[0]).toContain('/swap/allowance-holder/quote')
    expect(r?.tx?.to?.toLowerCase()).toBe(BASE_ALLOWANCE_HOLDER.toLowerCase())
    expect(r?.toAmount).toBe('1982000000')
  })
})

describe('0x partner fee [SPRINT-9T T1]', () => {
  // swapFeeToken is the SELL token (mirrors FeeCollector charging on input); the shared FEE_BPS
  // constant (not a magic number) at the shared FEE_RECIPIENT.
  for (const chainId of [1, 8453]) {
    it(`fetchQuote carries swapFeeRecipient/Bps/Token on chain ${chainId}`, async () => {
      await zerox.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId })
      expect(calls[0]).toContain(`swapFeeRecipient=${FEE_RECIPIENT}`)
      expect(calls[0]).toContain(`swapFeeBps=${FEE_BPS}`)
      expect(calls[0]).toContain(`swapFeeToken=${WETH}`) // sell side
    })

    it(`fetchSwapData carries the SAME fee params on chain ${chainId} (quote == execution)`, async () => {
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
