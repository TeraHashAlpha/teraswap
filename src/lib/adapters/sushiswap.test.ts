/**
 * [CHORE-SUSHI-V7-REDSNWAPPER-QUOTE-FIX] Sushi v7 `sender` request contract.
 *
 * The Sushi v7 API (api.sushi.com/swap/v7/{chainId}) REQUIRES a `sender`
 * query param — without it every request 422s ("Invalid input: expected
 * string, received undefined", parameter: "sender"), which is why Sushi
 * produced 0 production quotes (T-SAF W7-followup, silent-sources
 * investigation). Probed live 2026-07-03: any valid address is accepted and
 * the quoted amount is sender-independent; the value that matters at
 * EXECUTION time is the account that calls the router — the chain's
 * FeeCollector in TeraSwap's fee-routed flow.
 *
 * Contract pinned here:
 *   - quote + swap requests ALWAYS carry a non-empty `sender`
 *   - sender = the chain's FeeCollector when configured (mainnet)
 *   - chains without a FeeCollector in config fall back to the zero address
 *     for quotes (probed: accepted) and to the user for swap builds
 *   - a non-empty route (assumedAmountOut) normalizes per chain
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sushiswap from './sushiswap'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'

const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USER = '0x1111111111111111111111111111111111111111'
const ZERO = '0x0000000000000000000000000000000000000000'
const REDSNWAPPER = '0xAC4c6e212A361c968F1725b4d055b47E63F80b75'

let requests: URL[] = []

/** Mirror the live v7 response shape (probed 2026-07-03). */
function mockSushiApi() {
  return vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const url = new URL(String(args[0]))
    requests.push(url)
    // The live API 422s when sender is absent — mirror it so a regression
    // to the old request shape fails these tests the same way it fails prod.
    if (!url.searchParams.get('sender')) {
      return new Response(
        JSON.stringify({ status: 422, title: 'Validation Error', errors: [{ parameter: 'sender', detail: 'Invalid input: expected string, received undefined' }] }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const payload = {
      status: 'Success',
      assumedAmountOut: '1715835838',
      gasSpent: 240000,
      routeProcessorArgs: {
        to: REDSNWAPPER,
        data: '0x5f3bd1c8' + 'ab'.repeat(64),
        value: '0',
      },
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

beforeEach(() => {
  requests = []
  mockSushiApi()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sushiswap adapter — v7 sender contract [CHORE-SUSHI-V7]', () => {
  it('fetchQuote sends the mainnet FeeCollector as sender (chain 1)', async () => {
    const quote = await sushiswap.fetchQuote({
      src: WETH_MAINNET, dst: USDC_MAINNET,
      amount: '1000000000000000000', srcDecimals: 18, dstDecimals: 6,
      chainId: 1,
    })
    expect(requests[0].searchParams.get('sender')).toBe(FEE_COLLECTOR_ADDRESS)
    expect(quote).not.toBeNull()
    expect(BigInt(quote!.toAmount) > 0n).toBe(true) // non-empty route, chain 1
  })

  it('fetchQuote on Base still sends a non-empty sender (zero-address fallback when no FC in env)', async () => {
    // In the test env NEXT_PUBLIC_BASE_FEE_COLLECTOR is unset → registry
    // feeCollector is null → the adapter must still send a valid sender
    // (the live API accepts the zero address; probed 2026-07-03).
    const quote = await sushiswap.fetchQuote({
      src: WETH_BASE, dst: USDC_BASE,
      amount: '1000000000000000000', srcDecimals: 18, dstDecimals: 6,
      chainId: 8453,
    })
    const sender = requests[0].searchParams.get('sender')
    expect(sender).toBeTruthy()
    expect(sender).toBe(ZERO)
    expect(requests[0].pathname).toContain('/swap/v7/8453')
    expect(quote).not.toBeNull()
    expect(BigInt(quote!.toAmount) > 0n).toBe(true) // non-empty route, chain 8453
  })

  it('fetchSwapData sends sender too (FeeCollector on mainnet — the account that calls the router)', async () => {
    const swap = await sushiswap.fetchSwapData({
      src: WETH_MAINNET, dst: USDC_MAINNET,
      amount: '1000000000000000000', srcDecimals: 18, dstDecimals: 6,
      chainId: 1, from: USER, slippage: 0.5,
    })
    expect(requests[0].searchParams.get('sender')).toBe(FEE_COLLECTOR_ADDRESS)
    // Output destination stays the user (unchanged from before).
    expect(requests[0].searchParams.get('to')).toBe(USER)
    expect(swap?.tx?.to.toLowerCase()).toBe(REDSNWAPPER.toLowerCase())
  })

  it('fetchSwapData on a chain without a FeeCollector falls back to the user as sender', async () => {
    await sushiswap.fetchSwapData({
      src: WETH_BASE, dst: USDC_BASE,
      amount: '1000000000000000000', srcDecimals: 18, dstDecimals: 6,
      chainId: 8453, from: USER, slippage: 0.5,
    })
    expect(requests[0].searchParams.get('sender')).toBe(USER)
  })
})
