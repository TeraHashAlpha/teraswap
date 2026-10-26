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
  RetainedSeed,
  SingleSourceAdmission,
  SingleSourceConfig,
  SingleSourceReport,
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

const cp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

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

/**
 * [fix/token-search-ranking-squatting Task 3] A previous-catalog row with >=2-source
 * agreement that this run rejected for insufficient-sources(-low-liquidity) is retained
 * when the shortfall is attributable to a source that returned NOTHING this run (down/rate
 * limited) — never a source that ran fine but simply stopped listing the token, which is
 * real signal. Brand-new candidates (no previous row) are never retained; they still need
 * full agreement. Pure and unit-testable: sourcesUsedThisRun is exactly what the caller's
 * source-fetch phase actually returned data for.
 */
export function retainFlakySeeds(
  rejected: Rejection[],
  merged: Candidate[],
  previousCatalog: Map<string, CatalogRow>,
  sourcesUsedThisRun: SourceId[],
  config: PipelineConfig,
): { qualified: Candidate[]; rejected: Rejection[]; retained: RetainedSeed[] } {
  const qualified: Candidate[] = []
  const stillRejected: Rejection[] = []
  const retained: RetainedSeed[] = []
  const usedThisRun = new Set(sourcesUsedThisRun)
  for (const r of rejected) {
    if (r.reason !== 'insufficient-sources' && r.reason !== 'insufficient-sources-low-liquidity') {
      stillRejected.push(r)
      continue
    }
    const prev = previousCatalog.get(r.address.toLowerCase())
    const prevSources = (prev?.sources ?? []) as SourceId[]
    if (!prev || !prev.verified || externalVoteCount(prevSources) < config.minSources) {
      stillRejected.push(r)
      continue
    }
    const missing = prevSources.filter((s) => !NON_VOTING.has(s) && !usedThisRun.has(s))
    if (missing.length === 0) {
      // nothing that previously voted is down this run — the drop is real, not a flake
      stillRejected.push(r)
      continue
    }
    const existing = merged.find((c) => c.address.toLowerCase() === r.address.toLowerCase())
    const candidate: Candidate = existing
      ? { ...existing, sources: prevSources }
      : {
          chainId: r.chainId,
          address: prev.address,
          sources: prevSources,
          symbol: prev.symbol,
          name: prev.name,
          decimals: prev.decimals,
          decimalsDisagree: false,
          logoURI: prev.logoURI,
        }
    qualified.push(candidate)
    retained.push({ address: prev.address, symbol: prev.symbol, missingSources: missing })
  }
  return { qualified, rejected: stillRejected, retained }
}

function voteCount(c: Candidate): number {
  return externalVoteCount(c.sources)
}

/**
 * [feat/catalog-single-source-volume] Effective single-source rule for one chain: the default
 * `cfg.singleSource` with that chain's partial override from `cfg.singleSourceByChain` merged on top.
 */
export function resolveSingleSourceConfig(cfg: PipelineConfig, chainId: number): SingleSourceConfig {
  return { ...cfg.singleSource, ...(cfg.singleSourceByChain?.[chainId] ?? {}) }
}

/** The rule only ever applies to a candidate with EXACTLY ONE external vote, and that vote is CoinGecko. */
export function isSingleSourceCoingecko(c: Candidate): boolean {
  return externalVoteCount(c.sources) === 1 && c.sources.includes('coingecko')
}

