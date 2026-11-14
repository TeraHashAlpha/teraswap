/**
 * [feat/dca-feed-candidates-weekly] PURE core of the weekly candidate list (candidates.ts is the thin I/O shell).
 * No network, no file access, no clock: every input is passed in, so every rule is testable on recorded fixtures.
 *
 * For ONE chain it joins Chainlink's public feed directory to OUR generated token catalog and says, for every
 * "X / USD" feed whose token is in the catalog, whether it is a CANDIDATE for registration or why it is not.
 * The directory carries NO token address (only a symbol in docs.baseAsset), so the join is the one batch.ts uses
 * (owner decision 2026-11-14): the exact symbol, exactly ONE verified EIP-55 catalog token. Anything else is
 * "needs manual match" and is never a candidate. The token address always comes from our catalog.
 *
 * The rules are batch-lib.ts's, reused as they are: plain proxy only (never SVR / secondary), category low or
 * medium, the live checks on two agreeing RPCs, the per-chain maxStaleness rule. A candidate is a LIST ENTRY for
 * the owner to choose from; it enables nothing. Existing config rows are never modified (addCandidates).
 */
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { ALLOWED_CATEGORIES, MAX_STALENESS_RULE, MIN_RPC_READINGS, isChecksummed, isPlainProxy, liveProblems, serializeConfig } from './batch-lib.ts'
import type { Candidate, CatalogToken, DirectoryEntry, LiveReadings, ReadFailure, RegistrationConfig, RegistrationRow } from './batch-lib'

export type { RegistrationConfig, RegistrationRow, DirectoryEntry, CatalogToken, LiveReadings }

/** What ONE RPC answered for tokenUsdFeeds(token) on the executor. */
export interface RegistrationReading { registered: boolean; feed: string }
export interface CandidateLive extends LiveReadings {
  /** Keyed by lowercased token address: one tokenUsdFeeds() reading per RPC, in RPC order. */
  registered: Record<string, Array<RegistrationReading | ReadFailure>>
}
export type CatalogEntry = CatalogToken & { volume24hUsd?: number | null }

export type Status = 'candidate' | 'excluded' | 'needs-manual-match'
export interface CandidateRow {
  symbol: string
  token: string | null
  feed: string | null
  description: string
  category: string | null
  heartbeat: number | null
  decimals: number | null
  tokenDecimals: number | null
  maxStaleness: number | null
  volume24hUsd: number | null
  inConfig: boolean
  /** The config row's `enabled`; null when there is no config row. */
  enabled: boolean | null
  /** tokenUsdFeeds(token).registered as both RPCs agree; null when it was not read (statically excluded) or the RPCs disagree. */
  registered: boolean | null
  status: Status
  /** A candidate that has no config row yet: the only rows addCandidates() writes. */
  addToConfig: boolean
  reasons: string[]
  ageSec: number | null
}
export interface Skipped { noCatalogToken: number; unsafeSymbol: number }

export interface SelectInput {
  config: RegistrationConfig; chainId: number
  directory: readonly DirectoryEntry[]; catalog: readonly CatalogEntry[]
}
/**
 * A row after the static (no chain read) checks. `candidate` is set only when no hard reason stands in the way, so the
 * live checks may run; `soft` reasons (already enabled in the config) are added after the live read, so the row still
 * shows its real on-chain state.
 */
export interface Selected { row: CandidateRow; candidate: Candidate | null; soft: string[] }

const USD_SUFFIX = ' / USD'
/** A symbol that may enter a table, a PR body or a config row: no markup, no mention, no pipe. */
export const SAFE_SYMBOL = /^[A-Za-z0-9.-]{1,20}$/
const lc = (a: string) => a.toLowerCase()
const eqAddr = (a: string, b: string) => lc(a) === lc(b)
const isFailure = (r: unknown): r is ReadFailure => typeof r === 'object' && r !== null && 'error' in r

function emptyRow(symbol: string): CandidateRow {
  return {
    symbol, token: null, feed: null, description: `${symbol}${USD_SUFFIX}`, category: null, heartbeat: null, decimals: null,
    tokenDecimals: null, maxStaleness: null, volume24hUsd: null, inConfig: false, enabled: null, registered: null,
    status: 'excluded', addToConfig: false, reasons: [], ageSec: null,
  }
}

