/**
 * [fix/catalog-refresh-drops-untrusted] Rules A (growth breaker), B (additions cap) and C (a size bound for
 * every chain), end to end through the REAL pipeline stages — buildChainCatalog → decideRefresh →
 * applyAdditionsCap → the real catalog guard (deriveGuardOutcomes/auditChain) — with synthetic sources:
 *
 *  1. the three real cases of 2026-11-18 (1inch mainnet 1074 → 3203, Base 194 → 337, Arbitrum 137 → 5069)
 *     rebuilt from the real per-source sizes and the real committed catalog sizes (994 / 462 / 389);
 *  2. a seeded property over random source sizes across two runs.
 *
 * No network. Seeds are fixed: a failure names its seed and reproduces.
 */
import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import allowlistJson from '@/lib/chains/catalog-guard.allowlist.json'
import { buildChainCatalog, type ChainBuildDeps } from './build-chain'
import { CATALOG_SIZE_BOUND, PIPELINE_CONFIG } from './config'
import { deriveGuardOutcomes } from './guard-gate'
import {
  MAX_ADDITIONS_PER_CHAIN,
  applyAdditionsCap,
  decideRefresh,
  renderPrBodySections,
  type RefreshDecision,
} from './refresh-decision'
import type { CatalogRow, MarketSignal, SeedToken, SourceCounts, SourceEntry, SourceFetchResult, SourceId } from './types'

const allowlist = allowlistJson as unknown as Allowlist

// ── a tiny seeded generator (mulberry32) ───────────────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── the world: previous catalog + today's source lists ────────────────────────────────────────
interface WorldSpec {
  chainId: number
  /** Rows of the previous committed catalog. */
  prevRows: number
  /** How many previous rows (the first N) are listed by each source — what their `sources` say. */
  rowsWith: Partial<Record<SourceId, number>>
  /** The sizes the previous run recorded (counts.sourceCounts). */
  prevCounts: SourceCounts
  /** Today's list sizes, reached with single-list junk entries (a spec that needs more throws). */
  todayCounts: SourceCounts
  /** New tokens, grouped by the sources that list them. */
  newIn: Array<{ n: number; sources: SourceId[] }>
  /** The owner's accepted sizes (turns the breaker off for that source — the pre-change behaviour). */
  accepted?: Partial<Record<SourceId, number>>
}

const sym = (chainId: number, tag: string) => `${tag}${chainId}`
const addrOf = (chainId: number, kind: number, n: number): `0x${string}` =>
  getAddress(`0x${(BigInt(chainId) * 10n ** 12n + BigInt(kind) * 10n ** 8n + BigInt(n) + 1n).toString(16).padStart(40, '0')}`)

interface World {
  spec: WorldSpec
  previous: CatalogRow[]
  previousMap: Map<string, CatalogRow>
  newTokens: Array<{ address: `0x${string}`; symbol: string }>
  fetchers: Array<() => Promise<SourceFetchResult>>
  market: Map<string, MarketSignal>
  todayCounts: Record<string, number>
}

function makeWorld(spec: WorldSpec, rand: () => number): World {
  const { chainId } = spec
  const previous: CatalogRow[] = []
  for (let i = 0; i < spec.prevRows; i++) {
    const sources = (Object.keys(spec.rowsWith) as SourceId[]).filter((s) => i < (spec.rowsWith[s] ?? 0))
    previous.push({
      address: addrOf(chainId, 1, i), symbol: sym(chainId, `P${i}_`), name: `Prev ${i}`, decimals: 18, category: 'Other', logoURI: '/x',
      verified: true, sources, volume24hUsd: 0, volumeSource: null, volumeFetchedAt: null,
    } as CatalogRow)
  }
  const newTokens: World['newTokens'] = []
  const newBySource = new Map<SourceId, SourceEntry[]>()
  const market = new Map<string, MarketSignal>()
  spec.newIn.forEach((g, k) => {
    for (let j = 0; j < g.n; j++) {
      const address = addrOf(chainId, 2 + k, j)
      const symbol = sym(chainId, `N${k}_${j}_`)
      newTokens.push({ address, symbol })
      for (const s of g.sources) {
        const list = newBySource.get(s) ?? []
        list.push({ chainId, address, symbol, name: symbol, decimals: 18, source: s })
        newBySource.set(s, list)
      }
      // liquid enough to qualify on two votes (floor 100k) and distinct, so the 24h tie-break never decides
      market.set(`${chainId}:${address.toLowerCase()}`, { volume24hUsd: 200_000 + Math.floor(rand() * 5_000_000) * 10 + k * 3 + j, volumeSource: 'coingecko' })
    }
  })
  const todayCounts: Record<string, number> = {}
  const sources = [...new Set([...Object.keys(spec.prevCounts), ...Object.keys(spec.todayCounts)])] as SourceId[]
  const fetchers = sources.map((s) => {
    const entries: SourceEntry[] = []
    for (const r of previous) {
      if (r.sources.includes(s)) entries.push({ chainId, address: r.address, symbol: r.symbol, name: r.name, decimals: 18, source: s })
    }
    entries.push(...(newBySource.get(s) ?? []))
    const want = spec.todayCounts[s] ?? entries.length
    if (entries.length > want) throw new Error(`world spec: ${s} needs ${entries.length} entries but today's size is ${want}`)
    for (let j = entries.length, n = 0; j < want; j++, n++) {
      const address = addrOf(chainId, 900, n + sources.indexOf(s) * 100000)
      entries.push({ chainId, address, symbol: `J${sources.indexOf(s)}_${n}`, name: 'junk', decimals: 18, source: s }) // a single-list entry: never reaches 2 votes
    }
    todayCounts[s] = entries.length
    return async (): Promise<SourceFetchResult> => ({ source: s, entries })
  })
  return { spec, previous, previousMap: new Map(previous.map((r) => [r.address.toLowerCase(), r])), newTokens, fetchers, market, todayCounts }
}

