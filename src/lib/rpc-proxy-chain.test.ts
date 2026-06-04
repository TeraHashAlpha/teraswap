/**
 * [SPRINT-9P P1] /api/rpc chainId resolution.
 *
 * The proxy must accept an optional chainId (so a Base token import eth_calls
 * Base, not mainnet), validate it against the registry (supported chains only),
 * and default to mainnet when absent — so existing callers (which POST to
 * `/api/rpc` with no chainId) stay byte-identical.
 */
import { describe, it, expect } from 'vitest'
import { resolveProxyChainId } from './rpc-proxy-chain'

describe('resolveProxyChainId', () => {
  it('defaults to mainnet (1) when absent — existing callers byte-identical', () => {
    expect(resolveProxyChainId(null)).toEqual({ chainId: 1 })
    expect(resolveProxyChainId('')).toEqual({ chainId: 1 })
  })

  it('accepts mainnet explicitly', () => {
    expect(resolveProxyChainId('1')).toEqual({ chainId: 1 })
  })

  it('accepts a supported chain (Base 8453)', () => {
    expect(resolveProxyChainId('8453')).toEqual({ chainId: 8453 })
  })

  it('rejects an unsupported chainId', () => {
    const r = resolveProxyChainId('999999')
    expect('error' in r).toBe(true)
  })

  it('rejects a non-numeric chainId', () => {
    expect('error' in resolveProxyChainId('abc')).toBe(true)
    expect('error' in resolveProxyChainId('1.5')).toBe(true)
    expect('error' in resolveProxyChainId('0x1')).toBe(true)
  })
})
