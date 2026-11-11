// @vitest-environment jsdom
/**
 * [fix/user-ip-privacy] An imported token's logo is OUR route, for the chain it was imported on.
 *
 * It used to be a URL on 1inch's token-image host, which the visitor's browser then loaded directly:
 * their IP and the address of the token they had just imported went to a third party, and the URL was
 * mainnet-keyed so every L2 import showed a broken image first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let activeChain: { id: number } | undefined
vi.mock('wagmi', () => ({
  useAccount: () => ({ chain: activeChain }),
}))

import { renderHook, act } from '@testing-library/react'
import { useTokenImport } from './useTokenImport'
import { hydrateCustomTokens, getAllTokens, importedTokenLogo } from '@/lib/tokens'
import { importedTokensKey } from '@/lib/imported-tokens'

const SELECTOR = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' } as const
function abiString(value: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex')
  return '0x' + (32).toString(16).padStart(64, '0') + value.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0')
}
const abiUint = (n: number) => '0x' + n.toString(16).padStart(64, '0')

let seen: string[] = []
beforeEach(() => {
  localStorage.clear()
  seen = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(String(url))
      const data: string = JSON.parse(String(init?.body ?? '{}'))?.params?.[0]?.data ?? ''
      const result = data === SELECTOR.decimals ? abiUint(18) : data === SELECTOR.symbol ? abiString('TEST') : abiString('Test Token')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const isSameOriginPath = (u: string) => u.startsWith('/') && !u.startsWith('//')

describe('imported token logo [fix/user-ip-privacy]', () => {
  // FIRST on purpose: hydration runs once per chain per page-load (module state), so it must happen before
  // the import cases below touch Base. The stored record holds no logo URL — it is derived on load, so an
  // import saved before this change needs no migration.
  it('a saved import re-hydrated on a later visit gets the same-origin logo for its chain', () => {
    const address = '0x00000000000000000000000000000000000000D4'
    localStorage.setItem(importedTokensKey(8453), JSON.stringify([{ address, symbol: 'SAVED', name: 'Saved', decimals: 18, importedAt: 1 }]))
    hydrateCustomTokens(8453)
    const saved = getAllTokens().find((t) => t.symbol === 'SAVED')
    expect(saved).toBeDefined()
    expect(saved!.chainId).toBe(8453)
    expect(saved!.logoURI).toBe(`/api/token-logo?chainId=8453&address=${address.toLowerCase()}`)
  })

  it('importedTokenLogo is the same-origin logo route, chain-aware, lower-cased', () => {
    expect(importedTokenLogo('0xABCDEF0000000000000000000000000000000001')).toBe('/api/token-logo?chainId=1&address=0xabcdef0000000000000000000000000000000001')
    expect(importedTokenLogo('0xABCDEF0000000000000000000000000000000001', 42161)).toBe('/api/token-logo?chainId=42161&address=0xabcdef0000000000000000000000000000000001')
  })

  it.each([
    ['Ethereum', undefined, 1, '0x00000000000000000000000000000000000000a1'],
    ['Base', { id: 8453 }, 8453, '0x00000000000000000000000000000000000000b2'],
    ['Arbitrum', { id: 42161 }, 42161, '0x00000000000000000000000000000000000000c3'],
  ] as const)('a token imported on %s gets /api/token-logo for that chain, and the read went through /api/rpc', async (_n, chain, chainId, address) => {
    activeChain = chain
    const { result } = renderHook(() => useTokenImport())
    let token: Awaited<ReturnType<typeof result.current.importToken>> = null
    await act(async () => {
      token = await result.current.importToken(address)
    })
    expect(result.current.error).toBeNull()
    expect(token).not.toBeNull()
    expect(token!.logoURI).toBe(`/api/token-logo?chainId=${chainId}&address=${address}`)
    expect(isSameOriginPath(token!.logoURI)).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((u) => u === `/api/rpc?chainId=${chainId}`)).toBe(true)
  })

})
