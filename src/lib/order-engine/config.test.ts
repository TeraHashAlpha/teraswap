// @vitest-environment node
/**
 * [#184] Chain-aware OrderExecutor core — config.ts.
 *
 * Complements order-executor.test.ts (which covers the happy-path 1/8453 + a single
 * unwired chain). This file hardens the FAIL-CLOSED surface and documents the
 * mainnet-only behaviour of the router/feed getters:
 *
 *   - More unwired chainIds (0, 999999, -1) → null (an unwired chain must NEVER
 *     resolve to a real-looking address; the engine would EIP-712-sign / execute
 *     against the wrong contract).
 *   - The Base EIP-712 domain is byte-identical to the Base deployment (checksummed
 *     verifyingContract + chainId 8453).
 *   - getOrderExecutorDomain(unwired) throws with the SPECIFIC message the callers grep.
 *   - CANCEL_ORDER_TYPES.CancelOrder structure ([FULL-H-01]) — recoverTypedDataAddress
 *     depends on this exact field order/types.
 *   - getWhitelistedRouters / getDefaultRouter / getChainlinkFeeds currently IGNORE
 *     chainId and always return the mainnet map — assert that so a future per-chain
 *     change can't silently land unnoticed.
 *   - The chain-1 env override (NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS) is read at module
 *     load → exercised via vi.resetModules() + dynamic import.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ORDER_EXECUTOR_BY_CHAIN,
  getOrderExecutor,
  getOrderExecutorDomain,
  ORDER_EXECUTOR_ADDRESS,
  CANCEL_ORDER_TYPES,
  getWhitelistedRouters,
  getDefaultRouter,
  getChainlinkFeeds,
} from './config'

// Byte-identical, checksummed mainnet-behaviour constants (must match config.ts exactly).
const MAINNET_EXECUTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
const BASE_EXECUTOR = '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598'
const ONEINCH_V6 = '0x111111125421cA6dc452d289314280a0f8842A65'
const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'

describe('getOrderExecutor — wired chains', () => {
  it('chain 1 resolves to the exact checksummed mainnet OrderExecutor', () => {
    expect(getOrderExecutor(1)).toBe(MAINNET_EXECUTOR)
  })

  it('chain 8453 resolves to Base OrderExecutor — its OWN deployment, NOT the mainnet string', () => {
    expect(getOrderExecutor(8453)).toBe(BASE_EXECUTOR)
    // Guard the documented invariant: Base must not reuse the mainnet executor string
    // (on Base that address is a FeeCollector with different bytecode, no executeOrder).
    expect(getOrderExecutor(8453)).not.toBe(MAINNET_EXECUTOR)
  })
})

describe('getOrderExecutor — fail-closed on unwired chains', () => {
  // Arbitrum (42161) is the canonical "looks plausible but unwired" case.
  it('chain 42161 (Arbitrum) is unwired → null', () => {
    expect(getOrderExecutor(42161)).toBeNull()
  })

  // Edge chainIds: 0 (falsy — must not be confused with "no key"), a huge unknown id,
  // and a negative id. All are unwired and must fail-closed to null.
  it.each([0, 999999, -1])('chain %i is unwired → null', (chainId) => {
    expect(getOrderExecutor(chainId)).toBeNull()
  })

  it('chainId 0 specifically returns null (the ?? guard, not a falsy-coercion bug)', () => {
    // ORDER_EXECUTOR_BY_CHAIN[0] is `undefined`, so `?? null` must yield null — assert the
    // exact null, not just falsy, so a future `|| null` regression (which would also be null
    // here) is still distinguished by the other branches.
    expect(getOrderExecutor(0)).toBeNull()
    expect(ORDER_EXECUTOR_BY_CHAIN[0]).toBeUndefined()
  })
})

describe('getOrderExecutorDomain — EIP-712 domain', () => {
  it('chain 1 deep-equals the byte-identical mainnet domain', () => {
    expect(getOrderExecutorDomain(1)).toEqual({
      name: 'TeraSwapOrderExecutor',
      version: '2',
      chainId: 1,
      verifyingContract: MAINNET_EXECUTOR,
    })
  })

  it('chain 8453 returns the Base verifyingContract bound to chainId 8453', () => {
    const domain = getOrderExecutorDomain(8453)
    expect(domain).toEqual({
      name: 'TeraSwapOrderExecutor',
      version: '2',
      chainId: 8453,
      verifyingContract: BASE_EXECUTOR,
    })
    // chainId must track the requested chain (H-05: not `as const`), and the
    // verifyingContract must be the Base executor — never the mainnet one.
    expect(domain.chainId).toBe(8453)
    expect(domain.verifyingContract).not.toBe(MAINNET_EXECUTOR)
  })

  it('chain 42161 (unwired) THROWS with the specific fail-closed message', () => {
    expect(() => getOrderExecutorDomain(42161)).toThrow(
      'No OrderExecutor deployed on chain 42161',
    )
  })

  it('the throw message interpolates the requested chainId (so callers can identify it)', () => {
    expect(() => getOrderExecutorDomain(999999)).toThrow(
      'No OrderExecutor deployed on chain 999999',
    )
  })
})

describe('ORDER_EXECUTOR_ADDRESS — deprecated mainnet alias', () => {
  it('equals getOrderExecutor(1) (the mainnet entry)', () => {
    expect(ORDER_EXECUTOR_ADDRESS).toBe(getOrderExecutor(1))
    expect(ORDER_EXECUTOR_ADDRESS).toBe(MAINNET_EXECUTOR)
  })
})

describe('CANCEL_ORDER_TYPES [FULL-H-01]', () => {
  it('CancelOrder has the exact field order/types recoverTypedDataAddress depends on', () => {
    expect(CANCEL_ORDER_TYPES.CancelOrder).toEqual([
      { name: 'id', type: 'string' },
      { name: 'action', type: 'string' },
    ])
  })
})

describe('getWhitelistedRouters / getDefaultRouter — mainnet-only (chainId ignored)', () => {
  it('returns the mainnet 1inch v6 router with its exact whitelisted address', () => {
    const routers = getWhitelistedRouters(1)
    expect(routers['1inch']).toEqual({ address: ONEINCH_V6, label: '1inch v6' })
  })

  it('IGNORES chainId — Base (8453) and an unwired chain get the SAME mainnet map', () => {
    // Documents current behaviour: these getters do NOT branch on chainId. If a future
    // change adds per-chain routers, this assertion forces an intentional update.
    const mainnet = getWhitelistedRouters(1)
    expect(getWhitelistedRouters(8453)).toBe(mainnet)
    expect(getWhitelistedRouters(42161)).toBe(mainnet)
    expect(getWhitelistedRouters(0)).toBe(mainnet)
  })

  it('getDefaultRouter(anyChain) is the 1inch entry (address 0x1111…2A65)', () => {
    const expected = { address: ONEINCH_V6, label: '1inch v6' }
    expect(getDefaultRouter(1)).toEqual(expected)
    expect(getDefaultRouter(8453)).toEqual(expected)
    expect(getDefaultRouter(42161)).toEqual(expected)
  })
})

describe('getChainlinkFeeds — mainnet-only (chainId ignored)', () => {
  it('returns the mainnet ETH/USD feed with exact address + 8 decimals', () => {
    const feeds = getChainlinkFeeds(1)
    expect(feeds['ETH/USD']).toEqual({
      address: ETH_USD_FEED,
      label: 'ETH / USD',
      decimals: 8,
    })
  })

  it('IGNORES chainId — every chain gets the SAME mainnet feed map', () => {
    const mainnet = getChainlinkFeeds(1)
    expect(getChainlinkFeeds(8453)).toBe(mainnet)
    expect(getChainlinkFeeds(42161)).toBe(mainnet)
    expect(getChainlinkFeeds(-1)).toBe(mainnet)
  })
})

describe('NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS env override (read at module load)', () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS

  afterEach(() => {
    // Restore the env + module registry so other suites see pristine state.
    if (ORIGINAL === undefined) {
      delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS
    } else {
      process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS = ORIGINAL
    }
    vi.resetModules()
  })

  it('a set override flows into ORDER_EXECUTOR_BY_CHAIN[1] on fresh import', async () => {
    const OVERRIDE = '0x00000000000000000000000000000000DeaDBeef'
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS = OVERRIDE
    vi.resetModules()
    const fresh = await import('./config')
    expect(fresh.ORDER_EXECUTOR_BY_CHAIN[1]).toBe(OVERRIDE)
    expect(fresh.getOrderExecutor(1)).toBe(OVERRIDE)
    // The alias is derived from the same entry at load time → also picks up the override.
    expect(fresh.ORDER_EXECUTOR_ADDRESS).toBe(OVERRIDE)
    // Base is unaffected by the mainnet-only override.
    expect(fresh.getOrderExecutor(8453)).toBe(BASE_EXECUTOR)
  })

  it('with no override set, chain 1 falls back to the hardcoded mainnet executor', async () => {
    delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS
    vi.resetModules()
    const fresh = await import('./config')
    expect(fresh.getOrderExecutor(1)).toBe(MAINNET_EXECUTOR)
  })
})
