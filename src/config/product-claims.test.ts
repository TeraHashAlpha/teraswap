/**
 * Product claims must be derived from code, never from a typed number.
 * The expected source count is ADAPTER_REGISTRY.length — this file does
 * not hard-code it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ADAPTER_REGISTRY } from '@/lib/adapters'
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

describe('product-claims — source count from ADAPTER_REGISTRY', () => {
  it('equals ADAPTER_REGISTRY.length (the registry is the list)', () => {
    expect(INTEGRATED_DEX_SOURCE_COUNT).toBe(ADAPTER_REGISTRY.length)
    expect(ADAPTER_REGISTRY.length).toBeGreaterThan(0)
    expect([...INTEGRATED_DEX_SOURCE_NAMES]).toEqual(ADAPTER_REGISTRY.map((a) => a.name))
  })

  it('claim string is "N integrated DEX sources" with that same N', () => {
    expect(INTEGRATED_DEX_SOURCES_CLAIM).toBe(
      `${ADAPTER_REGISTRY.length} integrated DEX sources`,
    )
  })

  it('spells the same N (no parallel number table for the claim)', () => {
    expect(INTEGRATED_DEX_SOURCE_COUNT_WORDS).toBe(spellCount(ADAPTER_REGISTRY.length))
  })
})

describe('product-claims — meta description', () => {
  it("embeds the derived count, not a handwritten digit", () => {
    expect(SITE_META_DESCRIPTION).toContain(
      `queries ${ADAPTER_REGISTRY.length} liquidity sources`,
    )
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
