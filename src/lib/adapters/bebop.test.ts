// @vitest-environment node
/**
 * [SPRINT-9D / P228] Bebop (JAM aggregation) adapter — chain-aware on Ethereum
 * (1) + Base (8453). Covers per-chain slug URL, quote/swap parsing, server-only
 * auth, partner-fee params, and the fail-closed whitelist security gate; plus
 * the wiring (fee-incompatibility, approval spender = Balance Manager, router
 * whitelist, registry registration).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const SETTLEMENT = '0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6'
const BALANCE_MANAGER = '0xC5a350853E4e36b73EB0C24aaA4b8816C9A3579a'
const SRC = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' // WETH
const DST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
const FROM = '0x1111111111111111111111111111111111111111'

const ENV = ['BEBOP_API_KEY', 'BEBOP_SOURCE'] as const
const saved: Record<string, string | undefined> = {}
let calls: Array<{ url: string; init?: RequestInit }>

function bebopBody(overrides: Record<string, unknown> = {}) {
  return {
    buyTokens: { [DST]: { amount: '2000000000', minimumAmount: '1980000000' } },
    tx: { to: SETTLEMENT, value: '0x0', data: '0xdeadbeef', gas: 210000 },
    settlementAddress: SETTLEMENT,
    approvalTarget: BALANCE_MANAGER,
    gasFee: { usd: 1.23 },
    ...overrides,
  }
}

function mockBebop(body: unknown = bebopBody(), status = 200) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const [url, init] = args as [string, RequestInit?]
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
}

async function loadBebop() {
  vi.resetModules()
  return (await import('./bebop')).default
}

beforeEach(() => {
  calls = []
  for (const k of ENV) saved[k] = process.env[k]
  process.env.BEBOP_API_KEY = 'test-bebop-key'
  process.env.BEBOP_SOURCE = 'teraswap-test'
})
afterEach(() => {
  for (const k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k] }
  vi.restoreAllMocks()
})

describe('bebop adapter — JAM [SPRINT-9D]', () => {
  it('fetchQuote (chainId 1) hits /jam/ethereum/v2/quote with gasless=false and parses buyTokens', async () => {
    mockBebop()
    const bebop = await loadBebop()
    const q = await bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000000000000000000', chainId: 1 })
    expect(calls[0].url).toContain('https://api.bebop.xyz/jam/ethereum/v2/quote')
    expect(calls[0].url).toContain('gasless=false')
    expect(q?.source).toBe('bebop')
    expect(q?.toAmount).toBe('2000000000')
    expect(q?.gasUsd).toBe(1.23)
  })

  it('fetchQuote (chainId 8453) hits /jam/base/v2/quote', async () => {
    mockBebop()
    const bebop = await loadBebop()
    await bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000000000000000000', chainId: 8453 })
    expect(calls[0].url).toContain('https://api.bebop.xyz/jam/base/v2/quote')
  })

  // [SPRINT-9F bug3] Bebop is an RFQ source whose quote endpoint is flaky for
  // some pairs/sizes. A Bebop quote failure must be NON-FATAL — return null so
  // the meta-quote still shows the other sources, instead of surfacing
  // "No valid quotes. Bebop: ..." as the headline error.
  it('fetchQuote returns null on an HTTP error (non-fatal, other sources still quote)', async () => {
    mockBebop({ error: 'upstream' }, 502)
    const bebop = await loadBebop()
    const q = await bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000000000000000000', chainId: 8453 })
    expect(q).toBeNull()
  })

  it('fetchQuote returns null when the response has no buyTokens amount (non-fatal)', async () => {
    mockBebop(bebopBody({ buyTokens: {} }))
    const bebop = await loadBebop()
    const q = await bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000000000000000000', chainId: 1 })
    expect(q).toBeNull()
  })

  it('sends the server-only source-auth header (never a NEXT_PUBLIC key)', async () => {
    mockBebop()
    const bebop = await loadBebop()
    await bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000', chainId: 1 })
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get('source-auth')).toBe('test-bebop-key')
  })

  it('fetchSwapData maps tx (value hex→decimal) and carries our partner-fee params', async () => {
    mockBebop()
    const bebop = await loadBebop()
    const r = await bebop.fetchSwapData({ src: SRC, dst: DST, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 1 })
    expect(r?.tx?.to?.toLowerCase()).toBe(SETTLEMENT.toLowerCase())
    expect(r?.tx?.value).toBe('0') // 0x0 → "0"
    expect(r?.tx?.data).toBe('0xdeadbeef')
    const url = calls[0].url
    expect(url).toContain(`taker_address=${FROM}`)
    expect(url).toMatch(/fee=10\b/)             // FEE_BPS = 10
    expect(url.toLowerCase()).toContain('fee_recipient=')
  })

  it('SECURITY: rejects when tx.to !== settlementAddress (fail closed, no tx)', async () => {
    mockBebop(bebopBody({ tx: { to: '0x000000000000000000000000000000000000dEaD', value: '0x0', data: '0x', gas: 1 } }))
    const bebop = await loadBebop()
    await expect(bebop.fetchSwapData({ src: SRC, dst: DST, amount: '1', from: FROM, slippage: 0.5, chainId: 1 })).rejects.toThrow(/settlement/i)
  })

  it('SECURITY: rejects when approvalTarget is not in our whitelist', async () => {
    mockBebop(bebopBody({ approvalTarget: '0x000000000000000000000000000000000000bEEF' }))
    const bebop = await loadBebop()
    await expect(bebop.fetchSwapData({ src: SRC, dst: DST, amount: '1', from: FROM, slippage: 0.5, chainId: 8453 })).rejects.toThrow(/whitelist/i)
  })

  it('SECURITY: rejects when settlementAddress is not in our whitelist', async () => {
    const rogue = '0x00000000000000000000000000000000000000Ff'
    mockBebop(bebopBody({ settlementAddress: rogue, tx: { to: rogue, value: '0x0', data: '0x', gas: 1 } }))
    const bebop = await loadBebop()
    await expect(bebop.fetchSwapData({ src: SRC, dst: DST, amount: '1', from: FROM, slippage: 0.5, chainId: 1 })).rejects.toThrow(/whitelist/i)
  })
})

describe('bebop wiring [SPRINT-9D]', () => {
  it('is FEE-INCOMPATIBLE on chains 1 and 8453 (FeeCollector path skipped)', async () => {
    const { usesFeeCollector } = await import('@/lib/api')
    const { getFeeIncompatibleSources } = await import('@/lib/chains/activation')
    expect(getFeeIncompatibleSources(1)).toContain('bebop')
    expect(getFeeIncompatibleSources(8453)).toContain('bebop')
    expect(usesFeeCollector('bebop' as never, 1)).toBe(false)
    expect(usesFeeCollector('bebop' as never, 8453)).toBe(false)
  })

  it('approval spender resolves to the Balance Manager (approvalTarget), not the settlement', async () => {
    const { fetchApproveSpender } = await import('@/lib/api')
    expect((await fetchApproveSpender('bebop' as never, 1)).toLowerCase()).toBe(BALANCE_MANAGER.toLowerCase())
    expect((await fetchApproveSpender('bebop' as never, 8453)).toLowerCase()).toBe(BALANCE_MANAGER.toLowerCase())
  })

  it('whitelists BOTH the JAM settlement and Balance Manager on chains 1 and 8453', async () => {
    const { getRouterWhitelist } = await import('@/lib/chains/routers')
    for (const chain of [1, 8453]) {
      const wl = getRouterWhitelist(chain)
      expect(wl).toContain(SETTLEMENT.toLowerCase())
      expect(wl).toContain(BALANCE_MANAGER.toLowerCase())
    }
  })

  it('is registered as the 12th source in ADAPTER_REGISTRY', async () => {
    const { ADAPTER_REGISTRY } = await import('@/lib/adapters')
    const names = ADAPTER_REGISTRY.map((a) => a.name)
    expect(names).toContain('bebop')
    expect(names.length).toBe(12)
  })
})
