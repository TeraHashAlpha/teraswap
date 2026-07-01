/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Pure cross-verification core. See verify.test.ts.
 *
 * Identity is ALWAYS the (chainId, EIP-55 address) pair — never the symbol.
 * 'curated' (repo seed) and 'native' (ETH sentinel) are provenance markers, NOT
 * agreement votes: a token qualifies only on independent external source votes.
 */
import { getAddress } from 'viem'
import type {
  AssembleInput,
  BuildReport,
  Candidate,
  CatalogRow,
  GuardOutcome,
  MarketSignal,
  PipelineConfig,
  Rejection,
  SourceEntry,
  SourceId,
  SymbolConflict,
} from './types'
import { CoreTokenValidationError } from './types'
import { PIPELINE_CONFIG } from './config'

// Non-voting provenance markers. 'defillama' is deliberately here (review finding): its
// identity row exists for ANY address with a priced pool — near-automatic precisely for
// the thin/low-liquidity tokens the >=3-source floor targets — so it may never count as
// an agreement vote. It remains in `sources` as provenance and supplies the market signal.
const NON_VOTING: ReadonlySet<SourceId> = new Set<SourceId>(['curated', 'native', 'defillama'])

function key(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

function priorityOf(source: SourceId, cfg: PipelineConfig = PIPELINE_CONFIG): number {
  const i = cfg.sourcePriority.indexOf(source)
  return i === -1 ? cfg.sourcePriority.length : i
}

/** Majority value; ties broken by the highest-priority source that provided a value. */
function consensus<T>(
  values: Array<{ value: T; source: SourceId }>,
  cfg: PipelineConfig = PIPELINE_CONFIG,
): T {
  const counts = new Map<T, { n: number; bestPriority: number }>()
  for (const { value, source } of values) {
    const cur = counts.get(value) ?? { n: 0, bestPriority: Number.POSITIVE_INFINITY }
    cur.n += 1
    cur.bestPriority = Math.min(cur.bestPriority, priorityOf(source, cfg))
    counts.set(value, cur)
  }
  let best: T = values[0].value
  let bestN = -1
  let bestPriority = Number.POSITIVE_INFINITY
  for (const [value, { n, bestPriority: p }] of counts) {
    if (n > bestN || (n === bestN && p < bestPriority)) {
      best = value
      bestN = n
      bestPriority = p
    }
  }
  return best
}

/** Merge normalized source entries into per-(chainId, address) candidates. */
export function mergeByAddress(entries: SourceEntry[]): Candidate[] {
  const groups = new Map<string, SourceEntry[]>()
  for (const e of entries) {
    const k = key(e.chainId, e.address)
    const g = groups.get(k)
    if (g) g.push(e)
    else groups.set(k, [e])
  }
  const out: Candidate[] = []
  for (const g of groups.values()) {
    // one vote per source — a source listing the token twice still counts once
    const bySource = new Map<SourceId, SourceEntry>()
    for (const e of g) if (!bySource.has(e.source)) bySource.set(e.source, e)
    const votes = [...bySource.values()]
    const sources = votes
      .map((v) => v.source)
      .sort((a, b) => priorityOf(a) - priorityOf(b))
    const decimalsValues = votes.map((v) => ({ value: v.decimals, source: v.source }))
    const distinctDecimals = new Set(votes.map((v) => v.decimals))
    const logoSource = votes
      .filter((v) => v.logoURI)
      .sort((a, b) => priorityOf(a.source) - priorityOf(b.source))[0]
    out.push({
      chainId: g[0].chainId,
      address: getAddress(g[0].address), // canonical EIP-55, whatever casing arrived
      sources,
      symbol: consensus(votes.map((v) => ({ value: v.symbol, source: v.source }))),
      name: consensus(votes.map((v) => ({ value: v.name, source: v.source }))),
      decimals: consensus(decimalsValues),
      decimalsDisagree: distinctDecimals.size > 1,
      logoURI: logoSource?.logoURI,
    })
  }
  // deterministic: chainId, then address
  out.sort((a, b) => a.chainId - b.chainId || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
  return out
}

/**
 * Low-liquidity = neither market signal clears its floor. No market data at all is
 * low-liquidity (we cannot show evidence the token trades).
 */
export function isLowLiquidity(m: MarketSignal | undefined, cfg: PipelineConfig): boolean {
  if (m?.volume24hUsd != null && m.volume24hUsd >= cfg.liquidityFloorUsd) return false
  if (m?.priceUsd != null && m.priceConfidence != null && m.priceConfidence >= cfg.defillamaConfidenceMin) {
    return false
  }
  return true
}

/** External-source agreement votes (curated/native/defillama do not count — see NON_VOTING). */
export function externalVoteCount(sources: SourceId[]): number {
  return sources.filter((s) => !NON_VOTING.has(s)).length
}

function voteCount(c: Candidate): number {
  return externalVoteCount(c.sources)
}

/**
 * Source-agreement gate: >= minSources distinct external sources on the same
 * (chainId, address); >= lowLiqMinSources when the market signal is weak/unknown.
 * NEW (non-seed) tokens must also count the required trusted source.
 */
export function crossVerify(
  candidates: Candidate[],
  market: Map<string, MarketSignal>,
  seeds: Set<string>,
  cfg: PipelineConfig,
): { qualified: Candidate[]; rejected: Rejection[] } {
  const qualified: Candidate[] = []
  const rejected: Rejection[] = []
  for (const c of candidates) {
    const k = key(c.chainId, c.address)
    const votes = voteCount(c)
    const lowLiq = isLowLiquidity(market.get(k), cfg)
    const required = lowLiq ? cfg.lowLiqMinSources : cfg.minSources
    if (votes < cfg.minSources) {
      rejected.push({ chainId: c.chainId, address: c.address, symbol: c.symbol, reason: 'insufficient-sources', detail: `${votes} source vote(s)` })
      continue
    }
    if (votes < required) {
      rejected.push({ chainId: c.chainId, address: c.address, symbol: c.symbol, reason: 'insufficient-sources-low-liquidity', detail: `${votes} vote(s) < ${required} required for low-liquidity` })
      continue
    }
    if (!seeds.has(k) && !c.sources.includes(cfg.requiredSourceForNew)) {
      rejected.push({ chainId: c.chainId, address: c.address, symbol: c.symbol, reason: 'missing-required-source', detail: `new token lacks '${cfg.requiredSourceForNew}'` })
      continue
    }
    qualified.push(c)
  }
  return { qualified, rejected }
}

/**
 * At most ONE address may hold a (chainId, symbol) slot. Winner = highest canonical
 * source priority, then more source votes, then higher 24h volume. Losers are rejected
 * + logged — NEVER merged into the winner.
 *
 * A FULL tie (same priority, votes and volume) rejects the WHOLE group (review finding):
 * the old address-order tiebreak was attacker-grindable — a vanity CREATE2 address that
 * sorts first would win the ticker. An unresolvable symbol needs human curation, so we
 * fail closed and log the conflict with kept:null.
 */
export function resolveSymbolConflicts(
  candidates: Candidate[],
  market: Map<string, MarketSignal>,
  cfg: PipelineConfig,
): { kept: Candidate[]; conflicts: SymbolConflict[]; rejected: Rejection[] } {
  const bySymbol = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const k = `${c.chainId}:${c.symbol.toLowerCase()}`
    const g = bySymbol.get(k)
    if (g) g.push(c)
    else bySymbol.set(k, [c])
  }
  const winners = new Set<Candidate>()
  const conflicts: SymbolConflict[] = []
  const rejected: Rejection[] = []
  for (const group of bySymbol.values()) {
    if (group.length === 1) {
      winners.add(group[0])
      continue
    }
    const score = (c: Candidate) => ({
      priority: Math.min(...c.sources.map((s) => priorityOf(s, cfg))),
      votes: voteCount(c),
      volume: market.get(key(c.chainId, c.address))?.volume24hUsd ?? 0,
    })
    const cmp = (a: Candidate, b: Candidate) => {
      const sa = score(a)
      const sb = score(b)
      return sa.priority - sb.priority || sb.votes - sa.votes || sb.volume - sa.volume
    }
    const ranked = [...group].sort((a, b) => cmp(a, b) || (a.address < b.address ? -1 : 1))
    const winner = ranked[0]
    if (cmp(winner, ranked[1]) === 0) {
      // unresolvable tie — fail closed, nobody gets the ticker
      conflicts.push({
        chainId: winner.chainId,
        symbol: winner.symbol,
        kept: null,
        rejected: ranked.map((l) => l.address),
      })
      for (const l of ranked) {
        rejected.push({ chainId: l.chainId, address: l.address, symbol: l.symbol, reason: 'symbol-conflict', detail: 'unresolvable tie — needs curation' })
      }
      continue
    }
    winners.add(winner)
    const losers = ranked.slice(1)
    conflicts.push({
      chainId: winner.chainId,
      symbol: winner.symbol,
      kept: winner.address,
      rejected: losers.map((l) => l.address),
    })
    for (const l of losers) {
      rejected.push({ chainId: l.chainId, address: l.address, symbol: l.symbol, reason: 'symbol-conflict', detail: `symbol held by ${winner.address}` })
    }
  }
  return { kept: candidates.filter((c) => winners.has(c)), conflicts, rejected }
}

/** Map a guard outcome onto a rejection reason. Missing outcome = never audited = unverifiable. */
function guardReason(outcome: GuardOutcome | undefined): Rejection['reason'] | null {
  if (!outcome) return 'guard-unverifiable'
  if (outcome.status === 'pass') return null
  return outcome.status === 'fatal' ? 'guard-fatal' : 'guard-unverifiable'
}

const cp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Assemble the final per-chain catalog:
 *  - qualified candidates that PASS the (reused) catalog guard → verified:true (+sources)
 *  - NEW candidates with a fatal/unverifiable guard outcome are dropped (rejection logged)
 *  - SEEDS are NEVER silently dropped — kept with verified:false + flagged
 *  - CORES are ALWAYS present; a core not PASSING the guard THROWS (fail-closed)
 *  - a NEW token colliding with a preserved seed's symbol is dropped (keeps the guard's
 *    duplicate-symbol gate green)
 *  - the new-token growth cap keeps highest-volume tokens; overflow is reported
 */
