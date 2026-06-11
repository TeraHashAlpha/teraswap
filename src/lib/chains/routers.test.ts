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

  it('[RQ-2026-06-11] order-engine shared router addresses mirror this registry (no drift)', () => {
    // The 1inch AggregationRouter v6 and 0x Exchange Proxy addresses are ALSO
    // defined in src/lib/order-engine/config.ts (WHITELISTED_ROUTERS — they flow
    // into SIGNED orders). Pin the duplicated values against drift. NOTE: the
    // order-engine's `paraswap` (Augustus V5 address, labeled v6) and `uniswapV3`
    // (SwapRouter V1, not SwapRouter02) entries deliberately differ from this
    // registry — they mirror the OrderExecutor CONTRACT's own whitelist and are
    // escalated for verification separately (REVIEW-QUALITY-2026-06-11).
    const mainnet = ROUTER_WHITELIST_BY_CHAIN[1]
    expect(WHITELISTED_ROUTERS['1inch'].address.toLowerCase()).toBe(mainnet['1inch'].toLowerCase())
    expect(WHITELISTED_ROUTERS['0x'].address.toLowerCase()).toBe(mainnet['0x'].toLowerCase())
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