/** Step 1 (no chain reads): every "X / USD" directory feed whose token is in our catalog or config, with the static verdict. */
export function selectCandidates(input: SelectInput): { selected: Selected[]; skipped: Skipped } {
  const { config, chainId, directory, catalog } = input
  const rule = MAX_STALENESS_RULE[chainId] as ((hb: number) => number) | undefined
  const rows: RegistrationRow[] = config.chains[String(chainId)]?.rows ?? []
  const skipped: Skipped = { noCatalogToken: 0, unsafeSymbol: 0 }

  // One group per "X / USD" feed name; an entry with no baseAsset still counts (it can only ever be "needs manual match").
  const groups = new Map<string, DirectoryEntry[]>()
  for (const e of directory) {
    if (typeof e?.name !== 'string' || !e.name.endsWith(USD_SUFFIX) || e.docs?.quoteAsset !== 'USD') continue
    groups.set(e.name, [...(groups.get(e.name) ?? []), e])
  }

  const selected: Selected[] = []
  for (const [name, entries] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const symbol = name.slice(0, -USD_SUFFIX.length)
    if (!SAFE_SYMBOL.test(symbol)) { skipped.unsafeSymbol += 1; continue }

    const exact = catalog.filter(t => t.symbol === symbol)
    const sameCase = exact.length === 0 ? catalog.filter(t => lc(t.symbol) === lc(symbol)) : []
    const byDescription = rows.filter(r => r.description === name)
    if (exact.length === 0 && sameCase.length === 0 && byDescription.length === 0) { skipped.noCatalogToken += 1; continue }

    const row = emptyRow(symbol)
    const out = (status: Status, ...reasons: string[]): Selected => ({ row: { ...row, status, reasons }, candidate: null, soft: [] })

    // ---- the token: from OUR catalog, joined on the exact symbol (or, for a config row, on the row's own token) ----
    let token: CatalogEntry | undefined
    if (byDescription.length > 1) { selected.push(out('excluded', `${byDescription.length} config rows carry the description "${name}"`)); continue }
    const configRow = byDescription[0]
    if (configRow) {
      row.inConfig = true
      row.enabled = configRow.enabled
      const hits = catalog.filter(t => eqAddr(t.address, configRow.token))
      token = hits.length === 1 ? hits[0] : undefined
      if (!token) { selected.push(out('excluded', `${hits.length} catalog tokens match the config row's token (need exactly 1)`)); continue }
    } else if (entries.every(e => typeof e.docs?.baseAsset !== 'string' || e.docs.baseAsset === '')) {
      selected.push(out('needs-manual-match', 'directory entry has no baseAsset: there is no token to match')); continue
    } else if (exact.length !== 1) {
      selected.push(exact.length === 0
        ? out('needs-manual-match', `no catalog token with the exact symbol "${symbol}"; same letters in another case: ${sameCase.map(t => t.symbol).join(', ')}`)
        : out('needs-manual-match', `${exact.length} catalog tokens carry the symbol "${symbol}" (need exactly 1)`))
      continue
    } else {
      token = exact[0]
    }

    row.token = token.address
    row.tokenDecimals = token.decimals
    row.volume24hUsd = typeof token.volume24hUsd === 'number' ? token.volume24hUsd : null
    const reasons: string[] = []
    if (!isChecksummed(token.address)) reasons.push(`catalog address is not EIP-55: ${token.address}`)
    if (token.verified !== true) reasons.push('catalog token is not verified')
    if (token.category === 'Native') reasons.push('catalog entry is the native-asset placeholder, not an ERC-20 token')

    // ---- the config row, matched by description OR by token address; any disagreement is a conflict, never a rewrite ----
    const sameToken = rows.filter(r => eqAddr(r.token, token.address))
    const inConfig = new Set<RegistrationRow>([...byDescription, ...sameToken])
    if (inConfig.size > 1) reasons.push(`${inConfig.size} config rows match this token or description`)
    const cfg = inConfig.size === 1 ? [...inConfig][0] : undefined
    if (cfg) {
      row.inConfig = true
      row.enabled = cfg.enabled
      if (!eqAddr(cfg.token, token.address)) reasons.push(`config row token ${cfg.token} != catalog ${token.address}`)
      if (cfg.description !== name) reasons.push(`config row description "${cfg.description}" != "${name}"`)
    } else if (inConfig.size > 1) { row.inConfig = true }

    // ---- the directory feed: the plain proxy of this exact name ----
    // A created row joins on the exact baseAsset; a config row already joined on its own description (as batch-lib does).
    const named = entries.filter(e => cfg || e.docs?.baseAsset === symbol)
    if (named.length === 0) { selected.push(out('needs-manual-match', `directory entry baseAsset is not "${symbol}": there is no token to match`)); continue }
    const plain = named.filter(isPlainProxy)
    let entry: DirectoryEntry | undefined
    if (plain.length !== 1) {
      const hidden = named.some(e => e.docs?.hidden === true || e.docs?.shutdownDate)
      reasons.push(hidden && plain.length === 0
        ? `"${name}" is hidden or has a shutdown date in the directory`
        : `"${name}": ${plain.length} plain proxies among ${named.length} directory entries (need exactly 1; SVR and secondary proxies never qualify)`)
    } else { entry = plain[0] }

    if (entry) {
      if (!isChecksummed(entry.proxyAddress)) reasons.push(`directory proxy is not EIP-55: ${String(entry.proxyAddress)}`)
      else row.feed = entry.proxyAddress
      const category = entry.feedCategory ?? ''
      row.category = category
      if (!ALLOWED_CATEGORIES.includes(category)) reasons.push(`directory category "${category}" is not low or medium`)
      const hb = entry.heartbeat
      if (typeof hb !== 'number' || !Number.isInteger(hb) || hb <= 0) reasons.push(`directory heartbeat ${String(hb)} is not a positive integer`)
      else { row.heartbeat = hb; row.maxStaleness = rule ? rule(hb) : null }
      if (typeof entry.decimals !== 'number') reasons.push('directory entry has no decimals')
      else row.decimals = entry.decimals
      if (!rule) reasons.push(`no maxStaleness rule for chain ${chainId}`)
      if (cfg && row.feed && cfg.feed !== row.feed) reasons.push(`config row feed ${cfg.feed} is not the directory's plain proxy ${row.feed}`)
      if (cfg && row.heartbeat !== null && cfg.heartbeat !== row.heartbeat) reasons.push(`config row heartbeat ${cfg.heartbeat} != directory ${row.heartbeat}`)
      if (cfg && row.decimals !== null && cfg.decimals !== row.decimals) reasons.push(`config row feed decimals ${cfg.decimals} != directory ${row.decimals}`)
      if (cfg && cfg.tokenDecimals !== token.decimals) reasons.push(`config row tokenDecimals ${cfg.tokenDecimals} != catalog ${token.decimals}`)
    }
    if (reasons.length) { selected.push(out('excluded', ...reasons)); continue }
    const soft = cfg?.enabled ? ['already enabled in the config (registered, or waiting in a monthly batch)'] : []

    const e = entry as DirectoryEntry
    selected.push({
      row, soft,
      candidate: {
        symbol, token: token.address, feed: e.proxyAddress as string, description: name, decimals: e.decimals as number,
        tokenDecimals: token.decimals, heartbeat: e.heartbeat as number, maxStaleness: (rule as (hb: number) => number)(e.heartbeat as number),
        tier: e.feedCategory as string, stable: token.category === 'Stablecoin', existing: !!cfg,
      },
    })
  }
  return { selected, skipped }
}

