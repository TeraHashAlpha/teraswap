/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] buildChainCatalog — one chain, dependency-injected:
 * source fetchers, DefiLlama market fetch, and the guard-verdict collector are injected so
 * these tests run with ZERO network. Covers the source-outage-tolerant-build criterion.
 */
import { describe, it, expect, vi } from 'vitest'
import { auditChain, fatal, type Allowlist, type Verdict } from '@/lib/chains/catalog-guard'
import type { CatalogRow, MarketSignal, SeedToken, SourceEntry, SourceFetchResult } from './types'
import { CoreTokenValidationError, OutageSuspectedError } from './types'
import { PIPELINE_CONFIG } from './config'
import {
  buildChainCatalog,
  type ChainBuildDeps,
  SOURCE_OUTAGE_RATIO_THRESHOLD,
  TRUST_LOSS_DROP_ABS_FLOOR,
  TRUST_LOSS_DROP_PCT_THRESHOLD,
} from './build-chain'

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

// [fix/catalog-continuity-drop-on-trust-loss — issue #518] Continuity seeding must not become a
// ratchet: a previous-catalog row that LOSES its trusted-list listing has to leave, loudly. Before
// this policy it could not, so one delisted micro-cap (HANU) froze every chain-1 refresh on the
// trusted-list FATAL — a check whose job is to stop untrusted addresses ENTERING.
const seedTok = (address: string, symbol: string): SeedToken =>
  ({ address: address as `0x${string}`, symbol, name: symbol, decimals: 18 })

/** Clean verdicts, with per-address overrides (keys lowercase). */
const verdictsWith = (overrides: Record<string, Partial<Verdict>>) =>
  async (tokens: Array<{ chainId: number; address: string; symbol: string }>): Promise<Verdict[]> =>
    tokens.map((t) => ({
      chainId: t.chainId, address: t.address, symbol: t.symbol,
      inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: t.symbol, decimals: 18,
      ...(overrides[t.address.toLowerCase()] ?? {}),
    }))