const cleanVerdicts = async (tokens: Array<{ chainId: number; address: string; symbol: string }>): Promise<Verdict[]> =>
  tokens.map((t) => ({ chainId: t.chainId, address: t.address, symbol: t.symbol, inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: t.symbol, decimals: 18 }))

interface Outcome {
  world: World
  result: Awaited<ReturnType<typeof buildChainCatalog>>
  decision: RefreshDecision
  volume7d: Map<string, number>
  audit: (rows: readonly CatalogRow[]) => ReturnType<typeof deriveGuardOutcomes>
}

async function runWorld(spec: WorldSpec, rand: () => number, opts: { bound?: number | null; cap?: boolean } = {}): Promise<Outcome> {
  const world = makeWorld(spec, rand)
  const { chainId } = spec
  const seeds = new Map<string, SeedToken>(world.previous.map((r) => [r.address.toLowerCase(), { address: r.address, symbol: r.symbol, name: r.name, decimals: 18 }]))
  const deps: ChainBuildDeps = {
    fetchSources: world.fetchers,
    fetchMarket: async () => ({ source: 'defillama', entries: [], market: world.market }),
    collectVerdicts: cleanVerdicts,
    allowlist,
    seeds,
    cores: [],
    config: { ...PIPELINE_CONFIG, singleSource: { ...PIPELINE_CONFIG.singleSource, enabled: false }, singleSourceByChain: {} },
    categoryFor: () => 'Other',
    logoFor: () => '/x',
    log: () => {},
    previousCatalog: world.previousMap,
    previousSourceCounts: spec.prevCounts,
    acceptedSourceSizes: spec.accepted,
    builtAt: '2026-11-18',
  }
  const result = await buildChainCatalog(chainId, deps)
  const audit = (rows: readonly CatalogRow[]) => deriveGuardOutcomes(chainId, [...rows], result.verdicts, allowlist)
  let decision = decideRefresh({
    chainId,
    previous: world.previous,
    candidate: result.tokens,
    audit,
    protectedAddresses: new Set(),
    trustedList: { previous: spec.prevCounts.coingecko ?? null, current: result.sourceCounts.coingecko ?? null },
    heldBackSources: result.heldBackSources,
  })
  const volume7d = new Map<string, number>()
  const order = world.newTokens.map((t) => t.address.toLowerCase())
  // distinct 7-day volumes in a random order, so "highest first" is a real ranking
  const shuffled = [...order].sort(() => rand() - 0.5)
  shuffled.forEach((a, i) => volume7d.set(a, 1_000 + i * 17))
  const bound = opts.bound === undefined ? CATALOG_SIZE_BOUND[chainId] : opts.bound ?? undefined
  if (!decision.blocked && opts.cap !== false) decision = applyAdditionsCap(decision, { previous: world.previous, protectedAddresses: new Set(), volume7d, sizeBound: bound, audit })
  return { world, result, decision, volume7d, audit }
}

const lc = (s: string) => s.toLowerCase()
const additionsOf = (o: Outcome) => o.decision.catalog.filter((r) => !o.world.previousMap.has(lc(r.address)))