/** The registration verdict from the per-RPC readings: both must answer and agree. */
export function registrationOf(readings: ReadonlyArray<RegistrationReading | ReadFailure> | undefined): { registered: boolean | null; reasons: string[] } {
  const reasons: string[] = []
  const list = readings ?? []
  if (list.length < MIN_RPC_READINGS) reasons.push(`${list.length} RPC reading(s) of tokenUsdFeeds (need ${MIN_RPC_READINGS})`)
  const good: RegistrationReading[] = []
  list.forEach((r, i) => { if (isFailure(r)) reasons.push(`RPC ${i + 1} tokenUsdFeeds read failed: ${r.error}`); else good.push(r) })
  if (good.length === 0) return { registered: null, reasons }
  if (good.some(r => r.registered !== good[0].registered || lc(r.feed) !== lc(good[0].feed))) {
    reasons.push('RPCs disagree on tokenUsdFeeds (registered or feed)')
    return { registered: null, reasons }
  }
  if (reasons.length) return { registered: null, reasons }
  return { registered: good[0].registered, reasons }
}

/** Step 2: the live checks batch.ts / plan.ts apply on two agreeing RPCs, plus "not yet registered on-chain". */
export function classify(selected: readonly Selected[], live: CandidateLive): CandidateRow[] {
  return selected.map(({ row, candidate, soft }): CandidateRow => {
    if (!candidate) return row
    const reasons = [...liveProblems(candidate, live), ...soft]
    const reading = (live.feeds[lc(candidate.feed)] ?? []).find((r): r is { description: string; decimals: number; answer: string; updatedAt: number } => !isFailure(r))
    const reg = registrationOf(live.registered[lc(candidate.token)])
    reasons.push(...reg.reasons)
    if (reg.registered === true) reasons.push('already registered on-chain')
    const done: CandidateRow = {
      ...row, registered: reg.registered, reasons, ageSec: reading ? live.now - reading.updatedAt : null,
      status: reasons.length ? 'excluded' : 'candidate',
    }
    done.addToConfig = done.status === 'candidate' && !done.inConfig
    return done
  })
}

