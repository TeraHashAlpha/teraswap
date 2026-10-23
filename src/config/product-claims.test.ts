/**
 * Product claims must be derived from code, never from a typed number.
 * The expected source count is ADAPTER_REGISTRY.length minus the
 * DISABLED_SOURCES entries present in the registry — this file does
 * not hard-code it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ADAPTER_REGISTRY } from '@/lib/adapters'
import {
  AGGREGATOR_META,
  CHAINLINK_MAX_STALENESS_SEC,
  PRICE_DEVIATION_BLOCK,
  PRICE_DEVIATION_WARN,
  DISABLED_SOURCES,
  type AggregatorName,
} from '@/lib/constants'
import { DCA_CHAINS, isDcaLive } from '@/lib/dca-launch'
import { FEE_PERCENT, QUOTE_TIMEOUT_MS, UNISWAP_FEE_TIERS } from '@/lib/constants'
import { SPLIT_MIN_IMPROVEMENT_BPS } from '@/lib/split-routing-types'
import { listConfiguredFeedTokens } from '@/lib/chains/chainlink-feeds'
import { CHAIN_CONFIGS, getSupportedChainIds } from '@/lib/chains/registry'
import {
  INTEGRATED_DEX_SOURCE_COUNT,
  INTEGRATED_DEX_SOURCE_NAMES,
  INTEGRATED_DEX_SOURCES_CLAIM,
  INTEGRATED_DEX_SOURCE_COUNT_WORDS,
  SITE_META_DESCRIPTION,
  PRIVACY_DIRECT_NOTE,
  SWAP_CHAIN_IDS,
  SWAP_CHAIN_NAMES,
  SWAP_CHAIN_LIST_LABEL,
  isOrderTypeLive,
  orderTypeStatusLabel,
  spellCount,
  capitalizeWord,
  formatChainList,
  integratedSourcesFor,
  INTEGRATED_DEX_SOURCE_LABELS,
  chainlinkFeedCountFor,
  chainNameFor,
  formatPercent,
  VERIFICATION_STAGES,
  VERIFICATION_CHECKS,
  VERIFICATION_STAGE_COUNT,
  VERIFICATION_CHECK_COUNT,
  VERIFICATION_SUMMARY,
  MIRRORED_CONSTANTS,
  PLATFORM_FEE_LABEL,
  QUOTE_TIMEOUT_SEC,
  DEFILLAMA_HIGH_VALUE_USD,
  DEFILLAMA_HIGH_VALUE_USD_LABEL,
  UNISWAP_FEE_TIER_LABELS,
  SPLIT_MIN_IMPROVEMENT_PCT,
  PRICE_DEVIATION_WARN_PCT,
  PRICE_DEVIATION_BLOCK_PCT,
  CHAINLINK_MAX_STALENESS_MIN,
  CHAINLINK_STALENESS_CLAIM,
  dcaFeatureTitle,
  dcaLiveChainNames,
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
      `compares quotes across ${QUOTING_COUNT} liquidity sources`,
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

describe('product-claims — C1 integratedSourcesFor(chainId)', () => {
  it('is the registry minus DISABLED_SOURCES on every swap chain', () => {
    for (const id of getSupportedChainIds()) {
      expect([...integratedSourcesFor(id)]).toEqual(
        ADAPTER_REGISTRY.filter((a) => !DISABLED_SOURCES[a.name]).map((a) => a.name),
      )
    }
  })

  it('stays global ONLY while the registry exposes no chain-support field (fails the day it does)', () => {
    for (const adapter of ADAPTER_REGISTRY) {
      expect(Object.keys(adapter).sort()).toEqual(['fetchQuote', 'fetchSwapData', 'name'])
    }
  })

  it('labels come from AGGREGATOR_META and never name a disabled source', () => {
    const expected = new Set(
      INTEGRATED_DEX_SOURCE_NAMES.map((n) => AGGREGATOR_META[n as AggregatorName].label),
    )
    expect(new Set(INTEGRATED_DEX_SOURCE_LABELS)).toEqual(expected)
    for (const name of Object.keys(DISABLED_SOURCES)) {
      expect(INTEGRATED_DEX_SOURCE_LABELS).not.toContain(AGGREGATOR_META[name as AggregatorName]?.label)
    }
  })
})

describe('product-claims — C2 verification stages / checks', () => {
  it('has the two stages and a summary built from the same lists', () => {
    expect([...VERIFICATION_STAGES]).toEqual(['pre-trade', 'post-execution'])
    expect(VERIFICATION_STAGE_COUNT).toBe(VERIFICATION_STAGES.length)
    expect(VERIFICATION_CHECK_COUNT).toBe(VERIFICATION_CHECKS.length)
    expect(VERIFICATION_SUMMARY).toBe(`${VERIFICATION_STAGES.length} stages · ${VERIFICATION_CHECKS.length} checks`)
  })

  it('every check sits in a declared stage and names an existing file as its proof', () => {
    for (const check of VERIFICATION_CHECKS) {
      expect(VERIFICATION_STAGES).toContain(check.stage)
      expect(() => readFileSync(join(process.cwd(), check.provedBy), 'utf8')).not.toThrow()
    }
    expect(new Set(VERIFICATION_CHECKS.map((c) => c.id)).size).toBe(VERIFICATION_CHECKS.length)
    expect(VERIFICATION_STAGES.every((st) => VERIFICATION_CHECKS.some((c) => c.stage === st))).toBe(true)
  })
})

describe('product-claims — C3 chainlinkFeedCountFor(chainId)', () => {
  it('equals the number of configured tokens the feed registry lists for that chain', () => {
    for (const id of getSupportedChainIds()) {
      expect(chainlinkFeedCountFor(id)).toBe(listConfiguredFeedTokens().filter((t) => t.chainId === id).length)
    }
  })

  it('is chain-specific (no single global figure) and 0 for a chain with no feeds', () => {
    const counts = getSupportedChainIds().map(chainlinkFeedCountFor)
    expect(new Set(counts).size).toBeGreaterThan(1)
    expect(chainlinkFeedCountFor(999_999)).toBe(0)
    expect(chainNameFor(1)).toBe(CHAIN_CONFIGS[1].name)
  })
})

describe('product-claims — C4 thresholds interpolate the constants', () => {
  it('formats the deviation band from PRICE_DEVIATION_WARN / BLOCK', () => {
    expect(PRICE_DEVIATION_WARN_PCT).toBe(`${PRICE_DEVIATION_WARN * 100}%`)
    expect(PRICE_DEVIATION_BLOCK_PCT).toBe(formatPercent(PRICE_DEVIATION_BLOCK))
    expect(formatPercent(0.015)).toBe('1.5%')
  })

  it('states staleness as a rejection limit in minutes, not a polling cadence', () => {
    expect(CHAINLINK_MAX_STALENESS_MIN).toBe(CHAINLINK_MAX_STALENESS_SEC / 60)
    expect(CHAINLINK_STALENESS_CLAIM).toContain(`older than ${CHAINLINK_MAX_STALENESS_SEC / 60} min are rejected`)
    expect(CHAINLINK_STALENESS_CLAIM).not.toMatch(/every hour/i)
  })

  it('"auto-disabled + P0" is backed by the validator critical path', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/post-execution-validator.ts'), 'utf8')
    expect(src).toMatch(/await forceDisable\(source/)
    expect(src).toMatch(/Emit P0 alert/)
  })
})

describe('product-claims — C7 dcaFeatureTitle()', () => {
  it('names exactly the chains isDcaLive says are live (no hand-typed chain list)', () => {
    const live = DCA_CHAINS.filter((id) => isDcaLive(id)).map((id) => CHAIN_CONFIGS[id].name)
    expect([...dcaLiveChainNames()]).toEqual(live)
    expect(dcaFeatureTitle()).toBe(live.length ? `DCA (${live.join(', ')})` : 'DCA')
  })

  it('grows with the live set: Base only, then Base + Arbitrum One, then none', async () => {
    const cases: [(id: number) => boolean, string][] = [
      [(id) => id === 8453, 'DCA (Base)'],
      [() => true, 'DCA (Base, Arbitrum One)'],
      [() => false, 'DCA'],
    ]
    for (const [live, expected] of cases) {
      vi.resetModules()
      vi.doMock('@/lib/dca-launch', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@/lib/dca-launch')>()),
        isDcaLive: live,
      }))
      const mod = await import('./product-claims')
      expect(mod.dcaFeatureTitle()).toBe(expected)
    }
    vi.doUnmock('@/lib/dca-launch')
    vi.resetModules()
  })
})

describe('product-claims — slots read from their declaring export', () => {
  it('fee, timeout, high-value gate, fee tiers and split threshold come from the constants', () => {
    expect(PLATFORM_FEE_LABEL).toBe(`${FEE_PERCENT}%`)
    expect(QUOTE_TIMEOUT_SEC).toBe(QUOTE_TIMEOUT_MS / 1000)
    expect(DEFILLAMA_HIGH_VALUE_USD_LABEL).toBe(`$${DEFILLAMA_HIGH_VALUE_USD.toLocaleString('en-US')}`)
    expect(UNISWAP_FEE_TIER_LABELS).toHaveLength(UNISWAP_FEE_TIERS.length)
    expect([...UNISWAP_FEE_TIER_LABELS]).toEqual(['0.01%', '0.05%', '0.3%', '1%'])
    expect(SPLIT_MIN_IMPROVEMENT_PCT).toBe(`${SPLIT_MIN_IMPROVEMENT_BPS / 100}%`)
  })
})

describe('product-claims — mirrored constants cannot drift from their declaring file', () => {
  for (const c of MIRRORED_CONSTANTS) {
    it(`${c.id} = ${c.value} in ${c.file}`, () => {
      const src = readFileSync(join(process.cwd(), c.file), 'utf8')
      const matches = [...src.matchAll(c.pattern)]
      expect(matches.length).toBeGreaterThan(0)
      for (const m of matches) expect(Number(m[c.group].replace(/_/g, ''))).toBe(c.value)
    })
  }

  it('the four contract timelocks are all covered (router, sweep, executor, oracle)', () => {
    const c = MIRRORED_CONSTANTS.find((m) => m.id === 'ADMIN_TIMELOCK_HOURS')!
    const src = readFileSync(join(process.cwd(), c.file), 'utf8')
    expect([...src.matchAll(c.pattern)]).toHaveLength(4)
  })
})

describe('[fix/functional-chain-ui C8] PRIVACY_DIRECT_NOTE matches what the browser still fetches directly', () => {
  it('no longer lists a DefiLlama lookup (now /api/price/defillama)', () => {
    expect(PRIVACY_DIRECT_NOTE).not.toMatch(/defillama/i)
  })

  it('still discloses token logos and the wallet connection, which remain browser-direct', () => {
    expect(PRIVACY_DIRECT_NOTE).toMatch(/^Token logos and your wallet's own connection are requested directly by your browser/)
  })
})

describe('[fix/functional-chain-ui C9] meta description claims only what the code does', () => {
  it('drops the unprovable "best swap rate" / "Absolute protection" / "MEV-free" phrasing', () => {
    expect(SITE_META_DESCRIPTION).not.toMatch(/best swap rate/i)
    expect(SITE_META_DESCRIPTION).not.toMatch(/absolute protection/i)
    expect(SITE_META_DESCRIPTION).not.toMatch(/MEV-free/i)
  })

  it('says it compares quotes across the derived source count, with MEV-protected routing via CoW', () => {
    expect(SITE_META_DESCRIPTION).toContain(`compares quotes across ${QUOTING_COUNT} liquidity sources`)
    expect(SITE_META_DESCRIPTION).toContain('MEV-protected routing via CoW Protocol')
  })
})