describe('buildChainCatalog — CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS [fix/catalog-continuity-drop-on-trust-loss, narrowed by fix/catalog-trust-loss-means-previously-verified]', () => {
  /** Price signal strong enough that 2 sources suffice (not low-liquidity). */
  const healthy = (addr: string) =>
    new Map<string, MarketSignal>([[`1:${addr.toLowerCase()}`, { priceUsd: 1, priceConfidence: 0.99 }]])

  /** The gate: audit exactly the rows this run would COMMIT. */
  const gateFatals = (r: { tokens: CatalogRow[]; verdicts: Verdict[] }) =>
    fatal(auditChain(1, r.tokens.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals })), r.verdicts, AL))

  it('(a) a PREVIOUSLY-VERIFIED seed that lost its listing AND its agreement is DROPPED, reported, and the gate goes GREEN', async () => {
    const log = vi.fn()
    const result = await buildChainCatalog(1, deps({
      // both previously-agreeing sources ran fine this run but stopped listing DAI — a real
      // delisting, not a source flake (retainFlakySeeds must NOT pull this back in: both sources
      // are in sourcesUsedThisRun, so nothing is "missing" — see the retain-on-flake describe
      // block above for the flake-vs-real-delisting distinction this depends on).
      fetchSources: [ok('uniswap', []), ok('coingecko', [])],
      seeds: new Map([[DAI.toLowerCase(), seedTok(DAI, 'DAI')]]),
      // the previous catalog row proves this address WAS independently verified before —
      // without this, [fix/catalog-trust-loss-means-previously-verified] keeps it (see below).
      previousCatalog: new Map([[DAI.toLowerCase(), { address: DAI as `0x${string}`, symbol: 'DAI', name: 'DAI', decimals: 18, category: 'Other', logoURI: '', verified: true, sources: ['uniswap', 'coingecko'], volume24hUsd: null, volumeSource: null, volumeFetchedAt: null }]]),
      collectVerdicts: verdictsWith({ [DAI.toLowerCase()]: { inTrustedList: false } }),
      log,
    }))
    expect(result.tokens).toHaveLength(0)
    expect(result.report.trustLost).toEqual([
      { address: DAI, symbol: 'DAI', reason: 'not in any trusted list, 0 external vote(s) < 2 required' },
    ])
    // it LEFT — it is not kept as an unverified seed row (the pre-policy behaviour that froze the gate)
    expect(result.report.unverifiedSeeds).toEqual([])
    expect(result.report.retained).toEqual([]) // not mistaken for a flake
    expect(log.mock.calls.flat().some((m) => String(m).includes('removed (trust lost:'))).toBe(true)
    expect(gateFatals(result)).toEqual([])
  })

  // [fix/catalog-trust-loss-means-previously-verified] THE REGRESSION FIX: #525 dropped this case
  // too (any `inTrustedList === false` + low votes, regardless of history) — real runs lost 153
  // never-verified rows on chain 42161 (281 → 133) and 11 on Base this way.
  it('(a-never-verified) a seed that was NEVER independently verified is KEPT, not dropped, when it loses its listing — no previousCatalog at all', async () => {
    const log = vi.fn()
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap', DAI, 'DAI')])], // 1 external vote — same as (a)
      seeds: new Map([[DAI.toLowerCase(), seedTok(DAI, 'DAI')]]),
      // no previousCatalog dep at all ⇒ nothing can be proven "previously verified"
      collectVerdicts: verdictsWith({ [DAI.toLowerCase()]: { inTrustedList: false } }),
      log,
    }))
    expect(result.tokens.map((t) => t.symbol)).toEqual(['DAI'])
    expect(result.tokens[0].verified).toBe(false)
    expect(result.report.trustLost).toEqual([]) // not dropped, not reported as a trust-loss drop
    expect(result.report.unverifiedSeeds.map((s) => s.symbol)).toEqual(['DAI']) // pre-#525 path: honest ⚠
    expect(log.mock.calls.flat().some((m) => String(m).includes('removed (trust lost:'))).toBe(false)
  })

  it('(a-never-verified-explicit) a seed with a previousCatalog row that was ITSELF verified:false is KEPT, not dropped', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap', DAI, 'DAI')])],
      seeds: new Map([[DAI.toLowerCase(), seedTok(DAI, 'DAI')]]),
      previousCatalog: new Map([[DAI.toLowerCase(), { address: DAI as `0x${string}`, symbol: 'DAI', name: 'DAI', decimals: 18, category: 'Other', logoURI: '', verified: false, sources: ['curated'], volume24hUsd: null, volumeSource: null, volumeFetchedAt: null }]]),
      collectVerdicts: verdictsWith({ [DAI.toLowerCase()]: { inTrustedList: false } }),
    }))
    expect(result.tokens.map((t) => t.symbol)).toEqual(['DAI'])
    expect(result.report.trustLost).toEqual([])
  })

  it('(b) a NEW address (no seed) failing the trusted-list check is still FATAL — unchanged', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap', DAI, 'DAI')]), ok('coingecko', [entry('coingecko', DAI, 'DAI')], healthy(DAI))],
      collectVerdicts: verdictsWith({ [DAI.toLowerCase()]: { inTrustedList: false } }),
    }))
    expect(result.tokens).toHaveLength(0)
    expect(result.report.trustLost).toEqual([]) // never reported as a trust-loss drop
    expect(result.report.rejections.some((r) => r.address === DAI && r.reason === 'guard-fatal')).toBe(true)
    expect(gateFatals(result)).toEqual([]) // rejected ⇒ never reaches the committed catalog
  })

  it('(c) a CORE that lost its listing still throws CoreTokenValidationError — forced, never dropped (behaviour identical to today)', async () => {
    // Today's behaviour, unchanged: the build FAILS LOUDLY rather than shipping or silently
    // dropping an unvalidated core — even when the same address is also a seed.
    await expect(
      buildChainCatalog(1, deps({
        fetchSources: [ok('uniswap', [entry('uniswap')])],
        cores: [{ address: WETH as `0x${string}`, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }],
        seeds: new Map([[WETH.toLowerCase(), seedTok(WETH, 'WETH')]]),
        collectVerdicts: verdictsWith({ [WETH.toLowerCase()]: { inTrustedList: false } }),
      })),
    ).rejects.toThrow(CoreTokenValidationError)
  })

  it('(d) a seed that lost its listing but still has >= minSources external votes is KEPT (a human decides)', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap', DAI, 'DAI')]), ok('coingecko', [entry('coingecko', DAI, 'DAI')], healthy(DAI))],
      seeds: new Map([[DAI.toLowerCase(), seedTok(DAI, 'DAI')]]),
      collectVerdicts: verdictsWith({ [DAI.toLowerCase()]: { inTrustedList: false } }),
    }))
    expect(result.report.trustLost).toEqual([])
    expect(result.tokens.map((t) => t.symbol)).toEqual(['DAI'])
    expect(result.tokens[0].verified).toBe(false)
    expect(result.report.unverifiedSeeds.map((u) => u.reason)).toEqual(['guard-fatal'])
    // and it STILL reds the gate — deliberately: 2 lists carry it, so this needs a human
    // (trustedListExempt entry or curated REMOVAL), not an automatic drop.
    expect(gateFatals(result).map((f) => f.check)).toEqual(['trusted-list'])
  })

  it('(e) a HAND-CURATED seed is exempt — losing its listing never drops it', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap', DAI, 'DAI')])],
      seeds: new Map([[DAI.toLowerCase(), seedTok(DAI, 'DAI')]]),
      handCuratedSeeds: new Set([DAI.toLowerCase()]),
      collectVerdicts: verdictsWith({ [DAI.toLowerCase()]: { inTrustedList: false } }),
    }))
    expect(result.report.trustLost).toEqual([])
    expect(result.tokens.map((t) => t.symbol)).toEqual(['DAI'])
  })

  it('(f) inTrustedList === null (CoinGecko unreachable) stays warn-only — an outage drops nothing', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap', DAI, 'DAI')])],
      seeds: new Map([[DAI.toLowerCase(), seedTok(DAI, 'DAI')]]),
      collectVerdicts: verdictsWith({ [DAI.toLowerCase()]: { inTrustedList: null } }),
    }))
    expect(result.report.trustLost).toEqual([])
    expect(result.tokens.map((t) => t.symbol)).toEqual(['DAI'])
    expect(gateFatals(result)).toEqual([])
  })
})

