/**
 * [fix/catalog-refresh-drops-untrusted] refresh-decision — what a catalog refresh may ship for ONE
 * chain, as a pure function (no network, no fs, no clock).
 *
 * Why this exists: the weekly refresh used to hand the guard whatever the pipeline built. One
 * token the guard calls fatal (`trusted-list`: the fresh CoinGecko per-chain list no longer holds
 * it) reddened the gate and blocked the WHOLE chain (issues #700, #703, #706: 18 tokens, 3 chains).
 * The guard is right to call those tokens untrusted; the refresh was wrong to ship them. So the
 * decision lives here, in the refresh, and the guard is untouched (catalog-address-guard.test.ts,
 * catalog-guard.ts, the allowlist: not edited, no exemption added).
 *
 * Rules (owner, 2026-11-18):
 *  1. a NEW candidate the guard calls fatal is LEFT OUT — it never blocks the chain;
 *  2. a token ALREADY in the catalog that the guard now calls fatal is REMOVED — merging the
 *     refresh PR is the owner's decision, so every removal is listed (PR body, first section);
 *  3. a cap: more than MAX_REMOVED_ABS removals, or more than MAX_REMOVED_PERCENT of the chain's
 *     catalog, changes NOTHING for the chain — the failure issue opens instead;
 *  4. a dead upstream trusted list (empty / unreachable / <= TRUSTED_LIST_MIN_PERCENT of its previous
 *     size) changes NOTHING — "untrusted" would then mean "the list is down", not "token is bad";
 *  5. a PROTECTED token (core, or hand-pinned in this repo) the guard calls fatal is never removed
 *     silently: the chain is blocked and a human decides (build-chain.ts already throws for cores).
 *
 *  6. [owner 2026-11-18, rule B] at most MAX_ADDITIONS_PER_CHAIN (25) NEW tokens per chain, the highest 7-day volume
 *     first, and never past the chain's size bound: `applyAdditionsCap` (below). The rest are listed in the PR body and are
 *     candidates again next week. Rule A (growth breaker, source-growth.ts) and rule D (auto-merge, C10) feed the same report.
 *
 * "Blocked" always means: catalog = the previous catalog, removed = [], leftOut = []; the lists the
 * decision WOULD have produced are kept in `attempted` so the failure issue can show them.
 */
import type { CatalogRow, GuardOutcome } from './types'
import type { HeldBackSource } from './source-growth'

/** More than this many removals in one chain-refresh ⇒ blocked. */
export const MAX_REMOVED_ABS = 20
/** More than this percentage of the previous catalog removed ⇒ blocked. */
export const MAX_REMOVED_PERCENT = 5
/** The fresh trusted list must be STRICTLY larger than this percentage of its previous size. */
export const TRUSTED_LIST_MIN_PERCENT = 70
/** [rule B, owner 2026-11-18] A refresh adds at most this many new tokens per chain; the highest 7-day volume first. */
export const MAX_ADDITIONS_PER_CHAIN = 25

export type BlockReason = 'trusted-list-dead' | 'removal-cap' | 'protected-token-fatal' | 'residual-fatal'

export interface DecisionLine {
  chainId: number
  symbol: string
  address: string
  /** Why it is not on the site after this refresh (guard detail, or the pipeline's own drop reason). */
  why: string
}

export interface RefreshDecisionInput {
  chainId: number
  /** The chain's committed catalog (what is on the site today). */
  previous: readonly CatalogRow[]
  /** What the pipeline built this run, before the decision. */
  candidate: readonly CatalogRow[]
  /**
   * The catalog guard over a row set — in production `deriveGuardOutcomes` (the SAME auditChain
   * the CI gate runs), keyed by lowercase address. Called on `candidate`, then again on the result.
   */
  audit: (rows: readonly CatalogRow[]) => ReadonlyMap<string, GuardOutcome>
  /** Lowercase addresses a human pinned or the fee path needs: cores + hand-curated seeds. */
  protectedAddresses: ReadonlySet<string>
  /** Size of the chain's CoinGecko list: the previous committed run vs this run. null = unknown / unreachable. */
  trustedList: { previous: number | null; current: number | null }
  /** Why the pipeline itself dropped a previous row it did not carry into `candidate` (lowercase address → reason). */
  pipelineDropReasons?: ReadonlyMap<string, string>
  /** [rule A] Sources the growth breaker held back this run (reported, carried through to the PR body / issue / auto-merge). */
  heldBackSources?: readonly HeldBackSource[]
}

