/**
 * [fix/functional-chain-ui C8] The first FAQ answer ("What is TeraSwap?") states the number of
 * liquidity sources and the supported chains. Both are derived from product-claims — a literal
 * would go stale the moment an adapter is enabled or a chain is added (it said "10 … on Ethereum"
 * while the registry had 8 sources on three chains) — and it must not promise "the best swap rate".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { helpSections } from './help-content'
import { INTEGRATED_DEX_SOURCE_COUNT, SWAP_CHAIN_LIST_LABEL } from '@/config/product-claims'

const whatIs = (sections = helpSections) =>
  sections.flatMap((s) => s.items).find((i) => i.q === 'What is TeraSwap?')!.a

afterEach(() => {
  vi.doUnmock('@/config/product-claims')
  vi.resetModules()
})

describe('help-content — "What is TeraSwap?"', () => {
  it('states the registry-derived source count and chain list', () => {
    expect(whatIs()).toContain(`compares quotes across ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources`)
    expect(whatIs()).toContain(`on ${SWAP_CHAIN_LIST_LABEL}`)
  })

  it('pins no literal 10 and no "best swap rate" promise', () => {
    // The live count must not happen to be 10 for this to mean anything.
    expect(INTEGRATED_DEX_SOURCE_COUNT).not.toBe(10)
    expect(whatIs()).not.toMatch(/\b10\b/)
    expect(whatIs()).not.toMatch(/best swap rate/i)
    expect(whatIs()).not.toMatch(/\bon Ethereum\.\s/)
  })

  it('follows product-claims: a different count and chain list change the sentence', async () => {
    vi.resetModules()
    vi.doMock('@/config/product-claims', () => ({
      INTEGRATED_DEX_SOURCE_COUNT: 3,
      SWAP_CHAIN_LIST_LABEL: 'Chain A and Chain B',
    }))
    const mocked = await import('./help-content')
    expect(whatIs(mocked.helpSections)).toContain('compares quotes across 3 liquidity sources simultaneously on Chain A and Chain B.')
  })
})
