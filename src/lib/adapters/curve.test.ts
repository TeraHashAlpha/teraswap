// @vitest-environment node
/**
 * [SPRINT-9C] curve must be chain-aware. Its pools/router are mainnet-only in
 * code, so off mainnet it MUST cleanly return null and issue ZERO RPC calls —
 * never quote a mainnet pool for an L2 request. Mainnet stays unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'
import curve from './curve'

const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const CURVE_ROUTER_NG = '0x16C6521Dff6baB339122a0FE25a9116693265353'
const FROM = '0x1111111111111111111111111111111111111111'

let calls: Array<{ url: string; body: { id?: number; params?: Array<{ to?: string }> } }>
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  calls = []
  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const [url, init] = args as [string, RequestInit?]
    const body = init?.body ? JSON.parse(init.body as string) : {}
    calls.push({ url, body })
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
})
afterEach(() => vi.restoreAllMocks())

describe('curve chain-aware skip [SPRINT-9C]', () => {
  it('chainId 8453: fetchQuote returns null and makes ZERO RPC calls', async () => {
    const res = await curve.fetchQuote({ src: DAI, dst: USDC, amount: '1000000000000000000', chainId: 8453 })
    expect(res).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('chainId 8453: fetchSwapData returns null and makes ZERO RPC calls', async () => {
    const res = await curve.fetchSwapData({ src: DAI, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 8453 })
    expect(res).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('mainnet (chainId 1): quotes via the mainnet CurveRouterNG — unchanged', async () => {
    const res = await curve.fetchQuote({ src: DAI, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    expect(res?.source).toBe('curve')
    expect(calls.length).toBeGreaterThan(0)
    expect((calls[0].body.params![0].to as string).toLowerCase()).toBe(CURVE_ROUTER_NG.toLowerCase())
  })

  it('omitted chainId defaults to mainnet — unchanged', async () => {
    const res = await curve.fetchQuote({ src: DAI, dst: USDC, amount: '1000000000000000000' })
    expect(res?.source).toBe('curve')
    expect(calls.length).toBeGreaterThan(0)
  })
})
