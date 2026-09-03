/**
 * Product claims must be derived from code, never from a typed number.
 * The expected source count is ADAPTER_REGISTRY.length minus the
 * DISABLED_SOURCES entries present in the registry — this file does
 * not hard-code it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ADAPTER_REGISTRY } from '@/lib/adapters'
import { DISABLED_SOURCES } from '@/lib/constants'
import { CHAIN_CONFIGS, getSupportedChainIds } from '@/lib/chains/registry'
import {
  INTEGRATED_DEX_SOURCE_COUNT,
  INTEGRATED_DEX_SOURCE_NAMES,
  INTEGRATED_DEX_SOURCES_CLAIM,
  INTEGRATED_DEX_SOURCE_COUNT_WORDS,
  SITE_META_DESCRIPTION,
  SWAP_CHAIN_IDS,
  SWAP_CHAIN_NAMES,
  SWAP_CHAIN_LIST_LABEL,
  isOrderTypeLive,
  orderTypeStatusLabel,
  spellCount,
  capitalizeWord,
  formatChainList,
} from './product-claims'

const ORIG_DCA = process.env.NEXT_PUBLIC_DCA_ENABLED
const ORIG_LIMIT = process.env.NEXT_PUBLIC_LIMIT_ENABLED

afterEach(() => {
  if (ORIG_DCA === undefined) delete process.env.NEXT_PUBLIC_DCA_ENABLED
  else process.env.NEXT_PUBLIC_DCA_ENABLED = ORIG_DCA
  if (ORIG_LIMIT === undefined) delete process.env.NEXT_PUBLIC_LIMIT_ENABLED
  else process.env.NEXT_PUBLIC_LIMIT_ENABLED = ORIG_LIMIT
})

const QUOTING_COUNT = ADAPTER_REGISTRY.filter((a) => !DISABLED_SOURCES[a.name]).length

describe('product-claims — source count from ADAPTER_REGISTRY minus DISABLED_SOURCES', () => {
  it('excludes registry entries that are permanently disabled', () => {
    expect(QUOTING_COUNT).toBeLessThan(ADAPTER_REGISTRY.length)
    expect(INTEGRATED_DEX_SOURCE_COUNT).toBe(QUOTING_COUNT)
    expect(INTEGRATED_DEX_SOURCE_COUNT).toBeGreaterThan(0)
    expect([...INTEGRATED_DEX_SOURCE_NAMES]).toEqual(
      ADAPTER_REGISTRY.filter((a) => !DISABLED_SOURCES[a.name]).map((a) => a.name),
    )
  })

  it('never names a disabled source in the public list', () => {
    for (const name of INTEGRATED_DEX_SOURCE_NAMES) {
      expect(DISABLED_SOURCES[name]).toBeUndefined()
    }
  })

  it('claim string is "N integrated DEX sources" with that same N', () => {
    expect(INTEGRATED_DEX_SOURCES_CLAIM).toBe(`${QUOTING_COUNT} integrated DEX sources`)
  })

  it('spells the same N (no parallel number table for the claim)', () => {
    expect(INTEGRATED_DEX_SOURCE_COUNT_WORDS).toBe(spellCount(QUOTING_COUNT))
  })

  it('changes when a source is added to DISABLED_SOURCES', async () => {
    vi.resetModules()
    vi.doMock('@/lib/constants', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/constants')>()
      const firstQuoting = ADAPTER_REGISTRY.find((a) => !actual.DISABLED_SOURCES[a.name])!.name
      return {
        ...actual,
        DISABLED_SOURCES: { ...actual.DISABLED_SOURCES, [firstQuoting]: 'test-only disable' },
      }
    })

    const mod = await import('./product-claims')
    expect(mod.INTEGRATED_DEX_SOURCE_COUNT).toBe(QUOTING_COUNT - 1)

    vi.doUnmock('@/lib/constants')
    vi.resetModules()
  })
})

describe('product-claims — meta description', () => {
  it("embeds the derived count, not a handwritten digit", () => {
    expect(SITE_META_DESCRIPTION).toContain(
      `queries ${QUOTING_COUNT} liquidity sources`,
    )
  })

  it('initialises without a temporal-dead-zone ReferenceError', async () => {
    vi.resetModules()
    const mod = await import('./product-claims')
    expect(typeof mod.SITE_META_DESCRIPTION).toBe('string')
    expect(mod.SITE_META_DESCRIPTION.length).toBeGreaterThan(0)
  })

  it('embeds the derived SWAP_CHAIN_LIST_LABEL, not a hardcoded chain list', () => {
    expect(SITE_META_DESCRIPTION).toContain(
      `an EVM meta-aggregator on ${SWAP_CHAIN_LIST_LABEL}`,
    )
    expect(SITE_META_DESCRIPTION).not.toContain('an Ethereum meta-aggregator')
  })

  it('names Ethereum via the derived chain list', () => {
    expect(SWAP_CHAIN_NAMES).toContain('Ethereum')
    expect(SITE_META_DESCRIPTION).toContain('Ethereum')
  })

  it('changes when a chain is added to the registry (fails against a hardcoded list)', async () => {
    vi.resetModules()
    vi.doMock('@/lib/chains/registry', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/chains/registry')>()
      const EXTRA_CHAIN = { ...actual.CHAIN_CONFIGS[1], chainId: 999999, name: 'Testnet Chain', slug: 'testnet-chain' }
      const patchedConfigs = { ...actual.CHAIN_CONFIGS, 999999: EXTRA_CHAIN }
      return {
        ...actual,
        CHAIN_CONFIGS: patchedConfigs,
        getSupportedChainIds: () => Object.keys(patchedConfigs).map(Number),
      }
    })

    const mod = await import('./product-claims')
    expect(mod.SWAP_CHAIN_NAMES).toContain('Testnet Chain')
    expect(mod.SITE_META_DESCRIPTION).toContain('Testnet Chain')
    expect(mod.SITE_META_DESCRIPTION).not.toBe(SITE_META_DESCRIPTION)

    vi.doUnmock('@/lib/chains/registry')
    vi.resetModules()
  })
})

describe('product-claims — swap chains from the registry', () => {
  it('lists the same chain ids the registry exports', () => {
    expect([...SWAP_CHAIN_IDS]).toEqual(getSupportedChainIds())
  })

  it('names come from CHAIN_CONFIGS, not a parallel string list', () => {
    const fromRegistry = getSupportedChainIds().map((id) => CHAIN_CONFIGS[id].name)
    expect([...SWAP_CHAIN_NAMES]).toEqual(fromRegistry)
    expect(SWAP_CHAIN_LIST_LABEL).toBe(formatChainList(fromRegistry))
  })
})

describe('product-claims — order types from launch flags', () => {
  it('instant swaps are live with no flag', () => {
    expect(isOrderTypeLive('instant')).toBe(true)
    expect(orderTypeStatusLabel('instant')).toBe('Live')
  })

  it('DCA is off unless NEXT_PUBLIC_DCA_ENABLED is the exact literal true', () => {
    delete process.env.NEXT_PUBLIC_DCA_ENABLED
    expect(isOrderTypeLive('dca')).toBe(false)
    expect(orderTypeStatusLabel('dca')).toBe('Coming Soon')

    process.env.NEXT_PUBLIC_DCA_ENABLED = 'TRUE'
    expect(isOrderTypeLive('dca')).toBe(false)

    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    expect(isOrderTypeLive('dca')).toBe(true)
    expect(orderTypeStatusLabel('dca')).toBe('Live')
  })

  it('Limit and Take-Profit follow NEXT_PUBLIC_LIMIT_ENABLED; Stop-Loss stays off', () => {
    delete process.env.NEXT_PUBLIC_LIMIT_ENABLED
    expect(isOrderTypeLive('limit')).toBe(false)
    expect(isOrderTypeLive('takeProfit')).toBe(false)
    expect(isOrderTypeLive('stopLoss')).toBe(false)

    process.env.NEXT_PUBLIC_LIMIT_ENABLED = 'true'
    expect(isOrderTypeLive('limit')).toBe(true)
    expect(isOrderTypeLive('takeProfit')).toBe(true)
    expect(isOrderTypeLive('stopLoss')).toBe(false)
  })
})

describe('product-claims — helpers', () => {
  it('spellCount uses words for small integers and digits otherwise', () => {
    expect(spellCount(0)).toBe('zero')
    expect(spellCount(2)).toBe('two')
    expect(spellCount(21)).toBe('21')
  })

  it('capitalizeWord and formatChainList are mechanical', () => {
    expect(capitalizeWord('twelve')).toBe('Twelve')
    expect(formatChainList([])).toBe('')
    expect(formatChainList(['Ethereum'])).toBe('Ethereum')
    expect(formatChainList(['Ethereum', 'Base'])).toBe('Ethereum and Base')
    expect(formatChainList(['Ethereum', 'Base', 'Arbitrum One'])).toBe(
      'Ethereum, Base, and Arbitrum One',
    )
  })
})
