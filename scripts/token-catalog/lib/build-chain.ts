/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] buildChainCatalog — the per-chain orchestration:
 *
 *   fetch sources (outage-tolerant) → normalize/merge by (chainId, EIP-55 address)
 *   → cross-verify (>=2 sources, >=3 low-liquidity) → resolve symbol conflicts
 *   → route candidates THROUGH the existing catalog guard (shared verdict collector
 *     + auditChain — reused, not reimplemented) → assemble (cores forced, seeds
 *     preserved, caps logged).
 *
 * All I/O is dependency-injected (fetchers, DefiLlama market fetch, verdict collector)
 * so the orchestration is unit-testable with zero network. The returned verdicts let the
 * caller refresh catalog-guard.trust.json from the SAME single network pass.
 */
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import type {
  BuildReport,
  CatalogRow,
  CoreToken,
  MarketSignal,
  PipelineConfig,
  SeedToken,
  SourceEntry,
  SourceFetchResult,
  SourceId,
  TrustLostSeed,
} from './types'
import type { TokenIdentity } from './verdicts'
import { mergeByAddress, crossVerify, resolveSymbolConflicts, assembleCatalog, externalVoteCount, retainFlakySeeds } from './verify'
import { deriveGuardOutcomes } from './guard-gate'

/**
 * [fix/catalog-continuity-drop-on-trust-loss — issue #518] CONTINUITY POLICY: drop on trust
 * loss, never freeze.
 *
 * Continuity seeding (`deps.seeds`, step 2 below) exists so a source outage can never silently
 * drop a live catalog row. It must NOT also mean a row can never LEAVE: a continuity seed whose
 * fresh verdict says `inTrustedList === false` AND that no longer reaches `minSources` external
 * agreement is DROPPED here and reported in `report.trustLost` — loudly, never silently.
 *
 * Why: the trusted-list FATAL (catalog-guard.ts:139-143) exists to stop an untrusted address
 * ENTERING the catalog. Applied to a row that merely LOST its listing, it froze the whole chain's
 * refresh instead (chain 1 from 2026-09-21, HANU) — the guard's purpose inverted. This is strictly
 * a NARROWING: fewer tokens can persist, and nothing new can enter more easily.
 *
 * Deliberately UNCHANGED by this policy:
 *  - a NEW address failing the trusted-list check is still fatal (no previous row ⇒ no seed);
 *  - cores are still forced and still throw on any guard failure (verify.ts assembleCatalog);
 *  - hand-curated seeds (`deps.handCuratedSeeds`) are never dropped — a human pinned them;
 *  - `inTrustedList === null` (CoinGecko unreachable) stays warn-only, so an outage drops nothing;
 *  - a seed that still has >= minSources external votes is KEPT (and, being untrusted, still
 *    reds the gate — a human decides: allowlist entry or curated REMOVAL);
 *  - curated REMOVALS win outright — a removed token never reaches this code as a seed.
 */
export const CONTINUITY_DROP_ON_TRUST_LOSS = 'continuity-drop-on-trust-loss' as const

export interface ChainBuildDeps {
  fetchSources: Array<() => Promise<SourceFetchResult>>
  /** Second-phase market fetch (DefiLlama) over the union of discovered addresses. */
  fetchMarket?: (addresses: `0x${string}`[]) => Promise<SourceFetchResult>
  /** [fix/token-search-ranking-squatting Task 2] Third-phase 24h-volume fetch (CoinGecko
   *  /coins/markets), same target addresses as fetchMarket. Outage-tolerant like it. */
  fetchVolume?: (addresses: `0x${string}`[]) => Promise<SourceFetchResult>
  collectVerdicts: (tokens: TokenIdentity[]) => Promise<Verdict[]>
  allowlist: Allowlist
  /** Current-catalog seeds, keyed by LOWERCASE address. Never silently dropped. */
  seeds: Map<string, SeedToken>
  cores: CoreToken[]
  config: PipelineConfig
  categoryFor: (chainId: number, address: string, symbol: string) => string
  logoFor: (chainId: number, address: string, symbol: string) => string
  log: (msg: string) => void
  /** [fix/token-search-ranking-squatting Task 3] The chain's PREVIOUSLY-committed catalog
   *  rows, keyed by lowercase address — lets a single-source flake be told apart from a
   *  real delisting. Omitted (e.g. in older tests) ⇒ no retention, previous behavior. */
  previousCatalog?: Map<string, CatalogRow>
  /** [fix/catalog-continuity-drop-on-trust-loss] Lowercase addresses pinned BY HAND in this
   *  repo (mainnet DEFAULT_TOKENS, CURATED_BASE_SEEDS, CURATED_ARBITRUM_SEEDS) — exempt from
   *  CONTINUITY_DROP_ON_TRUST_LOSS. Omitted ⇒ every seed is a continuity seed. */
  handCuratedSeeds?: ReadonlySet<string>
  /** ISO date stamped onto every emitted row's volumeFetchedAt. Defaults to "now". */
  builtAt?: string
}

