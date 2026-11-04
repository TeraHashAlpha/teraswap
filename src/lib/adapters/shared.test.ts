// @vitest-environment node
/**
 * [SPRINT-9C] getRpcUrlForChain — chain-aware RPC resolver for the on-chain
 * adapters. Mainnet (chainId 1) must equal getRpcUrl() exactly (byte-identical,
 * incl. the /api/rpc privacy proxy in the browser); other chains resolve the
 * chain's configured RPC and must NEVER return the mainnet RPC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { toWeth, feeTierCacheKey, getCachedFeeTier, setCachedFeeTier, invalidateCachedFeeTier, friendlyError, isNoRouteError } from './shared'
import { NATIVE_ETH, WETH_ADDRESS } from '@/lib/constants'

const BASE_WETH = '0x4200000000000000000000000000000000000006'

describe('toWeth — chain-aware wrapped-native [SPRINT-9E]', () => {
  it('mainnet (default / chainId 1) maps native ETH → mainnet WETH (byte-identical)', () => {
    expect(toWeth(NATIVE_ETH).toLowerCase()).toBe(WETH_ADDRESS.toLowerCase())
    expect(toWeth(NATIVE_ETH, 1).toLowerCase()).toBe(WETH_ADDRESS.toLowerCase())
  })
  it('Base (8453) maps native ETH → BASE WETH, not the mainnet WETH', () => {
    expect(toWeth(NATIVE_ETH, 8453).toLowerCase()).toBe(BASE_WETH.toLowerCase())
    expect(toWeth(NATIVE_ETH, 8453).toLowerCase()).not.toBe(WETH_ADDRESS.toLowerCase())
  })
  it('a non-native token passes through unchanged on any chain', () => {
    const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    expect(toWeth(usdc, 8453)).toBe(usdc)
    expect(toWeth(usdc, 1)).toBe(usdc)
  })
})

const ENV = ['RPC_URL', 'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL'] as const
const saved: Record<string, string | undefined> = {}

async function loadShared() {
  vi.resetModules()
  return import('./shared')
}

describe('getRpcUrlForChain [SPRINT-9C]', () => {
  beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k] }
  })

  it('mainnet (chainId 1) returns getRpcUrl() exactly — byte-identical', async () => {
    process.env.RPC_URL = 'https://eth.mainnet.test'
    const { getRpcUrlForChain, getRpcUrl } = await loadShared()
    expect(getRpcUrlForChain(1)).toBe(getRpcUrl())
    expect(getRpcUrlForChain(1)).toBe('https://eth.mainnet.test')
  })

  it('omitted chainId defaults to mainnet', async () => {
    process.env.RPC_URL = 'https://eth.mainnet.test'
    const { getRpcUrlForChain } = await loadShared()
    expect(getRpcUrlForChain()).toBe('https://eth.mainnet.test')
  })

  it('Base (8453) returns the configured Base RPC, never the mainnet RPC', async () => {
    process.env.RPC_URL = 'https://eth.mainnet.test'
    process.env.NEXT_PUBLIC_BASE_RPC_URL = 'https://base.rpc.test'
    const { getRpcUrlForChain } = await loadShared()
    expect(getRpcUrlForChain(8453)).toBe('https://base.rpc.test')
    expect(getRpcUrlForChain(8453)).not.toContain('eth.mainnet.test')
  })

  it('Base (8453) with no env falls back to the registry Base fallback (a Base RPC, not Ethereum mainnet)', async () => {
    const { getRpcUrlForChain } = await loadShared()
    expect(getRpcUrlForChain(8453)).toBe('https://mainnet.base.org')
  })
})

// [SPRINT-9G G8] The Uniswap V3 fee-tier cache key must be scoped by chainId so
// the same pair on different chains can't collide. Mainnet (chainId 1) keeps the
// `1:` prefix it always had (byte-identical).
describe('fee-tier cache — chain-scoped key [SPRINT-9G G8]', () => {
  const A = '0xAAaAAaAaAAaaAAaaAAaAAAAaaAAaaAAAaAaAaAAa'
  const B = '0xBbBbbBBbBbBBbbBbBbbbBBBBBBbBBbBbBBBbBbBb'

  afterEach(() => {
    invalidateCachedFeeTier(A, B, 1)
    invalidateCachedFeeTier(A, B, 8453)
  })

  it('scopes the key by chainId (no cross-chain collision)', () => {
    expect(feeTierCacheKey(A, B, 8453)).not.toBe(feeTierCacheKey(A, B, 1))
    expect(feeTierCacheKey(A, B, 8453).startsWith('8453:')).toBe(true)
  })

  it('mainnet key is the default and keeps the `1:` prefix (byte-identical)', () => {
    expect(feeTierCacheKey(A, B, 1)).toBe(feeTierCacheKey(A, B))
    expect(feeTierCacheKey(A, B, 1).startsWith('1:')).toBe(true)
  })

  it('a fee tier cached for mainnet is NOT returned for the same pair on Base', () => {
    setCachedFeeTier(A, B, 500, 1)
    expect(getCachedFeeTier(A, B, 1)).toBe(500)
    expect(getCachedFeeTier(A, B, 8453)).toBeNull()
  })
})

// [ADR-026 / A73 S-1] /api/swap answers NO_ROUTE (a 4xx with a code) when the adapter's words match
// the SAME liquidity / no-route rules friendlyError maps — one predicate, so the keeper's "order, not
// outage" verdict and the user's copy can never drift apart.
describe('isNoRouteError — the adapter said the PAIR cannot be routed', () => {
  it('matches exactly the inputs friendlyError maps to its liquidity / no-route copy', () => {
    const noRoute = ['No route found', 'NO ROUTE for WETH/XYZ', 'no pool exists', 'Insufficient liquidity for amount', 'insufficient LIQUIDITY']
    for (const m of noRoute) {
      expect(isNoRouteError(m)).toBe(true)
      expect(friendlyError('src', new Error(m))).toMatch(/No route found for this pair|Insufficient liquidity for this pair\/amount/)
    }
  })
  it('never matches an outage, a rate limit, a timeout, an auth error or an unrelated message', () => {
    for (const m of ['1inch API timeout', 'Request timed out', '429 rate limit', '403 forbidden', 'failed to fetch', 'insufficient funds for gas', 'Unknown error', '']) {
      expect(isNoRouteError(m)).toBe(false)
    }
  })
})
