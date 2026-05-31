// @vitest-environment node
/**
 * [SPRINT-9C] uniswapv3 must be chain-aware: on Base it must eth_call the BASE
 * QuoterV2 over the BASE RPC (never the mainnet Quoter/RPC), and its swap
 * calldata must target the Base SwapRouter02. Mainnet (chainId 1) stays
 * byte-identical (mainnet Quoter + mainnet RPC + mainnet Router).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'

// Verified on Basescan + developers.uniswap.org base-deployments (May 2026).
const MAINNET_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
const BASE_QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'
const MAINNET_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
const BASE_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const FROM = '0x1111111111111111111111111111111111111111'

// A valid QuoterV2.quoteExactInputSingle result: (amountOut, sqrtAfter, ticks, gas).
const QUOTER_RESULT = encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
  [123_456_789n, 0n, 1, 50_000n],
)

const ENV = ['RPC_URL', 'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL'] as const
const saved: Record<string, string | undefined> = {}
let calls: Array<{ url: string; body: { id?: number; params?: Array<{ to?: string; data?: string }> } }>

function mockRpc() {
  return vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const [url, init] = args as [string, RequestInit?]
    const body = init?.body ? JSON.parse(init.body as string) : {}
    calls.push({ url, body })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: QUOTER_RESULT }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
}

async function loadUniswap() {
  vi.resetModules()
  return (await import('./uniswapv3')).default
}

beforeEach(() => {
  calls = []
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
  process.env.RPC_URL = 'https://eth.mainnet.test'
  process.env.NEXT_PUBLIC_BASE_RPC_URL = 'https://base.rpc.test'
})
afterEach(() => {
  for (const k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k] }
  vi.restoreAllMocks()
})

describe('uniswapv3 chain-aware [SPRINT-9C]', () => {
  it('mainnet (chainId 1): targets the mainnet Quoter over the mainnet RPC — byte-identical', async () => {
    mockRpc()
    const adapter = await loadUniswap()
    await adapter.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 1 })
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.url).toBe('https://eth.mainnet.test')
      expect((c.body.params![0].to as string).toLowerCase()).toBe(MAINNET_QUOTER.toLowerCase())
    }
  })

  it('Base (chainId 8453): targets the Base Quoter over the Base RPC — never mainnet', async () => {
    mockRpc()
    const adapter = await loadUniswap()
    await adapter.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 8453 })
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.url).toBe('https://base.rpc.test')
      expect(c.url).not.toContain('eth.mainnet.test')
      expect((c.body.params![0].to as string).toLowerCase()).toBe(BASE_QUOTER.toLowerCase())
    }
  })

  it('omitted chainId defaults to mainnet — byte-identical', async () => {
    mockRpc()
    const adapter = await loadUniswap()
    await adapter.fetchQuote({ src: WETH, dst: USDC, amount: '1000000000000000000' })
    for (const c of calls) {
      expect(c.url).toBe('https://eth.mainnet.test')
      expect((c.body.params![0].to as string).toLowerCase()).toBe(MAINNET_QUOTER.toLowerCase())
    }
  })

  it('Base swap calldata targets the Base SwapRouter02', async () => {
    mockRpc()
    const adapter = await loadUniswap()
    const res = await adapter.fetchSwapData({ src: WETH, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 8453 })
    expect(res?.tx?.to?.toLowerCase()).toBe(BASE_ROUTER.toLowerCase())
  })

  it('mainnet swap calldata targets the mainnet SwapRouter02 — byte-identical', async () => {
    mockRpc()
    const adapter = await loadUniswap()
    const res = await adapter.fetchSwapData({ src: WETH, dst: USDC, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 1 })
    expect(res?.tx?.to?.toLowerCase()).toBe(MAINNET_ROUTER.toLowerCase())
  })
})