export function medianOf(values: number[]): number {
  const v = [...values].sort((a, b) => a - b)
  if (v.length === 0) return 0
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** Daily 24h-USD-volume history for one token, oldest → newest, or why it could not be read. */
export type VolumeHistory = { ok: true; dailyVolumeUsd: number[] } | { ok: false; error: string }

export type SingleSourceVerdict =
  | { status: 'admitted'; admission: SingleSourceAdmission; medianUsd: number }
  | { status: 'below-floor'; dailyVolumeUsd: number[]; medianUsd: number; detail: string }
  | { status: 'fetch-failed'; detail: string }

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/**
 * [feat/catalog-single-source-volume] Pure verdict for one single-source candidate. Fail-closed:
 * any unreadable/malformed history is 'fetch-failed' (never admitted); fewer than `days` complete
 * days of history is 'below-floor' (no evidence the token traded for the whole window).
 * requireEveryDay=true ⇒ every one of the last `days` values must be >= minDailyVolumeUsd;
 * false ⇒ their median must be.
 */
export function evaluateSingleSource(history: VolumeHistory, cfg: SingleSourceConfig): SingleSourceVerdict {
  if (!history.ok) return { status: 'fetch-failed', detail: history.error }
  if (history.dailyVolumeUsd.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
    return { status: 'fetch-failed', detail: 'malformed volume history' }
  }
  const window = history.dailyVolumeUsd.slice(-cfg.days)
  const medianUsd = medianOf(window)
  if (window.length < cfg.days) {
    return { status: 'below-floor', dailyVolumeUsd: window, medianUsd, detail: `only ${window.length} of ${cfg.days} daily volume values` }
  }
  const pass = cfg.requireEveryDay ? window.every((v) => v >= cfg.minDailyVolumeUsd) : medianUsd >= cfg.minDailyVolumeUsd
  if (!pass) {
    const worst = Math.min(...window)
    return {
      status: 'below-floor',
      dailyVolumeUsd: window,
      medianUsd,
      detail: `${cfg.requireEveryDay ? `min ${usd(worst)}` : `median ${usd(medianUsd)}`} < ${usd(cfg.minDailyVolumeUsd)} over ${cfg.days} days`,
    }
  }
  return {
    status: 'admitted',
    medianUsd,
    admission: { rule: 'single-source-volume', dailyVolumeUsd: window, minDailyVolumeUsd: cfg.minDailyVolumeUsd, days: cfg.days },
  }
}

/**
 * Source-agreement gate: >= minSources distinct external sources on the same
 * (chainId, address); >= lowLiqMinSources when the market signal is weak/unknown.
 * NEW (non-seed) tokens must also count the required trusted source.
 *
 * [feat/catalog-single-source-volume] `singleSource` (key `${chainId}:${addrLower}`) carries the
 * volume-rule verdicts for candidates with exactly one CoinGecko vote. It can only ADD a
 * qualification: an 'admitted' verdict lets that one candidate skip the vote floors (it still
 * faces the requiredSourceForNew check), anything else leaves the existing rejection. Two-source
 * candidates never consult it.
 */
export function crossVerify(
  candidates: Candidate[],
  market: Map<string, MarketSignal>,
  seeds: Set<string>,
  cfg: PipelineConfig,
  singleSource?: Map<string, SingleSourceVerdict>,
): { qualified: Candidate[]; rejected: Rejection[] } {
  const qualified: Candidate[] = []
  const rejected: Rejection[] = []
  for (const c of candidates) {
    const k = key(c.chainId, c.address)
    const votes = voteCount(c)
    const lowLiq = isLowLiquidity(market.get(k), cfg)
    const required = lowLiq ? cfg.lowLiqMinSources : cfg.minSources
    let admission: SingleSourceAdmission | undefined
    if (votes < cfg.minSources) {
      const verdict = isSingleSourceCoingecko(c) ? singleSource?.get(k) : undefined
      if (verdict?.status !== 'admitted') {
        const base = { chainId: c.chainId, address: c.address, symbol: c.symbol, reason: 'insufficient-sources' as const }
        if (verdict?.status === 'below-floor') {
          rejected.push({ ...base, detail: `${votes} source vote(s); single-source-volume: ${verdict.detail}`, singleSource: 'below-floor' })
        } else if (verdict?.status === 'fetch-failed') {
          rejected.push({ ...base, detail: `${votes} source vote(s); single-source-volume: history unavailable (${verdict.detail})`, singleSource: 'fetch-failed' })
        } else {
          rejected.push({ ...base, detail: `${votes} source vote(s)` })
        }
        continue
      }
      admission = verdict.admission
    } else if (votes < required) {
      rejected.push({ chainId: c.chainId, address: c.address, symbol: c.symbol, reason: 'insufficient-sources-low-liquidity', detail: `${votes} vote(s) < ${required} required for low-liquidity` })
      continue
    }
    if (!seeds.has(k) && !c.sources.includes(cfg.requiredSourceForNew)) {
      rejected.push({ chainId: c.chainId, address: c.address, symbol: c.symbol, reason: 'missing-required-source', detail: `new token lacks '${cfg.requiredSourceForNew}'` })
      continue
    }
    qualified.push(admission ? { ...c, admission } : c)
  }
  return { qualified, rejected }
}

/**
 * [feat/catalog-single-source-volume] Ordering for the per-run NEW-token cap, shared by the
 * pre-guard prune (build-chain.ts) and the assemble-time cap so they can never disagree.
 * Two-source tokens (today's rules) rank FIRST, exactly as before (volume, votes, symbol);
 * single-source admissions fill whatever slots remain, by descending 7-day median volume — so the
 * new rule can never displace a token that would have been admitted without it.
 */
export interface CapRankItem {
  address: string
  symbol: string
  volume: number
  votes: number
  admission?: SingleSourceAdmission
}
export function compareForCap(a: CapRankItem, b: CapRankItem): number {
  const ta = a.admission ? 1 : 0
  const tb = b.admission ? 1 : 0
  if (ta !== tb) return ta - tb
  if (a.admission && b.admission) {
    return (
      medianOf(b.admission.dailyVolumeUsd) - medianOf(a.admission.dailyVolumeUsd) ||
      cp(a.symbol.toLowerCase(), b.symbol.toLowerCase()) ||
      cp(a.address.toLowerCase(), b.address.toLowerCase())
    )
  }
  return b.volume - a.volume || b.votes - a.votes || cp(a.symbol.toLowerCase(), b.symbol.toLowerCase()) || cp(a.address.toLowerCase(), b.address.toLowerCase())
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

/** [fix/token-search-ranking-squatting Task 2] volume24hUsd/volumeSource/volumeFetchedAt
 *  for one row — NULL across all three when no source resolved a volume (never a 0, which
 *  would sort as "worse than a confirmed zero-liquidity squatter"). */
function volumeFields(
  addrLower: string,
  market: Map<string, MarketSignal>,
  builtAt: string,
): Pick<CatalogRow, 'volume24hUsd' | 'volumeSource' | 'volumeFetchedAt'> {
  const m = market.get(addrLower)
  if (m?.volume24hUsd == null) return { volume24hUsd: null, volumeSource: null, volumeFetchedAt: null }
  return { volume24hUsd: m.volume24hUsd, volumeSource: m.volumeSource ?? null, volumeFetchedAt: builtAt }
}

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
  const { chainId, qualified, guard, seeds, cores, market, config, categoryFor, logoFor, builtAt } = input
  const rows = new Map<string, CatalogRow>()
  const report: BuildReport = {
    chainId,
    included: 0,
    verified: 0,
    unverifiedSeeds: [],
    rejections: [],
    conflicts: [],
    capped: [],
    retained: [],
    trustLost: [],
    singleSource: emptySingleSourceReport(false),
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
        ...volumeFields(addrLower, market, builtAt),
        ...(c.admission ? { admission: c.admission } : {}),
      })
    } else if (seeds.has(addrLower)) {
      // seed failed the guard — keep it, honest ⚠, loudly flagged
      const seed = seeds.get(addrLower)!
      rows.set(addrLower, seedRow(chainId, seed, c.sources, categoryFor, logoFor, market, builtAt))
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
    // same comparator as the pre-guard prune (compareForCap): two-source tokens first, then
    // single-source admissions by descending 7-day median volume
    const item = (k: string, r: CatalogRow): CapRankItem => ({
      address: r.address,
      symbol: r.symbol,
      volume: market.get(k)?.volume24hUsd ?? 0,
      votes: r.sources.filter((s) => !NON_VOTING.has(s)).length,
      admission: r.admission,
    })
    newRows.sort(([ka, a], [kb, b]) => compareForCap(item(ka, a), item(kb, b)))
    for (const [k, r] of newRows.slice(cap)) {
      rows.delete(k)
      report.capped.push({ address: r.address, symbol: r.symbol })
      if (r.admission) {
        report.singleSource.deferred.push({ address: r.address, symbol: r.symbol, medianUsd: medianOf(r.admission.dailyVolumeUsd) })
      }
    }
  }

  // 3. seeds that never qualified — keep, honest ⚠, flagged
  for (const [addrLower, seed] of seeds) {
    if (rows.has(addrLower)) continue
    rows.set(addrLower, seedRow(chainId, seed, ['curated'], categoryFor, logoFor, market, builtAt))
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
        volume24hUsd: null,
        volumeSource: null,
        volumeFetchedAt: null,
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
        ...volumeFields(addrLower, market, builtAt),
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

export function emptySingleSourceReport(enabled: boolean): SingleSourceReport {
  return { enabled, candidates: 0, prefiltered: 0, evaluated: 0, admitted: 0, belowFloor: 0, fetchFailed: 0, deferred: [], evaluations: [] }
}

function seedRow(
  chainId: number,
  seed: AssembleInput['seeds'] extends Map<string, infer S> ? S : never,
  sources: SourceId[],
  categoryFor: AssembleInput['categoryFor'],
  logoFor: AssembleInput['logoFor'],
  market: Map<string, MarketSignal>,
  builtAt: string,
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
    ...volumeFields(seed.address.toLowerCase(), market, builtAt),
  }
}