export interface BlockedInfo {
  reason: BlockReason
  detail: string
}

export interface RefreshDecision {
  chainId: number
  /** The rows to write. Equals `previous` when blocked. */
  catalog: CatalogRow[]
  /** Previous rows that are not in `catalog`. Empty when blocked. */
  removed: DecisionLine[]
  /** Candidate rows the guard calls fatal that were never in `previous`. Empty when blocked. */
  leftOut: DecisionLine[]
  blocked: BlockedInfo | null
  /** What `removed` / `leftOut` would have been — populated when blocked, equal to them otherwise. */
  attempted: { removed: DecisionLine[]; leftOut: DecisionLine[] }
  /** [rule B] New tokens the weekly cap (or the size bound) kept off the site this run; candidates again next week. */
  heldBack: DecisionLine[]
  /** [rule A] Sources whose growth was held back; reported even when the chain is blocked. */
  heldBackSources: HeldBackSource[]
}

const lc = (s: string): string => s.toLowerCase()

/** Max removals allowed for a chain whose previous catalog has `previousSize` rows. */
export function removalLimit(previousSize: number): number {
  // integer math only (no float edge): removed > 5% of previous  <=>  removed > floor(previous * 5 / 100)
  return Math.min(MAX_REMOVED_ABS, Math.floor((previousSize * MAX_REMOVED_PERCENT) / 100))
}

export function trustedListVerdict(previous: number | null, current: number | null): BlockedInfo | null {
  if (current == null || current <= 0) {
    return { reason: 'trusted-list-dead', detail: `the CoinGecko list for this chain is ${current == null ? 'unreachable' : 'empty'} (previous run: ${previous ?? 'unknown'})` }
  }
  if (previous != null && previous > 0 && current * 100 <= previous * TRUSTED_LIST_MIN_PERCENT) {
    return { reason: 'trusted-list-dead', detail: `the CoinGecko list shrank ${previous} → ${current} (<= ${TRUSTED_LIST_MIN_PERCENT}% of the previous run) — an upstream outage, not ${previous - current} delistings` }
  }
  return null
}

function fatalDetail(outcome: GuardOutcome | undefined): string {
  // the guard's detail ends with remediation advice for a human editing the allowlist ("— add to the
  // allowlist ... or correct the address"); the PR line only needs what the guard found.
  const finding = outcome?.detail?.split(' — ')[0]
  return finding ? `guard: ${finding}` : 'guard: fatal'
}

export function decideRefresh(input: RefreshDecisionInput): RefreshDecision {
  const { chainId, previous, candidate, audit, protectedAddresses, trustedList } = input
  const previousByAddr = new Map(previous.map((r) => [lc(r.address), r]))

  const line = (r: Pick<CatalogRow, 'symbol' | 'address'>, why: string): DecisionLine => ({ chainId, symbol: r.symbol, address: r.address, why })
  const blockedResult = (blocked: BlockedInfo, attempted: RefreshDecision['attempted']): RefreshDecision => ({
    chainId, catalog: [...previous], removed: [], leftOut: [], blocked, attempted, heldBack: [], heldBackSources: [...(input.heldBackSources ?? [])],
  })
  const noAttempt = { removed: [], leftOut: [] }

  // (4) a dead upstream list is checked BEFORE anything is judged "untrusted"
  const dead = trustedListVerdict(trustedList.previous, trustedList.current)
  if (dead) return blockedResult(dead, noAttempt)

  // (1)/(2) which candidate rows does the guard call fatal?
  const outcomes = audit(candidate)
  const fatalRows = candidate.filter((r) => outcomes.get(lc(r.address))?.status === 'fatal')
  const fatalAddrs = new Set(fatalRows.map((r) => lc(r.address)))

  // (5) protected tokens are never dropped by this module
  const protectedFatal = fatalRows.filter((r) => protectedAddresses.has(lc(r.address)))
  if (protectedFatal.length > 0) {
    return blockedResult(
      { reason: 'protected-token-fatal', detail: `${protectedFatal.map((r) => `${r.symbol} ${r.address}`).join(', ')} — core or hand-pinned, a human must decide` },
      noAttempt,
    )
  }

  const catalog = candidate.filter((r) => !fatalAddrs.has(lc(r.address)))

  // the result must itself be guard-clean (e.g. a duplicate-symbol partner must not be left red)
  const after = audit(catalog)
  const residual = catalog.filter((r) => after.get(lc(r.address))?.status === 'fatal')
  if (residual.length > 0) {
    return blockedResult({ reason: 'residual-fatal', detail: `after dropping the fatal rows the guard still calls fatal: ${residual.map((r) => `${r.symbol} ${r.address}`).join(', ')}` }, noAttempt)
  }

  const keptAddrs = new Set(catalog.map((r) => lc(r.address)))
  const removed: DecisionLine[] = []
  for (const row of previous) {
    const a = lc(row.address)
    if (keptAddrs.has(a)) continue
    const why = fatalAddrs.has(a)
      ? fatalDetail(outcomes.get(a))
      : `dropped by the pipeline: ${input.pipelineDropReasons?.get(a) ?? 'not in this run\'s candidate catalog'}`
    removed[removed.length] = line(row, why)
  }
  const leftOut: DecisionLine[] = []
  for (const row of fatalRows) {
    if (previousByAddr.has(lc(row.address))) continue
    leftOut[leftOut.length] = line(row, fatalDetail(outcomes.get(lc(row.address))))
  }
  const attempted = { removed, leftOut }

  // (3) the cap
  if (removed.length > removalLimit(previous.length)) {
    return blockedResult(
      {
        reason: 'removal-cap',
        detail: `${removed.length} removal(s) from a ${previous.length}-row catalog exceeds the cap (max ${MAX_REMOVED_ABS} and ${MAX_REMOVED_PERCENT}% = ${removalLimit(previous.length)})`,
      },
      attempted,
    )
  }

  return { chainId, catalog, removed, leftOut, blocked: null, attempted, heldBack: [], heldBackSources: [...(input.heldBackSources ?? [])] }
}

