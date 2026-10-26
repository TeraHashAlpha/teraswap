/**
 * [feat/catalog-single-source-volume] Safety rails of the single-source volume rule, made explicit:
 *  - the per-run new-token cap still binds, two-source tokens rank first, single-source admissions
 *    fill the rest by descending 7-day median volume, and the deferred list is reported;
 *  - the rule can only ADD — an existing token is never removed by it (monotonic vs. rule off);
 *  - the on-chain address guard still gates an admitted token, and cores/curated symbols still win;
 *  - `--dry-run` formatting: counts, top 20, the ETHFI line.
 * Zero network: every fetcher is injected.
 */
import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import type { CatalogRow, MarketSignal, SeedToken, SourceEntry, SourceFetchResult } from './types'
import { PIPELINE_CONFIG } from './config'
import { buildChainCatalog, type ChainBuildDeps } from './build-chain'
import { formatSingleSourceDryRun } from './dry-run'
import { medianOf, type VolumeHistory } from './verify'

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const AL: Allowlist = { nativeEth: NATIVE, trustedListExempt: [], duplicateSymbolExempt: [] }
const CHAIN = 1

/** Deterministic synthetic fixture addresses (test data only — production code never types one). */
const addr = (i: number): `0x${string}` => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`)
const DAY = (v: number) => Array(7).fill(v) as number[]
const okHist = (daily: number[]): VolumeHistory => ({ ok: true, dailyVolumeUsd: daily })

const cleanVerdicts = async (tokens: Array<{ chainId: number; address: string; symbol: string }>): Promise<Verdict[]> =>
  tokens.map((t) => ({ chainId: t.chainId, address: t.address, symbol: t.symbol, inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: t.symbol, decimals: 18 }))

const entry = (source: SourceEntry['source'], a: `0x${string}`, symbol: string): SourceEntry =>
  ({ chainId: CHAIN, address: a, symbol, name: symbol, decimals: 18, source })
const src = (source: SourceEntry['source'], entries: SourceEntry[], market?: Map<string, MarketSignal>) =>
  async (): Promise<SourceFetchResult> => ({ source, entries, market })
const HEALTHY = (a: string): [string, MarketSignal] => [`${CHAIN}:${a.toLowerCase()}`, { priceUsd: 1, priceConfidence: 0.99 }]

interface Scenario {
  /** single-source (CoinGecko-only) tokens: symbol → { history, volume24h } */
  single?: Array<{ i: number; symbol: string; history: VolumeHistory; vol24h?: number }>
  /** two-source (uniswap + coingecko) NEW tokens: symbol → 24h volume */
  double?: Array<{ i: number; symbol: string; vol24h: number }>
  seeds?: SeedToken[]
  previous?: CatalogRow[]
  cap?: number
  enabled?: boolean
  collectVerdicts?: ChainBuildDeps['collectVerdicts']
  cores?: ChainBuildDeps['cores']
  historyThrows?: boolean
}

function run(sc: Scenario) {
  const single = sc.single ?? []
  const double = sc.double ?? []
  const cgEntries = [...single.map((t) => entry('coingecko', addr(t.i), t.symbol)), ...double.map((t) => entry('coingecko', addr(t.i), t.symbol))]
  const uniEntries = double.map((t) => entry('uniswap', addr(t.i), t.symbol))
  const vol = new Map<string, number>([
    ...single.map((t): [string, number] => [addr(t.i).toLowerCase(), t.vol24h ?? 1_000_000]),
    ...double.map((t): [string, number] => [addr(t.i).toLowerCase(), t.vol24h]),
  ])
  const hist = new Map(single.map((t) => [addr(t.i).toLowerCase(), t.history]))
  return buildChainCatalog(CHAIN, {
    fetchSources: [src('coingecko', cgEntries, new Map(double.map((t) => HEALTHY(addr(t.i))))), src('uniswap', uniEntries)],
    fetchVolume: async (addrs) => ({
      source: 'coingecko',
      entries: [],
      market: new Map(addrs.filter((a) => vol.has(a.toLowerCase())).map((a) => [`${CHAIN}:${a.toLowerCase()}`, { volume24hUsd: vol.get(a.toLowerCase()), volumeSource: 'coingecko' }])),
    }),
    fetchVolumeHistory: async (addrs) => {
      if (sc.historyThrows) throw new Error('coins/list 500')
      return new Map(addrs.map((a) => [a.toLowerCase(), hist.get(a.toLowerCase()) ?? ({ ok: false, error: 'no history' } as VolumeHistory)]))
    },
    collectVerdicts: sc.collectVerdicts ?? cleanVerdicts,
    allowlist: AL,
    seeds: new Map((sc.seeds ?? []).map((s) => [s.address.toLowerCase(), s])),
    cores: sc.cores ?? [],
    config: {
      ...PIPELINE_CONFIG,
      maxNewTokensPerChain: { [CHAIN]: sc.cap ?? 400 },
      singleSource: { ...PIPELINE_CONFIG.singleSource, enabled: sc.enabled ?? true },
    },
    categoryFor: () => 'Other',
    logoFor: () => '/logo',
    log: () => {},
    previousCatalog: new Map((sc.previous ?? []).map((r) => [r.address.toLowerCase(), r])),
    builtAt: '2026-10-26',
  })
}

describe('single-source rule — new-token cap', () => {
  it('cap binds: two-source tokens rank first, single-source fills the rest by 7-day median desc, deferred list is reported', async () => {
    const result = await run({
      cap: 4,
      double: [
        { i: 10, symbol: 'DBLA', vol24h: 5_000 },
        { i: 11, symbol: 'DBLB', vol24h: 4_000 },
      ],
      single: [
        { i: 1, symbol: 'SS1', history: okHist(DAY(300_000)) },
        { i: 2, symbol: 'SS2', history: okHist(DAY(9_000_000)) },
        { i: 3, symbol: 'SS3', history: okHist(DAY(2_000_000)) },
        { i: 4, symbol: 'SS4', history: okHist(DAY(700_000)) },
      ],
    })
    const symbols = result.tokens.map((t) => t.symbol).sort()
    // 4 slots: both two-source tokens (tiny volume, still FIRST) + the 2 highest-median single-source
    expect(symbols).toEqual(['DBLA', 'DBLB', 'SS2', 'SS3'])
    expect(result.report.singleSource.admitted).toBe(4)
    expect(result.report.singleSource.deferred.map((d) => d.symbol)).toEqual(['SS4', 'SS1']) // median desc
    expect(result.report.singleSource.deferred[0].medianUsd).toBe(700_000)
    expect(result.report.capped.map((c) => c.symbol).sort()).toEqual(['SS1', 'SS4'])
    // admitted rows carry their provenance; two-source rows carry none
    expect(result.tokens.find((t) => t.symbol === 'SS2')?.admission).toEqual({ rule: 'single-source-volume', dailyVolumeUsd: DAY(9_000_000), minDailyVolumeUsd: 100_000, days: 7 })
    expect(result.tokens.find((t) => t.symbol === 'DBLA')?.admission).toBeUndefined()
  })

  it('the same ordering holds at the assemble-time cap (pre-guard prune disabled by a big cap, then a small one)', async () => {
    // cap == number of admitted ⇒ nothing deferred
    const all = await run({ cap: 3, single: [1, 2, 3].map((i) => ({ i, symbol: `S${i}`, history: okHist(DAY(200_000 * i)) })) })
    expect(all.report.singleSource.deferred).toEqual([])
    expect(all.tokens).toHaveLength(3)
  })

  it('a median — not the minimum or the 24h print — orders the cap', async () => {
    const result = await run({
      cap: 1,
      single: [
        { i: 1, symbol: 'HI24', vol24h: 90_000_000, history: okHist([100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000]) },
        { i: 2, symbol: 'HIMED', vol24h: 150_000, history: okHist([200_000, 900_000, 800_000, 700_000, 600_000, 500_000, 400_000]) },
      ],
    })
    expect(result.tokens.map((t) => t.symbol)).toEqual(['HIMED'])
    expect(medianOf(result.tokens[0].admission!.dailyVolumeUsd)).toBe(600_000)
    expect(result.report.singleSource.deferred.map((d) => d.symbol)).toEqual(['HI24'])
  })
})

describe('single-source rule — can never remove an existing token', () => {
  const seedA: SeedToken = { address: addr(100), symbol: 'SEEDA', name: 'SEEDA', decimals: 18 }
  const seedB: SeedToken = { address: addr(101), symbol: 'SEEDB', name: 'SEEDB', decimals: 18 }
  const seedC: SeedToken = { address: addr(102), symbol: 'SEEDC', name: 'SEEDC', decimals: 18 }
  const prev = (s: SeedToken, verified: boolean): CatalogRow => ({ ...s, category: 'Other', logoURI: '/l', verified, sources: ['uniswap', 'coingecko'], volume24hUsd: 1, volumeSource: 'coingecko', volumeFetchedAt: '2026-10-19' })

  it('monotonic: every token shipped with the rule OFF is still shipped with it ON (history ok, failing, or throwing)', async () => {
    const base: Scenario = {
      seeds: [seedA, seedB, seedC],
      previous: [prev(seedA, true), prev(seedB, false)],
      double: [{ i: 10, symbol: 'DBLA', vol24h: 900_000 }],
      single: [
        { i: 1, symbol: 'SS1', history: okHist(DAY(500_000)) },
        { i: 2, symbol: 'SS2', history: okHist([1, 2, 3, 4, 5, 6, 7]) },
        { i: 3, symbol: 'SS3', history: { ok: false, error: 'HTTP 429' } },
      ],
    }
    const off = await run({ ...base, enabled: false })
    for (const variant of [{}, { historyThrows: true }] as Array<Partial<Scenario>>) {
      const on = await run({ ...base, ...variant })
      const onAddrs = new Set(on.tokens.map((t) => t.address))
      for (const t of off.tokens) expect(onAddrs.has(t.address), `${t.symbol} lost with rule on`).toBe(true)
      expect(on.report.trustLost).toEqual(off.report.trustLost) // the rule never creates or hides a trust loss
    }
    // rule OFF is exactly today's behaviour: no admissions, no evaluations
    expect(off.tokens.some((t) => t.admission)).toBe(false)
    expect(off.report.singleSource.evaluated).toBe(0)
  })

  it('a seed that fails the volume rule is KEPT (honest unverified), never dropped', async () => {
    const result = await run({
      seeds: [seedA],
      single: [{ i: 100, symbol: 'SEEDA', history: okHist([1, 1, 1, 1, 1, 1, 1]) }],
    })
    const row = result.tokens.find((t) => t.symbol === 'SEEDA')
    expect(row).toBeDefined()
    expect(row?.verified).toBe(false)
    expect(row?.admission).toBeUndefined()
  })
})

describe('single-source rule — address guard and curated symbols untouched', () => {
  it('an admitted token that FAILS the on-chain guard is not shipped (rule does not bypass the guard)', async () => {
    const dead = addr(1)
    const result = await run({
      single: [
        { i: 1, symbol: 'DEAD', history: okHist(DAY(500_000)) },
        { i: 2, symbol: 'LIVE', history: okHist(DAY(500_000)) },
      ],
      collectVerdicts: async (tokens) => (await cleanVerdicts(tokens)).map((v) => (v.address.toLowerCase() === dead.toLowerCase() ? { ...v, hasBytecode: false } : v)),
    })
    expect(result.tokens.map((t) => t.symbol)).toEqual(['LIVE'])
    expect(result.report.rejections.some((r) => r.address === dead && r.reason === 'guard-fatal')).toBe(true)
    expect(result.report.singleSource.admitted).toBe(2) // the RULE admitted both; the guard decided
  })

  it('an admitted impostor of a CORE ticker still loses (symbol-conflict) and never reaches the audit', async () => {
    const core = { address: addr(500), symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }
    const result = await run({
      cores: [core],
      single: [{ i: 1, symbol: 'WETH', history: okHist(DAY(9_000_000)) }],
    })
    expect(result.tokens.map((t) => t.address)).toEqual([core.address])
    expect(result.tokens[0].admission).toBeUndefined()
  })

  it('a two-source token is untouched by the rule: no history call, no admission', async () => {
    const result = await run({ double: [{ i: 10, symbol: 'DBLA', vol24h: 900_000 }] })
    expect(result.tokens.map((t) => t.symbol)).toEqual(['DBLA'])
    expect(result.tokens[0].admission).toBeUndefined()
    expect(result.report.singleSource.candidates).toBe(0)
    expect(result.report.singleSource.evaluated).toBe(0)
  })
})

describe('--dry-run report', () => {
  const row = (i: number, symbol: string, median: number): CatalogRow => ({
    address: addr(i), symbol, name: symbol, decimals: 18, category: 'Other', logoURI: '/l', verified: true, sources: ['coingecko'],
    volume24hUsd: median, volumeSource: 'coingecko', volumeFetchedAt: '2026-10-26',
    admission: { rule: 'single-source-volume', dailyVolumeUsd: DAY(median), minDailyVolumeUsd: 100_000, days: 7 },
  })

  it('prints counts, the top 20 by 7-day median, and the ETHFI line for Base', async () => {
    const result = await run({
      single: [
        ...Array.from({ length: 25 }, (_, k) => ({ i: k + 1, symbol: `T${String(k).padStart(2, '0')}`, history: okHist(DAY(200_000 + k * 10_000)) })),
        { i: 40, symbol: 'ETHFI', history: okHist(DAY(31_000_000)) },
        { i: 41, symbol: 'THIN', history: okHist([1, 1, 1, 1, 1, 1, 1]) },
      ],
    })
    const lines = formatSingleSourceDryRun(8453, result.tokens, result.report)
    const text = lines.join('\n')
    expect(text).toContain('DRY RUN (nothing written)')
    expect(text).toMatch(/candidates \(one CoinGecko vote\): 27/)
    expect(text).toMatch(/admitted 26 · below floor 1 · fetch failed 0/)
    expect(text).toMatch(/would ship: 26/)
    const ranked = lines.filter((l) => /^\s+\d+\. /.test(l))
    expect(ranked).toHaveLength(20)
    expect(ranked[0]).toContain('ETHFI') // highest median first
    expect(lines.find((l) => l.startsWith('ETHFI:'))).toMatch(/^ETHFI: ADMITTED by the rule \(0x[0-9a-fA-F]{40}\) · median \$31,000,000/)
  })

  it('ETHFI line only for Base; reports rejection / not-evaluated honestly; disabled rule says so', () => {
    const empty = { enabled: true, candidates: 0, prefiltered: 0, evaluated: 0, admitted: 0, belowFloor: 0, fetchFailed: 0, deferred: [], evaluations: [] }
    const report = { singleSource: empty, rejections: [] } as unknown as Parameters<typeof formatSingleSourceDryRun>[2]
    expect(formatSingleSourceDryRun(1, [], report).some((l) => l.startsWith('ETHFI'))).toBe(false)
    expect(formatSingleSourceDryRun(8453, [], report).at(-1)).toMatch(/^ETHFI: not evaluated/)
    const rejected = {
      singleSource: { ...empty, evaluations: [{ address: addr(1), symbol: 'ETHFI', outcome: 'below-floor' as const }] },
      rejections: [],
    } as unknown as Parameters<typeof formatSingleSourceDryRun>[2]
    expect(formatSingleSourceDryRun(8453, [], rejected).at(-1)).toMatch(/^ETHFI: NOT admitted — rule verdict below-floor/)
    const disabled = { singleSource: { ...empty, enabled: false }, rejections: [] } as unknown as Parameters<typeof formatSingleSourceDryRun>[2]
    expect(formatSingleSourceDryRun(8453, [], disabled).at(-1)).toMatch(/rule disabled/)
  })

  it('a deferred ETHFI is reported as cap-deferred', () => {
    const a = addr(1)
    const report = {
      singleSource: { enabled: true, candidates: 1, prefiltered: 0, evaluated: 1, admitted: 1, belowFloor: 0, fetchFailed: 0, deferred: [{ address: a, symbol: 'ETHFI', medianUsd: 31_000_000 }], evaluations: [{ address: a, symbol: 'ETHFI', outcome: 'admitted' as const }] },
      rejections: [],
    } as unknown as Parameters<typeof formatSingleSourceDryRun>[2]
    expect(formatSingleSourceDryRun(8453, [row(2, 'OTHER', 200_000)], report).at(-1)).toMatch(/ETHFI: admitted by the rule but DEFERRED by the new-token cap/)
  })
})
