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
 * "Blocked" always means: catalog = the previous catalog, removed = [], leftOut = []; the lists the
 * decision WOULD have produced are kept in `attempted` so the failure issue can show them.
 */
import type { CatalogRow, GuardOutcome } from './types'

/** More than this many removals in one chain-refresh ⇒ blocked. */
export const MAX_REMOVED_ABS = 20
/** More than this percentage of the previous catalog removed ⇒ blocked. */
export const MAX_REMOVED_PERCENT = 5
/** The fresh trusted list must be STRICTLY larger than this percentage of its previous size. */
export const TRUSTED_LIST_MIN_PERCENT = 70

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
  return outcome?.detail ? `guard: ${outcome.detail}` : 'guard: fatal'
}

export function decideRefresh(input: RefreshDecisionInput): RefreshDecision {
  const { chainId, previous, candidate, audit, protectedAddresses, trustedList } = input
  const previousByAddr = new Map(previous.map((r) => [lc(r.address), r]))

  const line = (r: Pick<CatalogRow, 'symbol' | 'address'>, why: string): DecisionLine => ({ chainId, symbol: r.symbol, address: r.address, why })
  const blockedResult = (blocked: BlockedInfo, attempted: RefreshDecision['attempted']): RefreshDecision => ({
    chainId, catalog: [...previous], removed: [], leftOut: [], blocked, attempted,
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

  return { chainId, catalog, removed, leftOut, blocked: null, attempted }
}

// ─── rendering ────────────────────────────────────────────────────────────────────────────

/** Symbols and guard text come from external token lists (attacker-choosable): printable, no markup. */
export function sanitizeInline(s: string, max = 160): string {
  const cleaned = s.replace(/[^\x20-\x7e]/g, '?').replace(/[`|<>[\]()*_~\\]/g, "'").replace(/\s+/g, ' ').trim()
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