// ─── rule B: the additions cap ────────────────────────────────────────────────────────────

export interface AdditionsCapInput {
  /** The chain's committed catalog. A row of `decision.catalog` that is not in here is an ADDITION. */
  previous: readonly CatalogRow[]
  /** Cores + hand-pinned seeds: a human chose them, they are never held back by the cap (they still use size room). */
  protectedAddresses: ReadonlySet<string>
  /** 7-day volume per lowercase address (CoinGecko history). Missing / null = unknown: ranks after every known value. */
  volume7d: ReadonlyMap<string, number | null>
  /** Exclusive size bound for the chain (CATALOG_SIZE_BOUND): the result must stay under it. undefined = none. */
  sizeBound?: number
  /** Defaults to MAX_ADDITIONS_PER_CHAIN. */
  maxAdditions?: number
  /** The same guard as decideRefresh: the capped catalog is audited once more. */
  audit: (rows: readonly CatalogRow[]) => ReadonlyMap<string, GuardOutcome>
}

/** The additions the cap may hold back (new rows that are not protected). */
export function cappableAdditions(decision: Pick<RefreshDecision, 'catalog'>, previous: readonly CatalogRow[], protectedAddresses: ReadonlySet<string>): CatalogRow[] {
  const prev = new Set(previous.map((r) => lc(r.address)))
  return decision.catalog.filter((r) => !prev.has(lc(r.address)) && !protectedAddresses.has(lc(r.address)))
}

/** How many additions this chain may take: min(cap, room under the size bound). Never negative. */
export function additionsAllowed(decision: Pick<RefreshDecision, 'catalog'>, input: Pick<AdditionsCapInput, 'previous' | 'protectedAddresses' | 'sizeBound' | 'maxAdditions'>): { allowed: number; limitedBy: 'weekly-cap' | 'size-bound' } {
  const cap = input.maxAdditions ?? MAX_ADDITIONS_PER_CHAIN
  const prev = new Set(input.previous.map((r) => lc(r.address)))
  const newRows = decision.catalog.filter((r) => !prev.has(lc(r.address)))
  const protectedNew = newRows.filter((r) => input.protectedAddresses.has(lc(r.address))).length
  const base = decision.catalog.length - newRows.length
  if (input.sizeBound === undefined) return { allowed: cap, limitedBy: 'weekly-cap' }
  const room = Math.max(0, input.sizeBound - 1 - base - protectedNew) // result.length < sizeBound
  return room < cap ? { allowed: room, limitedBy: 'size-bound' } : { allowed: cap, limitedBy: 'weekly-cap' }
}

