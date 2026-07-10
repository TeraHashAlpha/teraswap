/**
 * [P224] Per-chain router whitelist (P222).
 */
import { describe, it, expect } from 'vitest'
import { getRouterWhitelist, isWhitelistedRouter, ROUTER_WHITELIST_BY_CHAIN } from './routers'
import { ROUTER_WHITELIST } from '@/lib/api'
import { WHITELISTED_ROUTERS } from '@/lib/order-engine'

describe('chains/routers [P222]', () => {
  it('the Base whitelist contains at least 5 routers', () => {
    expect(getRouterWhitelist(8453).length).toBeGreaterThanOrEqual(5)
    // 11 AMM/aggregator adapters + Bebop JAM settlement = 12 Base primary routers. [ADR-010]
    expect(Object.keys(ROUTER_WHITELIST_BY_CHAIN[8453]).length).toBe(12)
  })

  it('the mainnet whitelist matches the existing ROUTER_WHITELIST in api.ts', () => {
    // getRouterWhitelist(1) must mirror ROUTER_WHITELIST exactly (no drift).
    expect(new Set(getRouterWhitelist(1))).toEqual(new Set(ROUTER_WHITELIST))
  })

  it('[CHORE-POLISH-3 P1] order-engine routers mirror the OrderExecutor contract whitelist (on-chain verified)', () => {
    // The order-engine's WHITELISTED_ROUTERS flow into SIGNED orders, so they
    // must mirror the OrderExecutor CONTRACT's own router whitelist — NOT this
    // registry's swap-path whitelist. The two sets intentionally differ:
    //
    //   - OrderExecutor (0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130) whitelists
    //     exactly the 4 routers below — verified on-chain (owner, 2026-06,
    //     closing escalation E-1 of REVIEW-QUALITY-2026-06-11).
    //   - Augustus V6 (0x6A000F20005980200259B80c5102003040001068) returns
    //     FALSE on the OrderExecutor — it is the FeeCollector/SWAP-path router
    //     (a DIFFERENT contract with its own whitelist), intentionally NOT in
    //     this set. Swapping the order-engine to V6 would break every paraswap
    //     conditional order until an owner whitelist tx landed.
    //
    // Static fixture = the contract's verified state. If config.ts drifts from
    // this, either the contract changed (re-verify on-chain) or the config is
    // wrong — investigate before touching the fixture.
    const ORDER_EXECUTOR_WHITELIST: Record<string, string> = {
      '1inch': '0x111111125421cA6dc452d289314280a0f8842A65', // AggregationRouter v6
      '0x': '0xDef1C0ded9bec7F1a1670819833240f027b25EfF', // Exchange Proxy
      paraswap: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', // Augustus V5 (NOT V6)
      uniswapV3: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // SwapRouter (V1, not SwapRouter02)
    }
    const AUGUSTUS_V6 = '0x6A000F20005980200259B80c5102003040001068'

    expect(Object.keys(WHITELISTED_ROUTERS).sort()).toEqual(Object.keys(ORDER_EXECUTOR_WHITELIST).sort())
    for (const [key, address] of Object.entries(ORDER_EXECUTOR_WHITELIST)) {
      expect(WHITELISTED_ROUTERS[key].address.toLowerCase()).toBe(address.toLowerCase())
    }
    // The paraswap label must say v5 — the address IS Augustus V5; labeling it
    // v6 raised a false "wrong address" audit alarm (E-1).
    expect(WHITELISTED_ROUTERS.paraswap.label).toContain('v5')
    // Augustus V6 must never appear in the ORDER set (it belongs to the swap path).
    const orderAddresses = Object.values(WHITELISTED_ROUTERS).map((r) => r.address.toLowerCase())
    expect(orderAddresses).not.toContain(AUGUSTUS_V6.toLowerCase())
    // The swap-path registry (this file's subject) and the order set still agree
    // on the two routers they share — pin the duplicated values against drift.
    const mainnet = ROUTER_WHITELIST_BY_CHAIN[1]
    expect(WHITELISTED_ROUTERS['1inch'].address.toLowerCase()).toBe(mainnet['1inch'].toLowerCase())
    expect(WHITELISTED_ROUTERS['0x'].address.toLowerCase()).toBe(mainnet['0x'].toLowerCase())
  })

  it('[SPRINT-46-ARBITRUM-CONFIG] the Arbitrum whitelist has all 12 primary routers registered', () => {
    expect(Object.keys(ROUTER_WHITELIST_BY_CHAIN[42161]).length).toBe(12)
  })

  it('[SPRINT-46-ARBITRUM-CONFIG] Arbitrum whitelist is INERT while feeCollector is null (dark launch)', async () => {
    // Config-only: the addresses exist in the map, but the chain is not active, so
    // nothing on the live swap path can reach isWhitelistedRouter(_, 42161) yet.
    const { isChainActive } = await import('./activation')
    expect(isChainActive(42161)).toBe(false)
    // The whitelist function itself still resolves correctly (used by the future activation
    // sprint + these tests) — inertness comes from isChainActive gating the swap path, not
    // from this function refusing to answer.
    expect(getRouterWhitelist(42161).length).toBeGreaterThan(0)
  })

  // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Regression guard: the two addresses that resolved to
  // EMPTY on-chain code (sushiswap) or the WRONG contract (uniswapv3 — V1 SwapRouter, not
  // SwapRouter02) must never silently reappear. See docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md.
  it('[SPRINT-47-ARBITRUM-ACTIVATION-PREP] the corrected Arbitrum addresses do not regress to the broken values', () => {
    const arb = ROUTER_WHITELIST_BY_CHAIN[42161]
    // uniswapv3 must be SwapRouter02 (same as mainnet), never the V1 SwapRouter.
    expect(arb.uniswapv3.toLowerCase()).toBe('0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45')
    expect(arb.uniswapv3.toLowerCase()).not.toBe('0xe592427a0aece92de3edee1f18e0157c05861564')
    // sushiswap must be the real (RedSnwapper) address, never the undeployed recon value.
    expect(arb.sushiswap.toLowerCase()).toBe('0xac4c6e212a361c968f1725b4d055b47e63f80b75')
    expect(arb.sushiswap.toLowerCase()).not.toBe('0x54f0ff7bf862325b855b0481b8e493ec5c7cbbc7')
    // the whitelist size is unchanged by the correction (still 12 — values fixed, not added/removed).
    expect(Object.keys(arb).length).toBe(12)
  })

  it('[SPRINT-46-ARBITRUM-CONFIG] Velora/Augustus V6.2 is the same canonical address on 1/8453/42161', () => {
    const v6_2 = '0x6a000f20005980200259b80c5102003040001068'
    expect(ROUTER_WHITELIST_BY_CHAIN[1].velora.toLowerCase()).toBe(v6_2)
    expect(ROUTER_WHITELIST_BY_CHAIN[8453].velora.toLowerCase()).toBe(v6_2)
    expect(ROUTER_WHITELIST_BY_CHAIN[42161].velora.toLowerCase()).toBe(v6_2)
  })

  it('isWhitelistedRouter validates per chain', () => {
    // 0x v2 AllowanceHolder is a Base router, not a mainnet one.
    const baseOnly = '0x0000000000001fF3684f28c67538d4D072C22734'
    expect(isWhitelistedRouter(baseOnly, 8453)).toBe(true)
    expect(isWhitelistedRouter(baseOnly, 1)).toBe(false)
    // Uniswap mainnet SwapRouter02 is not the Base SwapRouter02.
    const mainnetUniswap = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
    expect(isWhitelistedRouter(mainnetUniswap, 1)).toBe(true)
    expect(isWhitelistedRouter(mainnetUniswap, 8453)).toBe(false)
  })
})