// [fix/catalog-trust-loss-means-previously-verified] Replays the exact shape of the chain-42161
// regression: the committed catalog (src/config/generated/token-catalog.42161.json, current
// origin/main) carries 281 included / 128 verified — i.e. 153 continuity seeds that were NEVER
// independently verified. PRs #527/#529 (built under #525's unnarrowed policy) dropped 281 → 133,
// sweeping up those 153 never-verified rows alongside real trust losses. This proves the fix: 0 of
// them are dropped.
describe('buildChainCatalog — 42161-shape replay (281 included / 128 verified) [fix/catalog-trust-loss-means-previously-verified]', () => {
  const VERIFIED_COUNT = 128
  const UNVERIFIED_COUNT = 153
  const addr = (i: number): `0x${string}` => `0x${i.toString(16).padStart(40, '0')}` as `0x${string}`

  it('0 drops: 128 previously-verified rows stay verified, 153 never-verified rows are kept unverified despite losing their listing', async () => {
    const seeds = new Map<string, SeedToken>()
    const previousCatalog = new Map<string, CatalogRow>()
    const verdictOverrides: Record<string, Partial<Verdict>> = {}
    const uniswapEntries: SourceEntry[] = []
    const coingeckoEntries: SourceEntry[] = []
    const oneinchEntries: SourceEntry[] = []
    const market = new Map<string, MarketSignal>()

    // 128 rows that were, and remain, independently verified (3-source agreement — no market
    // signal supplied, so lowLiqMinSources(3) applies — trusted).
    for (let i = 0; i < VERIFIED_COUNT; i++) {
      const a = addr(1000 + i)
      const sym = `VER${i}`
      seeds.set(a.toLowerCase(), seedTok(a, sym))
      previousCatalog.set(a.toLowerCase(), {
        address: a, symbol: sym, name: sym, decimals: 18, category: 'Other', logoURI: '',
        verified: true, sources: ['uniswap', 'coingecko', 'oneinch'],
        volume24hUsd: null, volumeSource: null, volumeFetchedAt: null,
      })
      uniswapEntries.push(entry('uniswap', a, sym))
      coingeckoEntries.push(entry('coingecko', a, sym))
      oneinchEntries.push(entry('oneinch', a, sym))
      market.set(`1:${a.toLowerCase()}`, { priceUsd: 1, priceConfidence: 0.99 })
      // inTrustedList: true by default via verdictsWith's base — no override needed
    }

    // 153 continuity rows that were NEVER independently verified (one-source bridge/continuity
    // rows) — shown unverified in the app, never audited by the guard — and now, this run, also
    // fail the trusted-list check (the exact regression shape).
    for (let i = 0; i < UNVERIFIED_COUNT; i++) {
      const a = addr(2000 + i)
      const sym = `UNV${i}`
      seeds.set(a.toLowerCase(), seedTok(a, sym))
      previousCatalog.set(a.toLowerCase(), {
        address: a, symbol: sym, name: sym, decimals: 18, category: 'Other', logoURI: '',
        verified: false, sources: ['curated'],
        volume24hUsd: null, volumeSource: null, volumeFetchedAt: null,
      })
      verdictOverrides[a.toLowerCase()] = { inTrustedList: false }
      // deliberately NOT listed by any fetch source this run (0 external votes) — the shape
      // that #525's unnarrowed policy misread as a fresh trust LOSS.
    }

    expect(seeds.size).toBe(VERIFIED_COUNT + UNVERIFIED_COUNT) // 281 — sanity on the replay shape

    const result = await buildChainCatalog(1, deps({
      fetchSources: [
        ok('uniswap', uniswapEntries, market),
        ok('coingecko', coingeckoEntries),
        ok('oneinch', oneinchEntries),
      ],
      seeds,
      previousCatalog,
      collectVerdicts: verdictsWith(verdictOverrides),
    }))

    expect(result.report.trustLost).toEqual([]) // 0 drops
    expect(result.tokens).toHaveLength(VERIFIED_COUNT + UNVERIFIED_COUNT) // 281 included, unchanged
    expect(result.tokens.filter((t) => t.verified)).toHaveLength(VERIFIED_COUNT) // 128 verified, unchanged
    expect(result.report.unverifiedSeeds).toHaveLength(UNVERIFIED_COUNT) // honest ⚠, not dropped
  })
})