export interface ChainBuildResult {
  tokens: CatalogRow[]
  report: BuildReport
  sourcesUsed: SourceId[]
  sourceNotes: string[]
  verdicts: Verdict[]
  /** `${chainId}:${addrLower}`-keyed market signals (for reporting). */
  market: Map<string, MarketSignal>
}

export async function buildChainCatalog(chainId: number, deps: ChainBuildDeps): Promise<ChainBuildResult> {
  const { config, seeds, cores, allowlist, categoryFor, logoFor, log } = deps
  const sourceNotes: string[] = []
  const sourcesUsed: SourceId[] = []
  const entries: SourceEntry[] = []
  const market = new Map<string, MarketSignal>()

  // 1. fetch every source — an outage is logged and skipped, NEVER fatal
  const settled = await Promise.allSettled(deps.fetchSources.map((f) => f()))
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const { source, entries: fetched, market: m, note } = s.value
      sourcesUsed.push(source)
      entries.push(...fetched)
      if (m) for (const [k, v] of m) market.set(k, { ...market.get(k), ...v })
      if (note) {
        sourceNotes.push(`${source}: ${note}`)
        log(`source ${source}: ${note}`)
      }
    } else {
      const msg = String((s.reason as Error)?.message ?? s.reason)
      sourceNotes.push(`DOWN ${msg}`)
      log(`source down (build continues): ${msg}`)
    }
  }

  // 2. seeds join the pool as 'curated' provenance (canonical priority in conflicts;
  //    NOT an agreement vote — see crossVerify)
  for (const seed of seeds.values()) {
    entries.push({
      chainId,
      address: seed.address,
      symbol: seed.symbol,
      name: seed.name,
      decimals: seed.decimals,
      logoURI: seed.logoURI,
      source: 'curated',
    })
  }

  // 3. merge by (chainId, checksummed address)
  const candidates = mergeByAddress(entries)

  // 4. second/third-phase market signal fetches — DefiLlama (price/identity) and CoinGecko
  // (24h volume), both over candidates that can actually qualify (>= minSources external
  // votes) plus seeds (whose signal can legitimately promote/retain them). Everything else
  // gets rejected by crossVerify regardless, and a defillama price alone must not promote a
  // single-list NEW token (price presence is near-automatic for anything with a pool — too
  // weak as a second identity source).
  const marketTargets = candidates.filter(
    (c) => externalVoteCount(c.sources) >= config.minSources || seeds.has(c.address.toLowerCase()),
  )
  if (deps.fetchMarket) {
    try {
      const res = await deps.fetchMarket(marketTargets.map((c) => c.address))
      if (res.market) for (const [k, v] of res.market) market.set(k, { ...market.get(k), ...v })
      // defillama identity votes (symbol+decimals agreeing coins) join the pool
      if (res.entries.length > 0) {
        sourcesUsed.push(res.source)
        entries.push(...res.entries)
      }
      if (res.note) sourceNotes.push(`${res.source}: ${res.note}`)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      sourceNotes.push(`DOWN market: ${msg}`)
      log(`market fetch down (build continues): ${msg}`)
    }
  }
  if (deps.fetchVolume) {
    try {
      const res = await deps.fetchVolume(marketTargets.map((c) => c.address))
      if (res.market) for (const [k, v] of res.market) market.set(k, { ...market.get(k), ...v })
      if (res.note) sourceNotes.push(`${res.source} volume: ${res.note}`)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      sourceNotes.push(`DOWN volume: ${msg}`)
      log(`volume fetch down (build continues): ${msg}`)
    }
  }

  // re-merge when the market phase added identity votes
  const merged = entries.length > candidates.length ? mergeByAddress(entries) : candidates

  // 5. cross-verify + symbol-conflict resolution
  const seedKeys = new Set([...seeds.keys()].map((a) => `${chainId}:${a}`))
  const crossVerified = crossVerify(merged, market, seedKeys, config)

  // 5a''. [fix/token-search-ranking-squatting Task 3] Retain a previously-verified seed
  // whose vote drop this run is attributable to a source outage, not a real delisting —
  // logged as retained (never silent). New candidates are unaffected: retainFlakySeeds only
  // ever pulls from `rejected`, and a brand-new candidate has no previousCatalog row to match.
  const retention = deps.previousCatalog
    ? retainFlakySeeds(crossVerified.rejected, merged, deps.previousCatalog, sourcesUsed, config)
    : { qualified: [] as ReturnType<typeof retainFlakySeeds>['qualified'], rejected: crossVerified.rejected, retained: [] as ReturnType<typeof retainFlakySeeds>['retained'] }
  for (const r of retention.retained) {
    log(`retained from previous (source flake: ${r.missingSources.join(', ')}): ${r.symbol} ${r.address}`)
  }
  const qualified = [...crossVerified.qualified, ...retention.qualified]
  const rejected = retention.rejected
  const conflictResult = resolveSymbolConflicts(qualified, market, config)

  // 5a. protect curated symbols BEFORE the guard audit (review finding): a NEW candidate
  // holding a seed/core ticker at a different address must lose here — if it reached the
  // audit set, the guard's duplicate-symbol FATAL would mark BOTH sides, and a collision
  // with a CORE ticker (e.g. a 2-list "USDC" impostor) would fail the whole build.
  const protectedSym = new Map<string, string>() // symbolLower → owning addrLower
  for (const s of seeds.values()) protectedSym.set(s.symbol.toLowerCase(), s.address.toLowerCase())
  for (const c of cores) protectedSym.set(c.symbol.toLowerCase(), c.address.toLowerCase())
  conflictResult.kept = conflictResult.kept.filter((c) => {
    const owner = protectedSym.get(c.symbol.toLowerCase())
    if (owner && owner !== c.address.toLowerCase()) {
      conflictResult.rejected.push({ chainId, address: c.address, symbol: c.symbol, reason: 'symbol-conflict', detail: `symbol held by curated ${owner}` })
      return false
    }
    return true
  })

  // 5b. pre-guard growth pruning — don't on-chain-probe hundreds of NEW candidates the
  // maxNewTokensPerChain cap would discard anyway. Same ranking as the assemble cap
  // (volume desc, votes desc, symbol); pruned tokens are reported as capped (no silent caps).
  const coreAddrSet = new Set(cores.map((t) => t.address.toLowerCase()))
  const cap = config.maxNewTokensPerChain[chainId] ?? Number.POSITIVE_INFINITY
  const prunedCapped: Array<{ address: `0x${string}`; symbol: string }> = []
  let kept = conflictResult.kept
  if (Number.isFinite(cap)) {
    const isNew = (c: (typeof kept)[number]) =>
      !seeds.has(c.address.toLowerCase()) && !coreAddrSet.has(c.address.toLowerCase())
    const newOnes = kept.filter(isNew)
    if (newOnes.length > cap) {
      const rank = (c: (typeof kept)[number]) => ({
        volume: market.get(`${chainId}:${c.address.toLowerCase()}`)?.volume24hUsd ?? 0,
        votes: externalVoteCount(c.sources),
      })
      const ranked = [...newOnes].sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        return rb.volume - ra.volume || rb.votes - ra.votes || (a.symbol.toLowerCase() < b.symbol.toLowerCase() ? -1 : 1)
      })
      const keepNew = new Set(ranked.slice(0, cap))
      kept = kept.filter((c) => !isNew(c) || keepNew.has(c))
      for (const c of ranked.slice(cap)) prunedCapped.push({ address: c.address, symbol: c.symbol })
      log(`growth cap: probing top ${cap} of ${newOnes.length} new candidates (${prunedCapped.length} capped pre-guard)`)
    }
  }
  conflictResult.kept = kept

  // 6. route through the EXISTING catalog guard: qualified ∪ seeds ∪ cores, deduplicated
  const auditables = new Map<string, TokenIdentity & { decimals?: number }>()
  for (const c of conflictResult.kept) {
    auditables.set(c.address.toLowerCase(), { chainId, address: c.address, symbol: c.symbol, decimals: c.decimals })
  }
  for (const seed of seeds.values()) {
    const k = seed.address.toLowerCase()
    if (!auditables.has(k)) auditables.set(k, { chainId, address: seed.address, symbol: seed.symbol, decimals: seed.decimals })
  }
  for (const core of cores) {
    const k = core.address.toLowerCase()
    if (!core.native && !auditables.has(k)) {
      auditables.set(k, { chainId, address: core.address, symbol: core.symbol, decimals: core.decimals })
    }
  }
  const auditList = [...auditables.values()]
  const verdicts = await deps.collectVerdicts(auditList)
  const guard = deriveGuardOutcomes(chainId, auditList, verdicts, allowlist)

  // 6b. CONTINUITY_DROP_ON_TRUST_LOSS (see the constant above) — a continuity seed that lost
  // BOTH its trusted-list membership and its external agreement leaves now, reported, instead
  // of riding along as an untrusted row that reds the gate and freezes the chain's refresh.
  const verdictByAddr = new Map<string, Verdict>()
  for (const v of verdicts) {
    if (v.chainId === chainId) verdictByAddr.set(v.address.toLowerCase(), v)
  }
  const handCurated = deps.handCuratedSeeds ?? new Set<string>()
  const votesFor = (addrLower: string): number => {
    const inKept = conflictResult.kept.find((c) => c.address.toLowerCase() === addrLower)
    const inMerged = merged.find((c) => c.address.toLowerCase() === addrLower)
    return Math.max(
      inKept ? externalVoteCount(inKept.sources) : 0,
      inMerged ? externalVoteCount(inMerged.sources) : 0,
    )
  }
  const trustLost: TrustLostSeed[] = []
  const dropped = new Set<string>()
  for (const [addrLower, seed] of seeds) {
    if (coreAddrSet.has(addrLower)) continue // cores are forced, never dropped
    if (handCurated.has(addrLower)) continue // a human pinned this one
    // inTrustedList true ⇒ nothing to do; null ⇒ warn-only (CoinGecko unreachable at refresh)
    if (verdictByAddr.get(addrLower)?.inTrustedList !== false) continue
    const votes = votesFor(addrLower)
    if (votes >= config.minSources) continue // still independently agreed — a human decides
    dropped.add(addrLower)
    trustLost.push({
      address: seed.address,
      symbol: seed.symbol,
      reason: `not in any trusted list, ${votes} external vote(s) < ${config.minSources} required`,
    })
    log(`removed (trust lost: ${trustLost[trustLost.length - 1].reason}): ${seed.symbol} ${seed.address}`)
  }
  const liveSeeds = dropped.size === 0 ? seeds : new Map([...seeds].filter(([k]) => !dropped.has(k)))
  if (dropped.size > 0) {
    conflictResult.kept = conflictResult.kept.filter((c) => !dropped.has(c.address.toLowerCase()))
  }

  // 7. assemble — cores forced (throw on guard failure), seeds preserved, caps logged
  const marketByAddr = new Map<string, MarketSignal>()
  for (const [k, v] of market) {
    const [cid, addr] = k.split(':')
    if (Number(cid) === chainId) marketByAddr.set(addr, v)
  }
  const { tokens, report } = assembleCatalog({
    chainId,
    qualified: conflictResult.kept,
    guard,
    seeds: liveSeeds,
    cores,
    market: marketByAddr,
    config,
    categoryFor,
    logoFor,
    builtAt: deps.builtAt ?? new Date().toISOString().slice(0, 10),
  })
  report.rejections.push(...rejected, ...conflictResult.rejected)
  report.conflicts.push(...conflictResult.conflicts)
  report.capped.push(...prunedCapped)
  report.retained.push(...retention.retained)
  report.trustLost.push(...trustLost)

  return { tokens, report, sourcesUsed, sourceNotes, verdicts, market }
}
