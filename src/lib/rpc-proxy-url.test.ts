// @vitest-environment jsdom
/**
 * [fix/user-ip-privacy] The browser's proxy URL. WHY it is absolute is pinned against the real
 * WalletConnect provider in wagmiConfig.browser-transports.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { proxyRpcPath, proxyRpcUrl } from './rpc-proxy-url'

afterEach(() => vi.unstubAllGlobals())

describe('proxyRpcPath', () => {
  it('mainnet keeps the bare /api/rpc; every other chain carries its id', () => {
    expect(proxyRpcPath()).toBe('/api/rpc')
    expect(proxyRpcPath(1)).toBe('/api/rpc')
    expect(proxyRpcPath(8453)).toBe('/api/rpc?chainId=8453')
    expect(proxyRpcPath(42161)).toBe('/api/rpc?chainId=42161')
  })
})

describe('proxyRpcUrl (browser)', () => {
  it.each([1, 8453, 42161])('chain %i: absolute, on the page’s own origin, pointing at /api/rpc', (chainId) => {
    const url = new URL(proxyRpcUrl(chainId))
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/api/rpc')
    expect(url.searchParams.get('chainId')).toBe(chainId === 1 ? null : String(chainId))
  })

  it('falls back to the path when there is no usable origin (no window / opaque origin)', () => {
    vi.stubGlobal('window', { location: { origin: 'null' } })
    expect(proxyRpcUrl(8453)).toBe('/api/rpc?chainId=8453')
    vi.stubGlobal('window', undefined)
    expect(proxyRpcUrl(8453)).toBe('/api/rpc?chainId=8453')
  })
})
