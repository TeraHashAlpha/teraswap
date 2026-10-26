/**
 * [fix/functional-chain-ui C8] The first FAQ answer ("What is TeraSwap?") states the number of
 * liquidity sources and the supported chains. Both are derived from product-claims — a literal
 * would go stale the moment an adapter is enabled or a chain is added (it said "10 … on Ethereum"
 * while the registry had 8 sources on three chains) — and it must not promise "the best swap rate".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { helpSections } from './help-content'
import { INTEGRATED_DEX_SOURCE_COUNT, INTEGRATED_DEX_SOURCE_LABELS, SWAP_CHAIN_LIST_LABEL, formatChainList } from '@/config/product-claims'
import { DISABLED_SOURCES, AGGREGATOR_META, type AggregatorName } from '@/lib/constants'

const whatIs = (sections = helpSections) =>
  sections.flatMap((s) => s.items).find((i) => i.q === 'What is TeraSwap?')!.a

const answer = (q: string, sections = helpSections) => sections.flatMap((s) => s.items).find((i) => i.q === q)!.a

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
      INTEGRATED_DEX_SOURCE_LABELS: ['Alpha', 'Beta', 'Gamma'],
      SWAP_CHAIN_LIST_LABEL: 'Chain A and Chain B',
      formatChainList: (names: readonly string[]) => names.join(' / '),
    }))
    const mocked = await import('./help-content')
    expect(whatIs(mocked.helpSections)).toContain('compares quotes across 3 liquidity sources simultaneously on Chain A and Chain B.')
    expect(answer('How does the meta-aggregator work?', mocked.helpSections)).toContain('queries 3 sources (Alpha / Beta / Gamma) in parallel')
    expect(answer('Which networks are supported?', mocked.helpSections)).toContain('supports Chain A and Chain B.')
  })
})

describe('help-content — [chore/copy-leftovers] networks and sources are not typed as prose', () => {
  it('"Which networks are supported?" lists the registry chains, not just Ethereum Mainnet', () => {
    expect(answer('Which networks are supported?')).toContain(`supports ${SWAP_CHAIN_LIST_LABEL}.`)
    expect(answer('Which networks are supported?')).not.toMatch(/supports Ethereum Mainnet/)
  })

  it('"How does the meta-aggregator work?" states the live count and exactly the quoting sources', () => {
    const a = answer('How does the meta-aggregator work?')
    expect(a).toContain(`queries ${INTEGRATED_DEX_SOURCE_COUNT} sources (${formatChainList(INTEGRATED_DEX_SOURCE_LABELS)}) in parallel`)
    expect(a).not.toMatch(/\b10 sources\b/)
  })

  it('no help answer names a disabled source (odos / balancer / openocean / bebop …)', () => {
    const text = helpSections.flatMap((s) => s.items).map((i) => `${i.q} ${i.a}`).join('\n')
    for (const name of Object.keys(DISABLED_SOURCES)) {
      const label = AGGREGATOR_META[name as AggregatorName]?.label ?? name
      expect(text, `help text mentions disabled source "${label}"`).not.toMatch(new RegExp(`\\b${label}\\b`, 'i'))
    }
  })
})