// [fix/catalog-trust-loss-means-previously-verified] Outage circuit breaker, part 1: a source's
// fetched-list size collapsing relative to its previous run looks like an outage/rate-limit, not
// a real change — the build refuses to write a catalog rather than let a starved source manufacture
// a wave of apparent trust loss (or otherwise silently thin the catalog).
describe('buildChainCatalog — outage circuit breaker: source-count collapse [fix/catalog-trust-loss-means-previously-verified]', () => {
  const addrN = (i: number): `0x${string}` => `0x${(4000 + i).toString(16).padStart(40, '0')}` as `0x${string}`
  const listOf = (source: SourceEntry['source'], n: number): SourceEntry[] =>
    Array.from({ length: n }, (_, i) => entry(source, addrN(i), `T${i}`))

  it('a source below the ratio threshold of its previous run throws OutageSuspectedError — no result, no catalog written', async () => {
    const prevCount = 100
    const now = Math.floor(prevCount * SOURCE_OUTAGE_RATIO_THRESHOLD) - 1 // just under the floor
    await expect(
      buildChainCatalog(1, deps({
        fetchSources: [ok('uniswap', listOf('uniswap', now))],
        previousSourceCounts: { uniswap: prevCount },
      })),
    ).rejects.toThrow(OutageSuspectedError)
  })

  it('a previously-tracked source fetching 0 entries this run throws, message names source and before→after', async () => {
    await expect(
      buildChainCatalog(1, deps({
        fetchSources: [ok('uniswap', [])],
        previousSourceCounts: { uniswap: 50 },
      })),
    ).rejects.toThrow('source outage suspected: uniswap 50→0')
  })

  it('a source completely down (fetch rejects) this run compares as 0 against its previous baseline — throws', async () => {
    await expect(
      buildChainCatalog(1, deps({
        fetchSources: [down('uniswap')],
        previousSourceCounts: { uniswap: 50 },
      })),
    ).rejects.toThrow(OutageSuspectedError)
  })

  it('a source AT or ABOVE the ratio threshold does not trip the breaker — build succeeds', async () => {
    const prevCount = 100
    const now = Math.ceil(prevCount * SOURCE_OUTAGE_RATIO_THRESHOLD) // exactly at the floor
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', listOf('uniswap', now))],
      previousSourceCounts: { uniswap: prevCount },
    }))
    expect(result.sourceCounts.uniswap).toBe(now)
  })

  it('first run without a baseline (no previousSourceCounts) records this run\'s counts and compares nothing', async () => {
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', [entry('uniswap')]), ok('coingecko', [entry('coingecko')])],
    }))
    expect(result.sourceCounts).toEqual({ uniswap: 1, coingecko: 1 })
  })
})

