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
} from './types'
import type { TokenIdentity } from './verdicts'
import { mergeByAddress, crossVerify, resolveSymbolConflicts, assembleCatalog, externalVoteCount } from './verify'
import { deriveGuardOutcomes } from './guard-gate'

export interface ChainBuildDeps {
  fetchSources: Array<() => Promise<SourceFetchResult>>
  /** Second-phase market fetch (DefiLlama) over the union of discovered addresses. */
  fetchMarket?: (addresses: `0x${string}`[]) => Promise<SourceFetchResult>
  collectVerdicts: (tokens: TokenIdentity[]) => Promise<Verdict[]>
  allowlist: Allowlist
  /** Current-catalog seeds, keyed by LOWERCASE address. Never silently dropped. */
  seeds: Map<string, SeedToken>
  cores: CoreToken[]
  config: PipelineConfig
  categoryFor: (chainId: number, address: string, symbol: string) => string
  logoFor: (chainId: number, address: string, symbol: string) => string
  log: (msg: string) => void
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

  // 4. second-phase market fetch (DefiLlama batch) — only over candidates that can actually
  // qualify (>= minSources external votes) plus seeds (whose defillama identity vote can
  // legitimately promote them). Everything else gets rejected by crossVerify regardless, and
  // a defillama price alone must not promote a single-list NEW token (price presence is
  // near-automatic for anything with a pool — too weak as a second identity source).
  if (deps.fetchMarket) {
    const marketTargets = candidates.filter(
      (c) => externalVoteCount(c.sources) >= config.minSources || seeds.has(c.address.toLowerCase()),
    )
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

  // re-merge when the market phase added identity votes
  const merged = entries.length > candidates.length ? mergeByAddress(entries) : candidates

  // 5. cross-verify + symbol-conflict resolution
  const seedKeys = new Set([...seeds.keys()].map((a) => `${chainId}:${a}`))
  const { qualified, rejected } = crossVerify(merged, market, seedKeys, config)
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
    seeds,
    cores,
    market: marketByAddr,
    config,
    categoryFor,
    logoFor,
  })
  report.rejections.push(...rejected, ...conflictResult.rejected)
  report.conflicts.push(...conflictResult.conflicts)
  report.capped.push(...prunedCapped)

  return { tokens, report, sourcesUsed, sourceNotes, verdicts, market }
}