const ORDER: Record<Status, number> = { candidate: 0, excluded: 1, 'needs-manual-match': 2 }
/** Candidates first, then by catalog 24 h volume (largest first), then by symbol: the same input always prints the same table. */
export function sortRows(rows: readonly CandidateRow[]): CandidateRow[] {
  return [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) || (a.symbol < b.symbol ? -1 : 1))
}

export interface Summary { candidates: number; newConfigRows: number; excluded: number; needsManualMatch: number }
export const summarize = (rows: readonly CandidateRow[]): Summary => ({
  candidates: rows.filter(r => r.status === 'candidate').length,
  newConfigRows: rows.filter(r => r.addToConfig).length,
  excluded: rows.filter(r => r.status === 'excluded').length,
  needsManualMatch: rows.filter(r => r.status === 'needs-manual-match').length,
})

/** Row key order of a created row: the order build-config.mjs and batch-lib.ts write; no `batch` key (it is not in a batch). */
const NEW_ROW_KEYS = ['symbol', 'token', 'feed', 'description', 'decimals', 'tokenDecimals', 'heartbeat', 'maxStaleness',
  'tier', 'phase', 'enabled', 'action', 'source'] as const

export interface AddResult { next: RegistrationConfig; added: string[] }
/**
 * Append the new candidates to the chain's rows as phase 2, enabled:false, action:"none". PURE; the config in is not mutated.
 * An existing row is never touched: the function proves it (every earlier row must still be deep-equal) and throws otherwise.
 */
export function addCandidates(config: RegistrationConfig, chainId: number, rows: readonly CandidateRow[], date: string): AddResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date "${date}" is not YYYY-MM-DD`)
  const next = structuredClone(config)
  const target = next.chains[String(chainId)]
  if (!target) throw new Error(`chain ${chainId} has no rows in the config`)
  const before = JSON.stringify(config.chains[String(chainId)].rows)
  const added: string[] = []
  for (const r of rows.filter(x => x.addToConfig)) {
    const dup = target.rows.some(x => x.symbol === r.symbol || eqAddr(x.token, r.token as string) || eqAddr(x.feed, r.feed as string))
    if (dup) throw new Error(`refusing to add ${r.symbol}: a config row already carries its symbol, token or feed`)
    if (r.status !== 'candidate' || r.token === null || r.feed === null || r.decimals === null || r.tokenDecimals === null || r.heartbeat === null || r.maxStaleness === null || r.category === null) {
      throw new Error(`refusing to add ${r.symbol}: not a complete candidate`)
    }
    const created: RegistrationRow = {
      symbol: r.symbol, token: r.token, feed: r.feed, description: r.description, decimals: r.decimals, tokenDecimals: r.tokenDecimals,
      heartbeat: r.heartbeat, maxStaleness: r.maxStaleness, tier: r.category, phase: 2, enabled: false, action: 'none', source: `chainlink-directory ${date}`,
    }
    target.rows.push(Object.fromEntries(NEW_ROW_KEYS.map(k => [k, created[k]])) as unknown as RegistrationRow)
    added.push(r.symbol)
  }
  if (JSON.stringify(target.rows.slice(0, JSON.parse(before).length)) !== before) throw new Error('an existing config row changed: refusing')
  return { next, added }
}

export { serializeConfig }

// ---------------------------------------------------------------- output ----

const shortAddr = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '-')
/** One table cell: external strings (RPC errors, directory fields) never carry markup, a mention, a pipe or a newline into a PR body. */
export function cell(value: unknown, max = 160): string {
  const s = String(value ?? '-').replace(/[\r\n\t]+/g, ' ').replace(/[|`<>@\\[\]*_~#!]/g, '').trim()
  return (s.length > max ? `${s.slice(0, max - 1)}…` : s) || '-'
}
const yn = (v: boolean | null) => (v === null ? '-' : v ? 'yes' : 'no')
const vol = (v: number | null) => (v === null ? '-' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(Math.round(v)))
const verdict = (r: CandidateRow) => (r.status === 'candidate' ? (r.addToConfig ? 'CANDIDATE (new row)' : 'CANDIDATE (row exists)') : r.status === 'needs-manual-match' ? 'needs manual match' : 'excluded')

