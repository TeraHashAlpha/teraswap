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

  // [SPRINT-9F bug3] A no-ROUTE (empty/missing buyTokens) is NON-FATAL: return
  // null so Bebop is simply absent and the other sources still surface, instead
  // of "No valid quotes. Bebop: no buyTokens amount" headlining when Bebop is
  // the lone rejection. But a real upstream FAILURE (HTTP/parse) must still THROW
  // so the circuit breaker trips and source-monitoring records the error — same
  // contract as every other adapter (verified by the adversarial review).
  it('fetchQuote returns null when the response has no buyTokens amount (non-fatal no-route)', async () => {
    mockBebop(bebopBody({ buyTokens: {} }))
    const bebop = await loadBebop()
    const q = await bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000000000000000000', chainId: 1 })
    expect(q).toBeNull()
  })

  it('fetchQuote THROWS on an HTTP error so the circuit breaker + monitoring still work', async () => {
    mockBebop({ error: 'upstream' }, 502)
    const bebop = await loadBebop()
    await expect(
      bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000000000000000000', chainId: 8453 }),
    ).rejects.toThrow(/502/)
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

  // [SPRINT-9F bug3 re-review] The firm/executable path is asymmetric to fetchQuote:
  // a no-route (empty buyTokens) is NON-FATAL for fetchQuote (returns null) but a
  // HARD error for fetchSwapData (a quote about to be executed MUST carry an amount).
  // The security gates pass here (valid settlement + whitelisted), so the throw can
  // only come from the firm-quote integrity check (bebop.ts:133), not an earlier
  // gate — the /no buyTokens amount/ matcher pins that exact path. Closes the
  // execution-path coverage gap the adversarial review flagged (MEDIUM).
  it('fetchSwapData THROWS on empty buyTokens — a firm quote MUST carry an amount [SPRINT-9F bug3]', async () => {
    mockBebop(bebopBody({ buyTokens: {} }))
    const bebop = await loadBebop()
    await expect(
      bebop.fetchSwapData({ src: SRC, dst: DST, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 1 }),
    ).rejects.toThrow(/no buyTokens amount/)
  })

  // [SPRINT-9H] Fail-soft on a JAM response that lacks executable settlement
  // fields (e.g. demo-mode without BEBOP_API_KEY). This is "no executable quote",
  // NOT a hard error: return null (breaker-NEUTRAL) so it never surfaces as the
  // "incomplete settlement data in response" failure seen on the 9G Preview.
  // Distinct from the SECURITY rejects above (present-but-wrong → still throw).
  it('fetchSwapData returns null (fail-soft) when settlement fields are absent [SPRINT-9H]', async () => {
    // A price-only JAM response: buyTokens amount present, but NO settlementAddress
    // / approvalTarget / tx — exactly the demo-mode shape.
    mockBebop({ buyTokens: { [DST]: { amount: '2000000000' } }, gasFee: { usd: 1.23 } })
    const bebop = await loadBebop()
    const r = await bebop.fetchSwapData({ src: SRC, dst: DST, amount: '1000000000000000000', from: FROM, slippage: 0.5, chainId: 8453 })
    expect(r).toBeNull()
  })

  // [SPRINT-9H] In demo-mode (no BEBOP_API_KEY) Bebop can price but not execute,
  // so it must not rank as Best and then fail at swap. fetchQuote returns null.
  it('fetchQuote returns null in demo-mode (no BEBOP_API_KEY) so Bebop cannot win Best [SPRINT-9H]', async () => {
    delete process.env.BEBOP_API_KEY
    mockBebop() // API would return a price, but with no key we must not quote
    const bebop = await loadBebop()
    const q = await bebop.fetchQuote({ src: SRC, dst: DST, amount: '1000000000000000000', chainId: 8453 })
    expect(q).toBeNull()
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