/** Highest 7-day volume first; unknown last; then 24h volume, symbol, address — a total order, so the result is deterministic. */
export function compareCandidates(a: CatalogRow, b: CatalogRow, volume7d: ReadonlyMap<string, number | null>): number {
  const nz = (v: number | null | undefined): number => (v == null || !Number.isFinite(v) ? Number.NEGATIVE_INFINITY : v)
  const d7 = nz(volume7d.get(lc(b.address))) - nz(volume7d.get(lc(a.address)))
  if (d7 !== 0 && !Number.isNaN(d7)) return d7
  const d24 = nz(b.volume24hUsd) - nz(a.volume24hUsd)
  if (d24 !== 0 && !Number.isNaN(d24)) return d24
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1
  return lc(a.address) < lc(b.address) ? -1 : lc(a.address) > lc(b.address) ? 1 : 0
}

/**
 * Rule B: at most MAX_ADDITIONS_PER_CHAIN new tokens per chain, the highest 7-day volume first; the
 * rest are held back (listed in the PR body) and are candidates again next week. The cap is also
 * clamped to the room under the chain's size bound (owner answer 2026-11-18), so a refresh never
 * builds a catalog the size assertion rejects. A blocked decision changes nothing.
 */
export function applyAdditionsCap(decision: RefreshDecision, input: AdditionsCapInput): RefreshDecision {
  if (decision.blocked) return decision
  const cappable = cappableAdditions(decision, input.previous, input.protectedAddresses)
  const { allowed, limitedBy } = additionsAllowed(decision, input)
  if (cappable.length <= allowed) return decision

  const ranked = [...cappable].sort((a, b) => compareCandidates(a, b, input.volume7d))
  const dropped = new Set(ranked.slice(allowed).map((r) => lc(r.address)))
  const why = limitedBy === 'size-bound'
    ? `size bound: the catalog must stay under ${input.sizeBound} rows (room for ${allowed} addition(s) this week)`
    : `weekly cap: at most ${input.maxAdditions ?? MAX_ADDITIONS_PER_CHAIN} additions per chain`
  const catalog = decision.catalog.filter((r) => !dropped.has(lc(r.address)))
  const heldBack = ranked.slice(allowed).map((r) => ({ chainId: decision.chainId, symbol: r.symbol, address: r.address, why }))

  // fewer rows can only remove findings, but the result is the thing that ships: audit it once more
  const after = input.audit(catalog)
  const residual = catalog.filter((r) => after.get(lc(r.address))?.status === 'fatal')
  if (residual.length > 0) {
    return {
      ...decision, catalog: [...input.previous], removed: [], leftOut: [], heldBack: [],
      blocked: { reason: 'residual-fatal', detail: `after the additions cap the guard still calls fatal: ${residual.map((r) => `${r.symbol} ${r.address}`).join(', ')}` },
    }
  }
  return { ...decision, catalog, heldBack }
}

// ─── rendering ────────────────────────────────────────────────────────────────────────────

