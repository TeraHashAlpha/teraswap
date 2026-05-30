/**
 * [P224] Per-chain router whitelist (P222).
 */
import { describe, it, expect } from 'vitest'
import { getRouterWhitelist, isWhitelistedRouter, ROUTER_WHITELIST_BY_CHAIN } from './routers'
import { ROUTER_WHITELIST } from '@/lib/api'

describe('chains/routers [P222]', () => {
  it('the Base whitelist contains at least 5 routers', () => {
    expect(getRouterWhitelist(8453).length).toBeGreaterThanOrEqual(5)
    // All 11 adapters have a Base primary router researched.
    expect(Object.keys(ROUTER_WHITELIST_BY_CHAIN[8453]).length).toBe(11)
  })

  it('the mainnet whitelist matches the existing ROUTER_WHITELIST in api.ts', () => {
    // getRouterWhitelist(1) must mirror ROUTER_WHITELIST exactly (no drift).
    expect(new Set(getRouterWhitelist(1))).toEqual(new Set(ROUTER_WHITELIST))
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