// ── 1. the three real cases ────────────────────────────────────────────────────────────────────
// Sizes: previous/today per source from `counts.sourceCounts` (committed 2026-11-16) and today's live
// lists (2026-11-18); rows per source from the committed catalogs; committed rows 994 / 462 / 389.
// "newBoth" = tokens CoinGecko and 1inch list that are not on the site (tables file §3: +397 mainnet,
// +59 Base; Arbitrum: 2068 of today's fresh 1inch entries are on CoinGecko); "legit" = 30-40 ordinary
// weekly candidates (CoinGecko + Uniswap; 30 on Base, where Uniswap's list has room for no more) per chain,
// the thing the cap must still let through.
const REAL: Record<number, WorldSpec> = {
  1: {
    chainId: 1, prevRows: 994,
    rowsWith: { coingecko: 905, oneinch: 725, uniswap: 431, trustwallet: 208 },
    prevCounts: { uniswap: 479, coingecko: 6115, oneinch: 1074, trustwallet: 287 },
    todayCounts: { uniswap: 479, coingecko: 5792, oneinch: 3203, trustwallet: 287 },
    newIn: [{ n: 397, sources: ['coingecko', 'oneinch'] }, { n: 40, sources: ['coingecko', 'uniswap'] }],
  },
  8453: {
    chainId: 8453, prevRows: 462,
    rowsWith: { coingecko: 420, oneinch: 137, uniswap: 163, trustwallet: 6, superchain: 126 },
    prevCounts: { uniswap: 195, coingecko: 2981, oneinch: 194, trustwallet: 8, superchain: 326 },
    todayCounts: { uniswap: 195, coingecko: 2833, oneinch: 337, trustwallet: 8, superchain: 326 },
    newIn: [{ n: 59, sources: ['coingecko', 'oneinch'] }, { n: 30, sources: ['coingecko', 'uniswap'] }], // Uniswap lists 195 today: 163 rows + 30 new
  },
  42161: {
    chainId: 42161, prevRows: 389,
    rowsWith: { coingecko: 229, oneinch: 88, uniswap: 78, trustwallet: 6, arbitrumBridge: 37 },
    prevCounts: { uniswap: 227, coingecko: 3283, oneinch: 137, trustwallet: 6, arbitrumBridge: 99 },
    todayCounts: { uniswap: 227, coingecko: 3237, oneinch: 5069, trustwallet: 6, arbitrumBridge: 99 },
    newIn: [{ n: 2068, sources: ['coingecko', 'oneinch'] }, { n: 40, sources: ['coingecko', 'uniswap'] }],
  },
}

describe('the three real cases of 2026-11-18', () => {
  for (const chainId of [1, 8453, 42161]) {
    const spec = REAL[chainId]
    const bound = CATALOG_SIZE_BOUND[chainId]

    describe(`chain ${chainId}`, () => {
      it('WITHOUT the breaker (1inch accepted at today\'s size) the premise reproduces: mainnet and Base exceed their size assertion, Arbitrum takes a very large addition', async () => {
        const o = await runWorld({ ...spec, accepted: { oneinch: spec.todayCounts.oneinch } }, rng(chainId), { cap: false })
        expect(o.result.heldBackSources).toEqual([])
        const adds = additionsOf(o).length
        if (chainId === 1 || chainId === 8453) expect(o.decision.catalog.length).toBeGreaterThanOrEqual(bound)
        else expect(adds).toBeGreaterThan(MAX_ADDITIONS_PER_CHAIN * 4)
      })

      it('WITH the breaker the refresh builds within the size assertion and adds at most the cap; 1inch is held back, the others are used', async () => {
        const o = await runWorld(spec, rng(chainId))
        expect(o.decision.blocked).toBeNull()
        expect(o.result.heldBackSources).toEqual([{ chainId, source: 'oneinch', previous: spec.prevCounts.oneinch, current: spec.todayCounts.oneinch, baseline: spec.prevCounts.oneinch }])
        // the recorded size stays at the previous number: next week is compared with the same baseline
        expect(o.result.sourceCounts.oneinch).toBe(spec.prevCounts.oneinch)
        expect(o.result.sourceCounts.uniswap).toBe(spec.todayCounts.uniswap)
        expect(o.decision.catalog.length).toBeLessThan(bound)
        const adds = additionsOf(o)
        expect(adds.length).toBeLessThanOrEqual(MAX_ADDITIONS_PER_CHAIN)
        // none of the 1inch-grown tokens got in (1inch was their second vote), only ordinary candidates
        expect(adds.every((r) => r.symbol.startsWith('N1_'))).toBe(true) // group 1 = the CoinGecko + Uniswap candidates
        // the guard (the real auditChain) is green on what would ship
        const fatal = o.decision.catalog.filter((r) => o.audit(o.decision.catalog).get(lc(r.address))?.status === 'fatal')
        expect(fatal).toEqual([])
      })

      it('the PR body names the held-back source (source, chain, old and new size) and lists what the cap held back', async () => {
        const o = await runWorld(spec, rng(chainId))
        const body = renderPrBodySections(o.decision)
        expect(body).toContain('## Sources held back by the growth breaker')
        expect(body).toContain(`chain ${chainId} · \`oneinch\` · previous ${spec.prevCounts.oneinch} → now ${spec.todayCounts.oneinch} entries`)
        expect(body).toContain(`"${chainId}:oneinch": ${spec.todayCounts.oneinch}`)
        expect(body).toContain('## Candidates held back by the weekly cap')
        const heldBackLines = body.split('## Candidates held back by the weekly cap')[1].split('\n').filter((l) => l.startsWith('- chain'))
        expect(heldBackLines.length).toBe(o.decision.heldBack.length)
      })
    })
  }

  it('mainnet: 994 committed rows leave room for 5 additions only (size bound 1000), Base and Arbitrum take the full 25', async () => {
    expect(additionsOf(await runWorld(REAL[1], rng(11))).length).toBe(5)
    expect(additionsOf(await runWorld(REAL[8453], rng(12))).length).toBe(MAX_ADDITIONS_PER_CHAIN)
    expect(additionsOf(await runWorld(REAL[42161], rng(13))).length).toBe(MAX_ADDITIONS_PER_CHAIN)
  })
})

