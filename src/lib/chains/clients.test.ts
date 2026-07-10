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

  // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Arbitrum was registered in chains/registry.ts (Sprint 46)
  // but had NO entry in this module's VIEM_CHAINS map — a client built for chainId=42161 would
  // have had chain=undefined, silently losing chain-typed metadata. Ported alongside the
  // env-driven feeCollector.
  it('returns an Arbitrum client for chainId=42161 with the correct chain object (was missing)', () => {
    expect(getPublicClientForChain(42161).chain?.id).toBe(42161)
  })

  it('caches the Arbitrum client too (same object on repeat calls)', () => {
    const a = getPublicClientForChain(42161)
    const b = getPublicClientForChain(42161)
    expect(a).toBe(b)
    expect(a).not.toBe(getPublicClientForChain(8453))
  })
})