// [fix/catalog-trust-loss-means-previously-verified] Outage circuit breaker, part 2: even a
// correctly-scoped drop (previously-verified only, per Commit 1) can still be implausibly large if
// something upstream broke (e.g. the trusted-list source itself has the outage). Threshold:
// max(TRUST_LOSS_DROP_ABS_FLOOR, ceil(TRUST_LOSS_DROP_PCT_THRESHOLD * seeds)).
describe('buildChainCatalog — outage circuit breaker: trust-loss volume [fix/catalog-trust-loss-means-previously-verified]', () => {
  const addrN = (i: number): `0x${string}` => `0x${(5000 + i).toString(16).padStart(40, '0')}` as `0x${string}`
  const verifiedPrevRow = (address: `0x${string}`, symbol: string): CatalogRow => ({
    address, symbol, name: symbol, decimals: 18, category: 'Other', logoURI: '',
    verified: true, sources: ['uniswap', 'coingecko'],
    volume24hUsd: null, volumeSource: null, volumeFetchedAt: null,
  })

  it('trust-loss drops beyond max(floor, pct-of-seeds) throws OutageSuspectedError', async () => {
    const SEED_COUNT = 10 // threshold = max(5, ceil(0.05*10)=1) = 5
    const seeds = new Map<string, SeedToken>()
    const previousCatalog = new Map<string, CatalogRow>()
    const overrides: Record<string, Partial<Verdict>> = {}
    for (let i = 0; i < SEED_COUNT; i++) {
      const a = addrN(i)
      seeds.set(a.toLowerCase(), seedTok(a, `T${i}`))
      previousCatalog.set(a.toLowerCase(), verifiedPrevRow(a, `T${i}`))
      overrides[a.toLowerCase()] = { inTrustedList: false }
    }
    // all 10 previously-verified seeds lose their listing (real delisting: both sources run,
    // list nothing) ⇒ 10 drops > threshold 5
    await expect(
      buildChainCatalog(1, deps({
        fetchSources: [ok('uniswap', []), ok('coingecko', [])],
        seeds,
        previousCatalog,
        collectVerdicts: verdictsWith(overrides),
      })),
    ).rejects.toThrow(OutageSuspectedError)
  })

  it('trust-loss drops AT the threshold (not beyond it) does NOT throw', async () => {
    const SEED_COUNT = 10
    // AT the real threshold, computed from the actual constants — not a hardcoded duplicate.
    const DROP_COUNT = Math.max(TRUST_LOSS_DROP_ABS_FLOOR, Math.ceil(TRUST_LOSS_DROP_PCT_THRESHOLD * SEED_COUNT))
    const seeds = new Map<string, SeedToken>()
    const previousCatalog = new Map<string, CatalogRow>()
    const overrides: Record<string, Partial<Verdict>> = {}
    for (let i = 0; i < SEED_COUNT; i++) {
      const a = addrN(100 + i)
      seeds.set(a.toLowerCase(), seedTok(a, `T${i}`))
      if (i < DROP_COUNT) {
        previousCatalog.set(a.toLowerCase(), verifiedPrevRow(a, `T${i}`))
        overrides[a.toLowerCase()] = { inTrustedList: false }
      }
      // remaining seeds stay healthy (default inTrustedList: true) — never reach the drop path
    }
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', []), ok('coingecko', [])],
      seeds,
      previousCatalog,
      collectVerdicts: verdictsWith(overrides),
    }))
    expect(result.report.trustLost).toHaveLength(DROP_COUNT)
  })

  it('the baseline-first-run case: no previousCatalog at all ⇒ nothing provably-verified ⇒ 0 drops, breaker never engages', async () => {
    const SEED_COUNT = 20
    const seeds = new Map<string, SeedToken>()
    const overrides: Record<string, Partial<Verdict>> = {}
    for (let i = 0; i < SEED_COUNT; i++) {
      const a = addrN(200 + i)
      seeds.set(a.toLowerCase(), seedTok(a, `T${i}`))
      overrides[a.toLowerCase()] = { inTrustedList: false } // every seed "fails" trust, same as before
    }
    const result = await buildChainCatalog(1, deps({
      fetchSources: [ok('uniswap', []), ok('coingecko', [])],
      seeds,
      // no previousCatalog dep at all — first run with this pipeline for this chain
      collectVerdicts: verdictsWith(overrides),
    }))
    expect(result.report.trustLost).toEqual([])
  })
})