// ── 2. seeded property ─────────────────────────────────────────────────────────────────────
const SEEDS = [1, 2, 3, 7, 42, 99, 1234, 2026, 31337, 86400]

function randomSpec(chainId: number, rand: () => number): WorldSpec {
  const bound = CATALOG_SIZE_BOUND[chainId]
  const prevRows = Math.max(120, bound - 1 - Math.floor(rand() * 70)) // previous size < bound, 0..69 rows of room
  const sources: SourceId[] = chainId === 8453 ? ['uniswap', 'coingecko', 'oneinch', 'trustwallet', 'superchain'] : chainId === 42161 ? ['uniswap', 'coingecko', 'oneinch', 'trustwallet', 'arbitrumBridge'] : ['uniswap', 'coingecko', 'oneinch', 'trustwallet']
  const rowsWith: Partial<Record<SourceId, number>> = { coingecko: prevRows }
  for (const s of sources) if (s !== 'coingecko') rowsWith[s] = Math.floor(rand() * prevRows * 0.8)
  const prevCounts: SourceCounts = {}
  for (const s of sources) prevCounts[s] = Math.max(1, (rowsWith[s] ?? 0) + 1 + Math.floor(rand() * 300))
  const newIn: WorldSpec['newIn'] = []
  // group 0 = the ordinary weekly candidates (CoinGecko + Uniswap), 0..60 of them; 0..2 more groups on a random second source
  newIn[newIn.length] = { n: Math.floor(rand() * 61), sources: ['coingecko', 'uniswap'] }
  const extra = Math.floor(rand() * 3)
  for (let g = 0; g < extra; g++) {
    const second = sources.filter((s) => s !== 'coingecko')[Math.floor(rand() * (sources.length - 1))]
    newIn[newIn.length] = { n: Math.floor(rand() * 45), sources: ['coingecko', second] }
  }
  // today: half of the sources land at -15%..+45% of their previous size (used), half at +60%..+400% (held back);
  // never below what the list must hold (then its real ratio decides, and the assertions below use the real ratio)
  const todayCounts: SourceCounts = {}
  for (const s of sources) {
    const used = (rowsWith[s] ?? 0) + newIn.filter((g) => g.sources.includes(s)).reduce((a, g) => a + g.n, 0)
    const ratio = rand() < 0.5 ? 0.85 + rand() * 0.6 : 1.6 + rand() * 2.4
    const wanted = Math.round((prevCounts[s] ?? 1) * ratio)
    todayCounts[s] = Math.max(used, wanted)
  }
  return { chainId, prevRows, rowsWith, prevCounts, todayCounts, newIn }
}

/** what the seeded worlds actually exercised — the last test fails if a branch was never reached */
const stats = { worlds: 0, withHeldSource: 0, withUsedGrownSource: 0, capBit: 0, sizeBoundBit: 0, noAdditions: 0 }