export function assembleCatalog(input: AssembleInput): { tokens: CatalogRow[]; report: BuildReport } {
  const { chainId, qualified, guard, seeds, cores, market, config, categoryFor, logoFor } = input
  const rows = new Map<string, CatalogRow>()
  const report: BuildReport = {
    chainId,
    included: 0,
    verified: 0,
    unverifiedSeeds: [],
    rejections: [],
    conflicts: [],
    capped: [],
  }

  // 1. qualified candidates → guard gate (the existing catalog guard, reused)
  for (const c of qualified) {
    const addrLower = c.address.toLowerCase()
    const outcome = guard.get(addrLower)
    const failure = guardReason(outcome)
    if (failure === null) {
      rows.set(addrLower, {
        address: c.address,
        symbol: c.symbol,
        name: c.name,
        decimals: c.decimals,
        category: seeds.get(addrLower)?.category ?? categoryFor(chainId, c.address, c.symbol),
        logoURI: logoFor(chainId, c.address, c.symbol),
        verified: true,
        sources: c.sources,
      })
    } else if (seeds.has(addrLower)) {
      // seed failed the guard — keep it, honest ⚠, loudly flagged
      const seed = seeds.get(addrLower)!
      rows.set(addrLower, seedRow(chainId, seed, c.sources, categoryFor, logoFor))
      report.unverifiedSeeds.push({ address: seed.address, symbol: seed.symbol, reason: failure })
    } else {
      report.rejections.push({ chainId, address: c.address, symbol: c.symbol, reason: failure, detail: outcome?.detail })
    }
  }

  // 2. growth cap on NEW tokens (not seed, not core) — highest volume first, overflow logged
  const coreAddrs = new Set(cores.map((t) => t.address.toLowerCase()))
  const cap = config.maxNewTokensPerChain[chainId] ?? Number.POSITIVE_INFINITY
  const newRows = [...rows.entries()].filter(([k]) => !seeds.has(k) && !coreAddrs.has(k))
  if (newRows.length > cap) {
    const rank = (k: string, r: CatalogRow) => ({
      volume: market.get(k)?.volume24hUsd ?? 0,
      votes: r.sources.filter((s) => !NON_VOTING.has(s)).length,
    })
    newRows.sort(([ka, a], [kb, b]) => {
      const ra = rank(ka, a)
      const rb = rank(kb, b)
      return rb.volume - ra.volume || rb.votes - ra.votes || cp(a.symbol.toLowerCase(), b.symbol.toLowerCase())
    })
    for (const [k, r] of newRows.slice(cap)) {
      rows.delete(k)
      report.capped.push({ address: r.address, symbol: r.symbol })
    }
  }

  // 3. seeds that never qualified — keep, honest ⚠, flagged
  for (const [addrLower, seed] of seeds) {
    if (rows.has(addrLower)) continue
    rows.set(addrLower, seedRow(chainId, seed, ['curated'], categoryFor, logoFor))
    report.unverifiedSeeds.push({ address: seed.address, symbol: seed.symbol, reason: 'insufficient-sources' })
  }

  // 3b. a NEW row colliding with a preserved seed/core symbol would trip the guard's
  // duplicate-symbol fatal at CI — drop the NEW one (the curated entry wins), logged.
  const protectedSymbols = new Map<string, string>() // symbolLower → addrLower that owns it
  for (const [addrLower, row] of rows) {
    if (seeds.has(addrLower)) protectedSymbols.set(row.symbol.toLowerCase(), addrLower)
  }
  for (const core of cores) protectedSymbols.set(core.symbol.toLowerCase(), core.address.toLowerCase())
  for (const [addrLower, row] of [...rows]) {
    if (seeds.has(addrLower)) continue
    const owner = protectedSymbols.get(row.symbol.toLowerCase())
    if (owner && owner !== addrLower) {
      rows.delete(addrLower)
      report.rejections.push({ chainId, address: row.address, symbol: row.symbol, reason: 'symbol-conflict', detail: `symbol held by curated ${owner}` })
    }
  }

  // 4. cores — always present, always guard-validated (or the native sentinel)
  for (const core of cores) {
    const addrLower = core.address.toLowerCase()
    if (core.native) {
      rows.set(addrLower, {
        address: core.address,
        symbol: core.symbol,
        name: core.name,
        decimals: core.decimals,
        category: 'Native',
        logoURI: logoFor(chainId, core.address, core.symbol),
        verified: true,
        sources: ['native'],
        core: true,
      })
      continue
    }
    const outcome = guard.get(addrLower)
    if (guardReason(outcome) !== null) {
      throw new CoreTokenValidationError(
        `core token ${core.symbol} (${core.address}) on chain ${chainId}: guard outcome ${outcome?.status ?? 'missing'}${outcome?.detail ? ` (${outcome.detail})` : ''} — refusing to ship an unvalidated core`,
      )
    }
    const existing = rows.get(addrLower)
    if (existing) {
      existing.core = true
      existing.verified = true // pinned + guard-validated
    } else {
      rows.set(addrLower, {
        address: core.address,
        symbol: core.symbol,
        name: core.name,
        decimals: core.decimals,
        category: seeds.get(addrLower)?.category ?? categoryFor(chainId, core.address, core.symbol),
        logoURI: logoFor(chainId, core.address, core.symbol),
        verified: true,
        sources: ['curated'],
        core: true,
      })
    }
  }

  // 5. deterministic order: native sentinel first, then lowercase-symbol codepoint, then address
  const nativeLower = cores.find((t) => t.native)?.address.toLowerCase()
  const tokens = [...rows.values()].sort((a, b) => {
    const aNative = a.address.toLowerCase() === nativeLower ? 0 : 1
    const bNative = b.address.toLowerCase() === nativeLower ? 0 : 1
    return aNative - bNative || cp(a.symbol.toLowerCase(), b.symbol.toLowerCase()) || cp(a.address, b.address)
  })

  report.included = tokens.length
  report.verified = tokens.filter((t) => t.verified).length
  return { tokens, report }
}

function seedRow(
  chainId: number,
  seed: AssembleInput['seeds'] extends Map<string, infer S> ? S : never,
  sources: SourceId[],
  categoryFor: AssembleInput['categoryFor'],
  logoFor: AssembleInput['logoFor'],
): CatalogRow {
  return {
    address: seed.address,
    symbol: seed.symbol,
    name: seed.name,
    decimals: seed.decimals,
    category: seed.category ?? categoryFor(chainId, seed.address, seed.symbol),
    logoURI: seed.logoURI ?? logoFor(chainId, seed.address, seed.symbol),
    verified: false,
    sources,
  }
}

