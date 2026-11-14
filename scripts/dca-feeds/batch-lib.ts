/**
 * [feat/dca-feed-batch] PURE core of the monthly feed batch (scripts/dca-feeds/batch.ts is the thin I/O shell).
 * No network, no file access, no clock: every input is passed in, so the rules are testable on recorded fixtures.
 *
 * For a named list of symbols on ONE chain it turns rows of src/config/dca-feed-registrations.json into
 * `enabled: true, action: "register", batch: "<YYYY-MM>"` rows, creating a row that does not exist yet from
 * Chainlink's public feed directory joined to OUR token catalog. No address is typed: the token comes from the
 * catalog, the feed from the directory, and both must already be in EIP-55 form.
 *
 * ALL OR NOTHING: one refused symbol means no config is produced. Every other row is left byte-identical.
 */
import { getAddress } from 'viem'

export interface RegistrationRow {
  symbol: string; token: string; feed: string; description: string; decimals: number; tokenDecimals: number
  heartbeat: number; maxStaleness: number | null; tier: string; phase: number; enabled: boolean; action: string
  source: string; batch?: string
}
export interface RegistrationConfig {
  schema: number; source: string
  chains: Record<string, { name: string; rows: RegistrationRow[] }>
}
/** One entry of Chainlink's reference-data directory (only the fields the batch reads). */
export interface DirectoryEntry {
  name?: string; path?: string; ens?: string | null
  proxyAddress?: string | null; secondaryProxyAddress?: string | null
  heartbeat?: number; decimals?: number; feedCategory?: string
  docs?: { baseAsset?: string; quoteAsset?: string; hidden?: boolean; shutdownDate?: string }
}
/** One token of src/config/generated/token-catalog.<chainId>.json (only the fields the batch reads). */
export interface CatalogToken { address: string; symbol: string; decimals: number; category?: string; verified?: boolean }

/** What ONE RPC answered for a feed: description(), decimals(), latestRoundData(). */
export interface FeedReading { description: string; decimals: number; answer: string; updatedAt: number }
export interface ReadFailure { error: string }
export interface LiveReadings {
  /** Unix seconds the readings were taken at. */
  now: number
  /** Keyed by lowercased feed address: one reading per RPC, in RPC order. */
  feeds: Record<string, Array<FeedReading | ReadFailure>>
  /** Keyed by lowercased token address: the token's own decimals(). */
  tokenDecimals: Record<string, number | ReadFailure>
}

/** `maxStaleness` per chain, as already registered on-chain (runbook section 0). */
export const MAX_STALENESS_RULE: Record<number, (heartbeat: number) => number> = {
  8453: hb => hb + 3600,
  42161: hb => 2 * (hb + 13) + 60,
}
export const ALLOWED_CATEGORIES: readonly string[] = ['low', 'medium']
export const BATCH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const MIN_RPC_READINGS = 2
/** A stablecoin's feed must answer inside this band (hundredths of a dollar, inclusive). */
export const STABLE_BAND_CENTS = { min: 98, max: 102 } as const
const STABLE_CATEGORY = 'Stablecoin'
const DAY_SEC = 86400
/** Row key order of a created row: the order build-config.mjs writes, then `batch`. */
const ROW_KEYS = ['symbol', 'token', 'feed', 'description', 'decimals', 'tokenDecimals', 'heartbeat', 'maxStaleness',
  'tier', 'phase', 'enabled', 'action', 'source', 'batch'] as const

export const serializeConfig = (config: RegistrationConfig): string => `${JSON.stringify(config, null, 2)}\n`

const lc = (a: string) => a.toLowerCase()
function isChecksummed(a: unknown): a is string {
  if (typeof a !== 'string' || a.length !== 42) return false
  try { return getAddress(a) === a } catch { return false }
}
const isFailure = (r: unknown): r is ReadFailure => typeof r === 'object' && r !== null && 'error' in r

/**
 * The PLAIN proxy of a directory pair: the canonical ENS-named entry. An SVR / shared-SVR sibling has no ENS name,
 * carries a `secondaryProxyAddress` and an "-svr" path; none of those is ever a candidate.
 */
export function isPlainProxy(e: DirectoryEntry): boolean {
  return typeof e.ens === 'string' && e.ens !== '' && e.path === e.ens
    && !e.secondaryProxyAddress && !/svr/i.test(e.path ?? '')
    && e.docs?.hidden !== true && !e.docs?.shutdownDate
}

export interface Candidate {
  symbol: string; token: string; feed: string; description: string; decimals: number; tokenDecimals: number
  heartbeat: number; maxStaleness: number; tier: string; stable: boolean
  /** true = the row is already in the config and is only switched on; false = the row is created. */
  existing: boolean
}
export type Selection = { symbol: string; candidate: Candidate; reasons: [] } | { symbol: string; candidate: null; reasons: string[] }