describe('property (seeded): growth breaker + additions cap + size bound, over random source sizes across two runs', () => {
  for (const seed of SEEDS) {
    for (const chainId of [1, 8453, 42161]) {
      it(`seed ${seed}, chain ${chainId}`, async () => {
        const rand = rng(seed * 1000 + chainId)
        const spec = randomSpec(chainId, rand)
        const o = await runWorld(spec, rand)
        const ctx = `seed ${seed} chain ${chainId}`
        const bound = CATALOG_SIZE_BOUND[chainId]
        const sourcesToday = Object.keys(spec.todayCounts) as SourceId[]
        const heldSet = new Set(o.result.heldBackSources.map((h) => h.source))

        // A. exactly the sources over the threshold are held back (both directions), none that is at or under it
        for (const s of sourcesToday) {
          const p = spec.prevCounts[s] ?? 0
          const n = o.world.todayCounts[s]
          const over = p > 0 && n * 100 > p * 150
          expect(heldSet.has(s), `${ctx}: ${s} ${p} → ${n}`).toBe(over)
        }
        // A. a held source is never used: no shipped row lists it unless its previous row already did, and its recorded size is unchanged
        for (const s of heldSet) {
          for (const r of o.decision.catalog) {
            if (r.sources.includes(s)) expect(o.world.previousMap.get(lc(r.address))?.sources.includes(s), `${ctx}: ${s} vote on a row it never had`).toBe(true)
          }
          expect(o.result.sourceCounts[s]).toBe(spec.prevCounts[s])
          // ...and the previous snapshot stood in: a row that listed it before and is still verified (>= 2 votes; an
          // unverified seed carries no votes at all) still lists it — the votes survive
          const byAddr = new Map(o.decision.catalog.map((r) => [lc(r.address), r]))
          for (const prev of o.world.previous) {
            const now = byAddr.get(lc(prev.address))
            if (now?.verified && prev.sources.includes(s)) expect(now.sources.includes(s), `${ctx}: ${prev.symbol} lost its ${s} vote`).toBe(true)
          }
        }
        // the refresh itself is never blocked by any of this
        expect(o.decision.blocked, ctx).toBeNull()

        // B. additions never exceed the cap, nor the room under the size bound
        const adds = additionsOf(o)
        expect(adds.length, ctx).toBeLessThanOrEqual(MAX_ADDITIONS_PER_CHAIN)
        const room = Math.max(0, bound - 1 - spec.prevRows)
        expect(adds.length, ctx).toBeLessThanOrEqual(room)

        // B. the highest-volume candidates are the ones kept
        const kept = adds.map((r) => o.volume7d.get(lc(r.address)) ?? -1)
        const heldBack = o.decision.heldBack.map((l) => o.volume7d.get(lc(l.address)) ?? -1)
        if (kept.length > 0 && heldBack.length > 0) expect(Math.min(...kept), ctx).toBeGreaterThan(Math.max(...heldBack))
        // nothing is lost: every qualified new candidate is either kept or listed as held back
        const qualifiedNew = o.result.tokens.filter((r) => !o.world.previousMap.has(lc(r.address)))
        expect(adds.length + o.decision.heldBack.length, ctx).toBe(qualifiedNew.length)
        // when the cap bit, it bit at exactly the allowed number
        if (o.decision.heldBack.length > 0) expect(adds.length, ctx).toBe(Math.min(MAX_ADDITIONS_PER_CHAIN, room))

        stats.worlds++
        if (heldSet.size > 0) stats.withHeldSource++
        if (sourcesToday.some((s) => !heldSet.has(s) && o.world.todayCounts[s] > (spec.prevCounts[s] ?? 0))) stats.withUsedGrownSource++
        if (o.decision.heldBack.length > 0) {
          stats.capBit++
          if (room < MAX_ADDITIONS_PER_CHAIN) stats.sizeBoundBit++
        }
        if (adds.length === 0) stats.noAdditions++

        // C. the result never fails the guard or the size assertion
        const outcomes = o.audit(o.decision.catalog)
        expect(o.decision.catalog.filter((r) => outcomes.get(lc(r.address))?.status === 'fatal'), ctx).toEqual([])
        expect(o.decision.catalog.length, ctx).toBeLessThan(bound)
      })
    }
  }
})

describe('the seeded worlds exercised every branch', () => {
  it('held sources, used grown sources, the weekly cap, the size-bound clamp and an empty week all occurred', () => {
    expect(stats.worlds).toBe(SEEDS.length * 3)
    if (process.env.TS_PROPERTY_STATS) console.info(`property worlds: ${JSON.stringify(stats)}`)
    for (const k of ['withHeldSource', 'withUsedGrownSource', 'capBit', 'sizeBoundBit', 'noAdditions'] as const) {
      expect(stats[k], `${k} never happened in ${stats.worlds} worlds: ${JSON.stringify(stats)}`).toBeGreaterThan(0)
    }
  })
})
