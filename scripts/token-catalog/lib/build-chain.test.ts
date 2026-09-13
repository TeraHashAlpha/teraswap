/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] buildChainCatalog — one chain, dependency-injected:
 * source fetchers, DefiLlama market fetch, and the guard-verdict collector are injected so
 * these tests run with ZERO network. Covers the source-outage-tolerant-build criterion.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import type { CatalogRow, MarketSignal, SeedToken, SourceEntry, SourceFetchResult } from './types'
import { PIPELINE_CONFIG } from './config'
import { buildChainCatalog, type ChainBuildDeps } from './build-chain'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const AL: Allowlist = { nativeEth: NATIVE, trustedListExempt: [], duplicateSymbolExempt: [] }

function entry(source: SourceEntry['source'], address: string = WETH, symbol = 'WETH', decimals = 18): SourceEntry {
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

  it('a NEW candidate squatting a CORE ticker is rejected BEFORE the audit — the build survives', async () => {
    // impostor "WETH" at a different address, 2 healthy sources — if it reached the audit
    // set, the guard duplicate-symbol fatal would mark the CORE too and fail the build.
    const impostor = [entry('uniswap', DAI, 'WETH'), entry('coingecko', DAI, 'WETH')]
    const spy = vi.fn(cleanVerdicts)
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [impostor[0]]), ok('coingecko', [impostor[1]], new Map([[`1:${DAI.toLowerCase()}`, { priceUsd: 1, priceConfidence: 0.99 }]]))],
      cores: [{ address: WETH as `0x${string}`, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }],
      collectVerdicts: spy,
    }))
    expect(result.tokens.map((t) => t.address)).toEqual([WETH]) // core only, impostor gone
    expect(result.tokens[0].core).toBe(true)
    expect(result.report.rejections.some((r) => r.address === DAI && r.reason === 'symbol-conflict')).toBe(true)
    // the impostor never reached the guard audit
    const asked = spy.mock.calls[0][0].map((t: { address: string }) => t.address.toLowerCase())
    expect(asked).not.toContain(DAI.toLowerCase())
  })
})

// [fix/token-search-ranking-squatting Task 2] volume24hUsd was previously populated by
// NO fetcher (see fetch-sources.ts makeVolumeFetcher) — every catalog row sorted/capped on
// an always-0/undefined signal. These prove real volume now drives ranking + is persisted.
describe('buildChainCatalog — volume signal [fix/token-search-ranking-squatting Task 2]', () => {
  const HIGH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const LOW = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  it('growth cap keeps the higher-VOLUME new candidate, not the alphabetically-first one', async () => {
    // Both have equal votes (3) and equal alphabetical tiebreak potential reversed
    // (ALOW < ZHIGH) — only real volume data can make ZHIGH win, proving the pre-existing
    // "volume24hUsd never populated ⇒ ties fall through to alphabetical" bug is fixed.
    const highVol = new Map<string, MarketSignal>([[`1:${HIGH.toLowerCase()}`, { volume24hUsd: 5_000_000, volumeSource: 'coingecko' }]])
    const result = await buildChainCatalog(1, deps({
      fetchSources: [
        ok('uniswap', [entry('uniswap', HIGH, 'ZHIGH'), entry('uniswap', LOW, 'ALOW')]),
        ok('coingecko', [entry('coingecko', HIGH, 'ZHIGH'), entry('coingecko', LOW, 'ALOW')], highVol),
        ok('oneinch', [entry('oneinch', HIGH, 'ZHIGH'), entry('oneinch', LOW, 'ALOW')]),
      ],
      config: { ...PIPELINE_CONFIG, liquidityFloorUsd: 100_000, maxNewTokensPerChain: { 1: 1, 8453: 250, 42161: 220 } },
    }))
    expect(result.tokens.map((t) => t.symbol)).toEqual(['ZHIGH'])
    expect(result.report.capped.map((c) => c.symbol)).toEqual(['ALOW'])
  })

  it('persists volume24hUsd + volumeSource + volumeFetchedAt on the emitted row when resolved', async () => {
    // Volume clears liquidityFloorUsd so 2 sources is enough to qualify (isLowLiquidity=false).
    const vol = new Map<string, MarketSignal>([[`1:${WETH.toLowerCase()}`, { volume24hUsd: 500_000, volumeSource: 'coingecko' }]])
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap')]), ok('coingecko', [entry('coingecko')], vol)],
      builtAt: '2026-09-12',
    }))
    expect(result.tokens[0]).toMatchObject({ volume24hUsd: 500_000, volumeSource: 'coingecko', volumeFetchedAt: '2026-09-12' })
  })

  it('an entry with NO volume data gets an explicit null, never a 0 (which would sort as "worst")', async () => {
    // 3 sources so it clears lowLiqMinSources without needing any volume/price signal.
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap')]), ok('coingecko', [entry('coingecko')]), ok('oneinch', [entry('oneinch')])],
    }))
    expect(result.tokens[0]).toMatchObject({ volume24hUsd: null, volumeSource: null, volumeFetchedAt: null })
  })
})

// [fix/token-search-ranking-squatting Task 3] A single flaky source must not churn a
// previously-verified token to unverified on the very next weekly tokens:sync run.
describe('buildChainCatalog — retain-on-flake [fix/token-search-ranking-squatting Task 3]', () => {
  function prevRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
    return {
      address: WETH as `0x${string}`,
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      category: 'Native',
      logoURI: '/tokens/weth.png',
      verified: true,
      sources: ['uniswap', 'coingecko'],
      volume24hUsd: null,
      volumeSource: null,
      volumeFetchedAt: null,
      ...overrides,
    }
  }

  it('retains a previously >=2-source-verified row when ONE of its sources is down this run, and logs it', async () => {
    const log = vi.fn()
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('coingecko', [entry('coingecko')]), down('uniswap')],
      previousCatalog: new Map([[WETH.toLowerCase(), prevRow()]]),
      log,
    }))
    expect(result.tokens.map((t) => t.symbol)).toEqual(['WETH'])
    expect(result.tokens[0].verified).toBe(true)
    expect(result.tokens[0].sources).toEqual(['uniswap', 'coingecko'])
    expect(result.report.retained).toEqual([{ address: WETH, symbol: 'WETH', missingSources: ['uniswap'] }])
    expect(log.mock.calls.flat().some((m) => String(m).includes('retained from previous'))).toBe(true)
  })

  it('does NOT retain a brand-new candidate with no previous row — it still needs full agreement', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('coingecko', [entry('coingecko', DAI, 'DAI')]), down('uniswap')],
      previousCatalog: new Map(),
    }))
    expect(result.tokens).toHaveLength(0)
    expect(result.report.rejections.some((r) => r.address === DAI && r.reason === 'insufficient-sources')).toBe(true)
    expect(result.report.retained).toEqual([])
  })

  it('does NOT retain when both previous sources report fine but simply stopped listing it (real delisting, not a flake)', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', []), ok('coingecko', [])],
      previousCatalog: new Map([[WETH.toLowerCase(), prevRow()]]),
    }))
    expect(result.tokens).toHaveLength(0)
    expect(result.report.retained).toEqual([])
  })
})
