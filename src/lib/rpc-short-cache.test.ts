// @vitest-environment node
/**
 * [fix/user-ip-privacy] The 1.5 s per-instance cache behind /api/rpc (route-level behaviour is in
 * src/app/api/rpc/route.test.ts; this pins the unit).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { __resetRpcShortCache, isShortCacheable, readShortCache, RPC_SHORT_CACHE_TTL_MS, writeShortCache } from './rpc-short-cache'

beforeEach(() => __resetRpcShortCache())

describe('rpc-short-cache', () => {
  it('TTL is inside the 1–2 s window', () => {
    expect(RPC_SHORT_CACHE_TTL_MS).toBeGreaterThanOrEqual(1_000)
    expect(RPC_SHORT_CACHE_TTL_MS).toBeLessThanOrEqual(2_000)
  })

  it('only a param-less eth_chainId / eth_blockNumber is cacheable', () => {
    expect(isShortCacheable({ method: 'eth_chainId' })).toBe(true)
    expect(isShortCacheable({ method: 'eth_blockNumber', params: [] })).toBe(true)
    expect(isShortCacheable({ method: 'eth_blockNumber', params: null })).toBe(true)
    expect(isShortCacheable({ method: 'eth_blockNumber', params: ['latest'] })).toBe(false)
    expect(isShortCacheable({ method: 'eth_blockNumber', params: {} })).toBe(false)
    for (const method of ['eth_getBalance', 'eth_call', 'eth_gasPrice', 'eth_getBlockByNumber', 'net_version', '', undefined, 7]) {
      expect(isShortCacheable({ method })).toBe(false)
    }
  })

  it('returns a stored value until the TTL, then forgets it', () => {
    writeShortCache(1, 'eth_blockNumber', '0x10', 1_000)
    expect(readShortCache(1, 'eth_blockNumber', 1_000)).toBe('0x10')
    expect(readShortCache(1, 'eth_blockNumber', 1_000 + RPC_SHORT_CACHE_TTL_MS - 1)).toBe('0x10')
    expect(readShortCache(1, 'eth_blockNumber', 1_000 + RPC_SHORT_CACHE_TTL_MS)).toBeUndefined()
    expect(readShortCache(1, 'eth_blockNumber', 1_000)).toBeUndefined() // evicted, not resurrected
  })

  it('is keyed by chain AND method', () => {
    writeShortCache(1, 'eth_blockNumber', '0xa', 0)
    writeShortCache(8453, 'eth_blockNumber', '0xb', 0)
    writeShortCache(8453, 'eth_chainId', '0x2105', 0)
    expect(readShortCache(1, 'eth_blockNumber', 1)).toBe('0xa')
    expect(readShortCache(8453, 'eth_blockNumber', 1)).toBe('0xb')
    expect(readShortCache(8453, 'eth_chainId', 1)).toBe('0x2105')
    expect(readShortCache(1, 'eth_chainId', 1)).toBeUndefined()
    expect(readShortCache(42161, 'eth_blockNumber', 1)).toBeUndefined()
  })

  it('stores only a hex string result for a cacheable method', () => {
    for (const bad of [undefined, null, 16, '16', '0x', 'latest', { result: '0x1' }, ['0x1'], '0xzz']) {
      writeShortCache(1, 'eth_blockNumber', bad, 0)
      expect(readShortCache(1, 'eth_blockNumber', 1)).toBeUndefined()
    }
    writeShortCache(1, 'eth_getBalance', '0x1', 0)
    expect(readShortCache(1, 'eth_getBalance', 1)).toBeUndefined()
  })
})
