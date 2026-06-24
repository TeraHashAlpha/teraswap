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
  MIN_ORDER_AMOUNT,
} from './config'

// Byte-identical, checksummed mainnet-behaviour constants (must match config.ts exactly).
const MAINNET_EXECUTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
const BASE_EXECUTOR = '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598'
const ONEINCH_V6 = '0x111111125421cA6dc452d289314280a0f8842A65'
const BASE_AUGUSTUS_V6 = '0x6A000F20005980200259B80c5102003040001068'
const BASE_SWAPROUTER02 = '0x2626664c2603336E57B271c5C0b26F421741e481'
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

describe('MIN_ORDER_AMOUNT [CHORE-DCA-PRELAUNCH-FIXES] — single source pinned to the contract', () => {
  it('equals the on-chain constant TeraSwapOrderExecutor.sol MIN_ORDER_AMOUNT = 10_000 (bigint)', () => {
    // Contract: `uint256 public constant MIN_ORDER_AMOUNT = 10_000;` (TeraSwapOrderExecutor.sol:126),
    // pinned on-chain by contracts/order-engine/test-run.js ("MIN_ORDER_AMOUNT is 10000"). If the
    // contract floor ever changes, this MUST change with it — the client guard + server API both read it.
    expect(MIN_ORDER_AMOUNT).toBe(10_000n)
    expect(typeof MIN_ORDER_AMOUNT).toBe('bigint')
  })
})

describe('getWhitelistedRouters / getDefaultRouter — chain-aware [chore/dca-router-chainaware]', () => {
  it('mainnet (1) is UNCHANGED — 1inch v6 with its exact whitelisted address', () => {
    const routers = getWhitelistedRouters(1)
    expect(routers['1inch']).toEqual({ address: ONEINCH_V6, label: '1inch v6' })
  })

  it('getDefaultRouter(1) is the 1inch entry (mainnet byte-identical)', () => {
    expect(getDefaultRouter(1)).toEqual({ address: ONEINCH_V6, label: '1inch v6' })
  })

  it('Base (8453) returns the Base-whitelisted, /api/swap-serveable routers (Augustus V6 + SwapRouter02)', () => {
    const routers = getWhitelistedRouters(8453)
    expect(routers['augustusV6']).toEqual({ address: BASE_AUGUSTUS_V6, label: 'ParaSwap Augustus v6' })
    expect(routers['uniswapV3']).toEqual({ address: BASE_SWAPROUTER02, label: 'Uniswap SwapRouter02' })
  })

  it('Base (8453) does NOT offer 1inch — /api/swap cannot serve it on Base (was the SwapFailed cause)', () => {
    expect(getWhitelistedRouters(8453)['1inch']).toBeUndefined()
  })

  it('getDefaultRouter(8453) commits Augustus V6 (0x6A00…1068), not mainnet 1inch', () => {
    expect(getDefaultRouter(8453)).toEqual({ address: BASE_AUGUSTUS_V6, label: 'ParaSwap Augustus v6' })
    expect(getDefaultRouter(8453).address).not.toBe(ONEINCH_V6)
  })

  it('an unwired chain falls back to the mainnet map + default (byte-identical)', () => {
    expect(getWhitelistedRouters(42161)).toBe(getWhitelistedRouters(1))
    expect(getDefaultRouter(42161)).toEqual({ address: ONEINCH_V6, label: '1inch v6' })
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