/** Symbols and guard text come from external token lists (attacker-choosable): printable, no markup. */
export function sanitizeInline(s: string, max = 160): string {
  // HTML-significant characters become entities (GitHub shows the character, a tag can never form);
  // markdown structure characters that could open a link, code span, table cell or emphasis become '.
  const cleaned = s
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[`|[\]*_~\\]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function renderLine(l: DecisionLine, volume7d: ReadonlyMap<string, number | null>): string {
  const v = volume7d.get(lc(l.address))
  return `- chain ${l.chainId} · \`${sanitizeInline(l.symbol, 24)}\` · \`${l.address}\` · ${sanitizeInline(l.why)} · 7-day volume ${formatUsd(v)}`
}

export const REMOVED_HEADING = 'Tokens removed from the site by this refresh'
export const LEFT_OUT_HEADING = 'Candidates left out'
export const HELD_SOURCES_HEADING = 'Sources held back by the growth breaker'
export const HELD_CANDIDATES_HEADING = 'Candidates held back by the weekly cap'

export function renderHeldBackSource(h: HeldBackSource): string {
  const growth = h.previous > 0 ? Math.round(((h.current - h.previous) * 100) / h.previous) : 0
  return `- chain ${h.chainId} · \`${sanitizeInline(h.source, 24)}\` · previous ${h.previous} → now ${h.current} entries (+${growth}%)${h.baseline !== h.previous ? ` · compared with the accepted size ${h.baseline}` : ''}`
}

/** The accept instruction, one line per held source — the exact line the owner commits. */
export function acceptanceLine(h: HeldBackSource): string {
  return `"${h.chainId}:${h.source}": ${h.current}`
}

/**
 * The two PR-body sections, REMOVED FIRST (the body opens with it). Always both headings, "None."
 * when empty, so a reviewer never has to wonder whether a section was forgotten.
 */
export function renderPrBodySections(decision: RefreshDecision, volume7d: ReadonlyMap<string, number | null> = new Map()): string {
  const out: string[] = []
  out[out.length] = `## ${REMOVED_HEADING}`
  out[out.length] = ''
  if (decision.removed.length === 0) {
    out[out.length] = 'None.'
  } else {
    out[out.length] = `${decision.removed.length} token(s) leave the site when this PR is merged — merging is the decision.`
    out[out.length] = ''
    for (const l of decision.removed) out[out.length] = renderLine(l, volume7d)
  }
  out[out.length] = ''
  out[out.length] = `## ${LEFT_OUT_HEADING}`
  out[out.length] = ''
  if (decision.leftOut.length === 0) {
    out[out.length] = 'None.'
  } else {
    out[out.length] = `${decision.leftOut.length} candidate(s) the guard calls untrusted were not added (they were never on the site).`
    out[out.length] = ''
    for (const l of decision.leftOut) out[out.length] = renderLine(l, volume7d)
  }
  out[out.length] = ''
  out[out.length] = `## ${HELD_SOURCES_HEADING}`
  out[out.length] = ''
  if (decision.heldBackSources.length === 0) {
    out[out.length] = 'None.'
  } else {
    out[out.length] = `${decision.heldBackSources.length} source list(s) grew by more than 50% since the previous run and were NOT used: the previous snapshot of each stood in. They stay held back until you accept the new size — add the line below to \`scripts/token-catalog/accepted-source-sizes.json\` in a reviewed commit.`
    out[out.length] = ''
    for (const h of decision.heldBackSources) out[out.length] = `${renderHeldBackSource(h)} · accept with \`${acceptanceLine(h)}\``
  }
  out[out.length] = ''
  out[out.length] = `## ${HELD_CANDIDATES_HEADING}`
  out[out.length] = ''
  if (decision.heldBack.length === 0) {
    out[out.length] = 'None.'
  } else {
    out[out.length] = `${decision.heldBack.length} new token(s) were kept off the site this week (highest 7-day volume first; they are candidates again next week).`
    out[out.length] = ''
    for (const l of decision.heldBack) out[out.length] = renderLine(l, volume7d)
  }
  return `${out.join('\n')}\n`
}

/** Body of the (one per chain) issue that tells the owner a source is held back. Empty when none is. */
export function renderHeldBackIssueBody(chainId: number, held: readonly HeldBackSource[], runUrl: string): string {
  if (held.length === 0) return ''
  const out = [
    `The token-catalog refresh for **chain ${chainId}** did not use ${held.length} source list(s) that grew by more than 50% since the previous run. The previous snapshot of each was used; the refresh went on with the other sources.`,
    '',
    ...held.map(renderHeldBackSource),
    '',
    'To accept a new size, add the line(s) below to `scripts/token-catalog/accepted-source-sizes.json` in a reviewed commit (one line per source and chain):',
    '',
    '```',
    ...held.map(acceptanceLine),
    '```',
    '',
    `Run: ${sanitizeInline(runUrl, 300)}`,
  ]
  return `${out.join('\n')}\n`
}

/** Text for the failure issue when a chain is blocked (no catalog written, nothing changed). */
export function renderBlockedSummary(decision: RefreshDecision, volume7d: ReadonlyMap<string, number | null> = new Map()): string {
  if (!decision.blocked) return ''
  const out = [`refresh BLOCKED for chain ${decision.chainId} (${decision.blocked.reason}): ${sanitizeInline(decision.blocked.detail, 600)}`, 'Nothing was changed for this chain.']
  if (decision.attempted.removed.length > 0) {
    out[out.length] = ''
    out[out.length] = `Removals the refresh would have made (${decision.attempted.removed.length}):`
    for (const l of decision.attempted.removed) out[out.length] = renderLine(l, volume7d)
  }
  if (decision.attempted.leftOut.length > 0) {
    out[out.length] = ''
    out[out.length] = `Candidates it would have left out (${decision.attempted.leftOut.length}):`
    for (const l of decision.attempted.leftOut) out[out.length] = renderLine(l, volume7d)
  }
  return `${out.join('\n')}\n`
}
