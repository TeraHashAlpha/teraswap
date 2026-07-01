/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] buildChainCatalog — one chain, dependency-injected:
 * source fetchers, DefiLlama market fetch, and the guard-verdict collector are injected so
 * these tests run with ZERO network. Covers the source-outage-tolerant-build criterion.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import type { MarketSignal, SeedToken, SourceEntry, SourceFetchResult } from './types'
import { PIPELINE_CONFIG } from './config'
import { buildChainCatalog, type ChainBuildDeps } from './build-chain'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const AL: Allowlist = { nativeEth: NATIVE, trustedListExempt: [], duplicateSymbolExempt: [] }

function entry(source: SourceEntry['source'], address = WETH, symbol = 'WETH', decimals = 18): SourceEntry {
  return { chainId: 1, address: address as `0x${string}`, symbol, name: symbol, decimals, source }
}

const ok = (source: SourceEntry['source'], entries: SourceEntry[], market?: Map<string, MarketSignal>) =>
  async (): Promise<SourceFetchResult> => ({ source, entries, market })

const down = (source: SourceEntry['source']) =>
  async (): Promise<SourceFetchResult> => {
    throw new Error(`${source}: 503 unavailable`)
  }

/** Clean verdicts for whatever identities are requested — the guard passes everything. */
const cleanVerdicts = async (tokens: Array<{ chainId: number; address: string; symbol: string }>): Promise<Verdict[]> =>
  tokens.map((t) => ({
    chainId: t.chainId,
    address: t.address,
    symbol: t.symbol,
    inTrustedList: true,
    hasBytecode: true,
    transferable: true,
    onchainSymbol: t.symbol,
    decimals: 18,
  }))

function deps(p: Partial<ChainBuildDeps>): ChainBuildDeps {
  return {
    fetchSources: [],
    fetchMarket: undefined,
    collectVerdicts: cleanVerdicts,
    allowlist: AL,
    seeds: new Map<string, SeedToken>(),
    cores: [],
    config: { ...PIPELINE_CONFIG, liquidityFloorUsd: 100_000 },
    categoryFor: () => 'Other',
    logoFor: () => '/api/token-logo?chainId=1&address=0x0',
    log: () => {},
    ...p,
  }
}

const HEALTHY = new Map<string, MarketSignal>([[`1:${WETH.toLowerCase()}`, { priceUsd: 3500, priceConfidence: 0.99 }]])

describe('buildChainCatalog — source-outage tolerance', () => {
  it('one source down ⇒ build still succeeds, outage logged, token included via remaining sources', async () => {
    const log = vi.fn()
    const result = await buildChainCatalog(1, deps({
      fetchSources: [
        ok('uniswap', [entry('uniswap')]),
        ok('coingecko', [entry('coingecko')], HEALTHY),
        down('trustwallet'),
      ],
      log,
    }))
    expect(result.sourcesUsed).toEqual(['uniswap', 'coingecko'])
    expect(result.sourceNotes.some((n) => n.includes('trustwallet'))).toBe(true)
    expect(log.mock.calls.flat().some((m) => String(m).includes('trustwallet'))).toBe(true)
    expect(result.tokens.map((t) => t.symbol)).toEqual(['WETH'])
    expect(result.tokens[0]).toMatchObject({ verified: true, sources: ['uniswap', 'coingecko'] })
  })

  it('EVERY source down ⇒ build still succeeds with cores + seeds only', async () => {
    const seed: SeedToken = { address: DAI as `0x${string}`, symbol: 'DAI', name: 'Dai', decimals: 18, category: 'Stablecoin' }
    const result = await buildChainCatalog(1, deps({
      fetchSources: [down('uniswap'), down('coingecko')],
      seeds: new Map([[DAI.toLowerCase(), seed]]),
      cores: [{ address: NATIVE as `0x${string}`, symbol: 'ETH', name: 'Ether', decimals: 18, native: true }],
    }))
    expect(result.sourcesUsed).toEqual([])
    expect(result.tokens.map((t) => t.symbol).sort()).toEqual(['DAI', 'ETH'])
    // seed kept but honestly unverified (no external agreement possible during the outage)
    expect(result.tokens.find((t) => t.symbol === 'DAI')?.verified).toBe(false)
    expect(result.report.unverifiedSeeds.map((s) => s.symbol)).toEqual(['DAI'])
  })
})

describe('buildChainCatalog — wiring', () => {
  it('market signals from fetchMarket feed the low-liquidity bump', async () => {
    const lowLiq = new Map<string, MarketSignal>([[`1:${WETH.toLowerCase()}`, { priceUsd: 0.001, priceConfidence: 0.3 }]])
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap')]), ok('coingecko', [entry('coingecko')])],
      fetchMarket: async () => ({ source: 'defillama', entries: [], market: lowLiq }),
    }))
    // 2 sources but low-liquidity ⇒ needs 3 ⇒ not included as new
    expect(result.tokens).toHaveLength(0)
    expect(result.report.rejections[0].reason).toBe('insufficient-sources-low-liquidity')
  })

  it('the verdict collector is asked about qualified candidates AND seeds AND cores', async () => {
    const spy = vi.fn(cleanVerdicts)
    const seed: SeedToken = { address: DAI as `0x${string}`, symbol: 'DAI', name: 'Dai', decimals: 18 }
    await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap')]), ok('coingecko', [entry('coingecko')], HEALTHY)],
      seeds: new Map([[DAI.toLowerCase(), seed]]),
      cores: [{ address: WETH as `0x${string}`, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }],
      collectVerdicts: spy,
    }))
    const asked = spy.mock.calls[0][0].map((t: { address: string }) => t.address.toLowerCase())
    expect(asked).toEqual(expect.arrayContaining([WETH.toLowerCase(), DAI.toLowerCase()]))
    expect(new Set(asked).size).toBe(asked.length) // deduplicated
  })

  it('returns the verdicts so the caller can refresh catalog-guard.trust.json in one pass', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap')]), ok('coingecko', [entry('coingecko')], HEALTHY)],
    }))
    expect(result.verdicts.some((v) => v.address.toLowerCase() === WETH.toLowerCase())).toBe(true)
  })
})