export interface SelectInput {
  config: RegistrationConfig; chainId: number; symbols: readonly string[]
  directory: readonly DirectoryEntry[]; catalog: readonly CatalogToken[]
}

/** Step 1 (no chain reads): which token, which feed, and whether the directory and the catalog allow it. */
export function selectBatch(input: SelectInput): Selection[] {
  const { config, chainId, symbols, directory, catalog } = input
  const rule = MAX_STALENESS_RULE[chainId]
  const rows = config.chains[String(chainId)]?.rows
  return symbols.map((symbol): Selection => {
    const refuse = (...reasons: string[]): Selection => ({ symbol, candidate: null, reasons })
    if (!rule) return refuse(`no maxStaleness rule for chain ${chainId}`)
    if (!rows) return refuse(`chain ${chainId} has no rows in the config`)
    if (symbols.filter(s => s === symbol).length > 1) return refuse('symbol named more than once')

    const matches = rows.filter(r => r.symbol === symbol)
    if (matches.length > 1) return refuse(`${matches.length} config rows carry this symbol`)
    const row = matches[0]
    if (row?.enabled) return refuse('already enabled')

    // OUR catalog: by token address for a row that exists, by exact symbol for a row to create.
    const listed = row ? catalog.filter(t => lc(t.address) === lc(row.token)) : catalog.filter(t => t.symbol === symbol)
    if (listed.length !== 1) return refuse(`${listed.length} catalog tokens match (need exactly 1)`)
    const token = listed[0]
    if (token.verified !== true) return refuse('catalog token is not verified')
    if (!isChecksummed(token.address)) return refuse(`catalog address is not EIP-55: ${token.address}`)
    if (row && row.token !== token.address) return refuse(`row token ${row.token} != catalog ${token.address}`)

    // Chainlink directory: the directory carries no token address, so a created row joins on the exact
    // symbol ("SYMBOL / USD"); an existing row joins on the description it was built with.
    const description = row ? row.description : `${symbol} / USD`
    if (!description.endsWith(' / USD')) return refuse(`description "${description}" is not a "… / USD" feed`)
    const named = directory.filter(e => e.name === description && e.docs?.quoteAsset === 'USD'
      && (row ? true : e.docs?.baseAsset === symbol))
    if (named.length === 0) return refuse(`the directory has no "${description}" feed on this chain`)
    const plain = named.filter(isPlainProxy)
    if (plain.length !== 1) return refuse(`"${description}": ${plain.length} plain proxies among ${named.length} directory entries (need exactly 1; SVR and secondary proxies never qualify)`)
    const entry = plain[0]
    if (!isChecksummed(entry.proxyAddress)) return refuse(`directory proxy is not EIP-55: ${String(entry.proxyAddress)}`)
    const feed = entry.proxyAddress
    if (row && row.feed !== feed) return refuse(`row feed ${row.feed} is not the directory's plain proxy ${feed}`)

    const reasons: string[] = []
    const category = entry.feedCategory ?? ''
    if (!ALLOWED_CATEGORIES.includes(category)) reasons.push(`directory category "${category}" is not low or medium`)
    const heartbeat = entry.heartbeat
    if (typeof heartbeat !== 'number' || !Number.isInteger(heartbeat) || heartbeat <= 0) reasons.push(`directory heartbeat ${String(heartbeat)} is not a positive integer`)
    if (typeof entry.decimals !== 'number') reasons.push('directory entry has no decimals')
    if (row && row.heartbeat !== heartbeat) reasons.push(`row heartbeat ${row.heartbeat} != directory ${String(heartbeat)}`)
    if (row && row.decimals !== entry.decimals) reasons.push(`row feed decimals ${row.decimals} != directory ${String(entry.decimals)}`)
    if (row && row.tokenDecimals !== token.decimals) reasons.push(`row tokenDecimals ${row.tokenDecimals} != catalog ${token.decimals}`)
    if (reasons.length) return refuse(...reasons)

    return {
      symbol, reasons: [],
      candidate: {
        symbol, token: token.address, feed, description, decimals: entry.decimals as number, tokenDecimals: token.decimals,
        heartbeat: heartbeat as number, maxStaleness: rule(heartbeat as number), tier: category,
        stable: token.category === STABLE_CATEGORY, existing: !!row,
      },
    }
  })
}