export interface Report {
  chain: string; chainId: number; directoryUrl: string; directoryEntries: number; rpcs: number; date: string
  summary: Summary; skipped: Skipped; rows: CandidateRow[]
}

/** Aligned text table for the terminal. */
export function textTable(report: Report): string {
  const head = ['symbol', 'token', 'feed', 'category', 'hb(s)', '24h vol', 'in cfg', 'enabled', 'on-chain', 'verdict']
  const body = report.rows.map(r => [r.symbol, shortAddr(r.token), shortAddr(r.feed), r.category ?? '-', r.heartbeat ?? '-', vol(r.volume24hUsd),
    yn(r.inConfig), yn(r.enabled), yn(r.registered), verdict(r)].map(String))
  const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)))
  const line = (c: string[]) => c.map((x, i) => x.padEnd(w[i])).join('  ').trimEnd()
  const reasons = report.rows.filter(r => r.reasons.length).map(r => `  ${r.symbol}: ${r.reasons.join('; ')}`)
  return [line(head), ...body.map(line), '', ...(reasons.length ? ['why not:', ...reasons] : [])].join('\n')
}

/** The PR body: GitHub-flavoured markdown, every external string through cell(). Bounded so GitHub never rejects it. */
export function markdownTable(report: Report, maxChars = 60_000): string {
  const s = report.summary
  const head = [
    `Weekly DCA feed candidates for **${cell(report.chain)}** (${report.chainId}), ${cell(report.date)}. Read-only: Chainlink's public feed directory joined to our token catalog, live checks on ${report.rpcs} RPCs.`,
    '',
    `**${s.candidates} candidate(s)** (${s.newConfigRows} new config row(s), added as \`enabled: false\`, \`action: "none"\`, \`phase: 2\`), ${s.excluded} excluded, ${s.needsManualMatch} need a manual match; ${report.skipped.noCatalogToken} directory USD feed(s) have no token in our catalog.`,
    'Nothing here enables a row, registers a feed or sends a transaction. Choosing and enabling is the monthly batch (runbook section 9).',
    '',
    '| Symbol | Token | Feed | Category | Heartbeat | 24h volume | In config | Enabled | On-chain | Verdict |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]
  const rows = report.rows.map(r => `| ${cell(r.symbol)} | ${cell(r.token)} | ${cell(r.feed)} | ${cell(r.category)} | ${cell(r.heartbeat)} | ${vol(r.volume24hUsd)} | ${yn(r.inConfig)} | ${yn(r.enabled)} | ${yn(r.registered)} | ${verdict(r)}${r.reasons.length ? `: ${cell(r.reasons.join('; '), 200)}` : ''} |`)
  const out: string[] = [...head]
  let size = out.join('\n').length
  let cut = 0
  for (const r of rows) { if (size + r.length + 1 > maxChars) { cut += 1; continue } out.push(r); size += r.length + 1 }
  if (cut) out.push('', `${cut} further row(s) are in the machine-readable report of the run (table cut to fit the PR body).`)
  return `${out.join('\n')}\n`
}
