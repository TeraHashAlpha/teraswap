// @vitest-environment node
/**
 * [P227] Per-chain simulation client factory (P226).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getPublicClientForChain, _clearClientCache } from './clients'

beforeEach(() => {
  _clearClientCache()
})

describe('chains/clients — getPublicClientForChain [P226]', () => {
  it('returns a mainnet client for chainId=1', () => {
    // chainId 1 delegates to getPrivateClient(), which sets chain = mainnet.
    expect(getPublicClientForChain(1).chain?.id).toBe(1)
  })

  it('returns a Base client for chainId=8453', () => {
    expect(getPublicClientForChain(8453).chain?.id).toBe(8453)
  })

  it('caches non-mainnet clients (same object on repeat calls)', () => {
    const a = getPublicClientForChain(8453)
    const b = getPublicClientForChain(8453)
    expect(a).toBe(b)
  })
})