/** Step 2: the live checks plan.ts applies, on TWO RPCs that must agree, plus the stablecoin band. */
export function liveProblems(c: Candidate, live: LiveReadings): string[] {
  const reasons: string[] = []
  const readings = live.feeds[lc(c.feed)] ?? []
  if (readings.length < MIN_RPC_READINGS) reasons.push(`${readings.length} RPC reading(s) of the feed (need ${MIN_RPC_READINGS})`)
  const good: FeedReading[] = []
  readings.forEach((r, i) => { if (isFailure(r)) reasons.push(`RPC ${i + 1} read failed: ${r.error}`); else good.push(r) })
  const first = good[0]
  if (first) {
    if (good.some(r => r.description !== first.description || r.decimals !== first.decimals || r.answer !== first.answer || r.updatedAt !== first.updatedAt)) {
      reasons.push('RPCs disagree on the feed (description, decimals, answer or updatedAt)')
    }
    if (first.description !== c.description) reasons.push(`description "${first.description}" != "${c.description}"`)
    if (first.decimals !== c.decimals) reasons.push(`feed decimals ${first.decimals} != ${c.decimals}`)
    let answer = 0n
    try { answer = BigInt(first.answer) } catch { reasons.push(`answer "${first.answer}" is not an integer`) }
    if (!(answer > 0n)) reasons.push(`answer ${first.answer} not > 0`)
    const age = live.now - first.updatedAt
    if (age > 2 * c.heartbeat) reasons.push(`age ${age}s > 2x heartbeat ${c.heartbeat}s`)
    if (age >= DAY_SEC) reasons.push(`age ${age}s >= ${DAY_SEC}s: executeTokenUsdFeed would revert`)
    if (c.stable && answer > 0n) {
      const unit = 10n ** BigInt(first.decimals)
      if (answer * 100n < BigInt(STABLE_BAND_CENTS.min) * unit || answer * 100n > BigInt(STABLE_BAND_CENTS.max) * unit) {
        reasons.push(`stablecoin answer ${first.answer} (${first.decimals} dp) is outside 0.98 to 1.02`)
      }
    }
  }
  const dec = live.tokenDecimals[lc(c.token)]
  if (dec === undefined) reasons.push('token decimals() was not read')
  else if (isFailure(dec)) reasons.push(`token decimals() read failed: ${dec.error}`)
  else if (dec !== c.tokenDecimals) reasons.push(`token decimals() ${dec} != ${c.tokenDecimals}`)
  return reasons
}

export interface BatchReportRow {
  symbol: string; status: 'enable' | 'create' | 'refused'; reasons: string[]
  token?: string; feed?: string; description?: string; category?: string; heartbeat?: number; maxStaleness?: number; ageSec?: number
}
export interface BatchResult {
  /** The whole next config, or null when ANY symbol was refused (nothing may be written). */
  next: RegistrationConfig | null
  report: BatchReportRow[]
}
export interface ApplyInput extends SelectInput {
  /** Batch label, YYYY-MM. */
  batch: string
  /** Day the directory was read (YYYY-MM-DD); recorded in the `source` of a CREATED row only. */
  date: string
  live: LiveReadings
}

export function applyBatch(input: ApplyInput): BatchResult {
  const { config, chainId, batch, date, live } = input
  const selections = selectBatch(input)
  const global: string[] = []
  if (!BATCH_RE.test(batch)) global.push(`batch "${batch}" is not YYYY-MM`)
  if (!DATE_RE.test(date)) global.push(`date "${date}" is not YYYY-MM-DD`)
  if (input.symbols.length === 0) global.push('no symbols named')

  const report: BatchReportRow[] = selections.map((s) => {
    if (!s.candidate) return { symbol: s.symbol, status: 'refused', reasons: [...global, ...s.reasons] }
    const c = s.candidate
    const reasons = [...global, ...liveProblems(c, live)]
    const reading = (live.feeds[lc(c.feed)] ?? []).find((r): r is FeedReading => !isFailure(r))
    return {
      symbol: c.symbol, status: reasons.length ? 'refused' : c.existing ? 'enable' : 'create', reasons,
      token: c.token, feed: c.feed, description: c.description, category: c.tier, heartbeat: c.heartbeat,
      maxStaleness: c.maxStaleness, ageSec: reading ? live.now - reading.updatedAt : undefined,
    }
  })
  if (global.length && report.length === 0) report.push({ symbol: '(batch)', status: 'refused', reasons: global })
  if (report.some(r => r.status === 'refused')) return { next: null, report }

  const next = structuredClone(config)
  const rows = next.chains[String(chainId)].rows
  for (const s of selections) {
    const c = s.candidate as Candidate
    const row = rows.find(r => r.symbol === c.symbol)
    if (row) {
      // Only the batch fields change; identity fields were proven equal to the directory and the catalog above.
      Object.assign(row, { maxStaleness: c.maxStaleness, tier: c.tier, enabled: true, action: 'register', batch })
    } else {
      const created: RegistrationRow = {
        symbol: c.symbol, token: c.token, feed: c.feed, description: c.description, decimals: c.decimals,
        tokenDecimals: c.tokenDecimals, heartbeat: c.heartbeat, maxStaleness: c.maxStaleness, tier: c.tier,
        phase: 2, enabled: true, action: 'register', source: `chainlink-directory ${date}`, batch,
      }
      rows.push(Object.fromEntries(ROW_KEYS.map(k => [k, created[k]])) as unknown as RegistrationRow)
    }
  }
  return { next, report }
}
