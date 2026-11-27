// @vitest-environment node
/**
 * [ADR-029 section 7.3, goal 133b details I.4 and K] Guard: no reader of `swaps`, public or private, returns the three
 * PRIVATE claim columns (claimed_tx_hash, claimed_chain_id, claimed_at). The repository's read-columns guard covers
 * `orders` (src/app/api/orders/orders-read-select-guard.test.ts); this is its counterpart for `swaps` (owner's answer of
 * 2026-11-26: its own file, the orders guard untouched). Two layers:
 *   1. Dynamic: every reader is driven, flag off and flag on, over rows that ALL carry a claim with marker values; no
 *      answer may contain a marker or a claim column's name, and no select it sends may name a claim column.
 *      `/api/history` is driven with and without the wallet's read signature (the fills path).
 *   2. Static: in src/ (tests excluded) a claim column's name appears only inside src/lib/swap-log/ (the swap log
 *      itself); and every `.from('swaps')` read that selects `*` (rows, not a head count) is one this file lists, each
 *      with how it keeps the claim out: a new `*` reader of swaps fails here until it is reviewed and listed.
 * Each layer's checker is first shown to FAIL on what it is meant to catch, so the guard cannot pass vacuously.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'

const state = vi.hoisted(() => {
  process.env.TZ = 'UTC'
  process.env.MONITOR_SECRET = 'guard-monitor-secret'
  process.env.HEALTH_TOKEN = 'guard-health-token'
  process.env.SUPABASE_URL = 'https://guard.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'guard-not-a-key'
  process.env.RATE_LIMIT_SALT = 'test-only-salt-0123456789-abcdefghijklmnop'
  delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  return { db: null as unknown as import('@/test-utils/fake-swaps-db').FakeSwapsDb }
})

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => state.db.service,
  getSupabaseLogger: () => state.db.logger,
  isSupabaseEnabled: () => true,
}))
vi.mock('@/lib/kv', async () => {
  const { fakeUpstash } = await import('@/test-utils/fake-upstash-kv')
  return { kv: fakeUpstash.kv, kvRaw: fakeUpstash.kvRaw }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = async () => ({ allowed: true, remaining: 99, resetAt: 1_900_000_000_000 })
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})
vi.mock('@/lib/source-health-monitor', () => ({ checkSourceHealthAlerts: async () => [] }))

import { buildOrdersReadTypedData, ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE } from '@/lib/order-engine/read-auth'
import { SWAP_PRIVATE_COLUMNS, withoutPrivateSwapColumns } from '@/lib/swap-log/private-columns'
import { generateSurplusReport } from '@/lib/surplus-report'
import { createFakeSwapsDb, SWAPS_CLAIM_COLUMNS, type RecordedOp, type Row } from '@/test-utils/fake-swaps-db'
import { fakeUpstash } from '@/test-utils/fake-upstash-kv'
import { GET as analyticsGet } from './analytics/route'
import { GET as exportGet } from './analytics/export/route'
import { GET as personalGet } from './analytics/personal/route'
import { GET as healthGet } from './health/route'
import { GET as historyGet } from './history/route'
import { GET as monitorGet } from './monitor/route'
import { GET as statsGet } from './stats/route'

// Published Anvil/Hardhat default account #0 key, value-allowlisted in .gitleaks.toml (NOT a secret).
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const WALLET = account.address.toLowerCase()

/** Marker values a claim carries here; none may reach an answer. */
const CLAIM_HASH = `0xc1a1${'7e'.repeat(30)}`
const CLAIM_AT = '2001-02-03T04:05:06.789Z'
const CLAIM_CHAIN = 42161
const MARKERS = [CLAIM_HASH, CLAIM_HASH.toUpperCase().replace('0X', '0x'), CLAIM_AT, '2001-02-03', ...SWAP_PRIVATE_COLUMNS]

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

function swapRows(): Row[] {
  const rows: Row[] = []
  const statuses = ['confirmed', 'confirmed', 'pending', 'pending', 'failed', 'confirmed']
  for (let i = 0; i < 24; i++) {
    const verified = i % 3 !== 2
    rows.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      created_at: new Date(NOW - i * 3_600_000).toISOString(),
      wallet: i % 2 === 0 ? WALLET : `0x${String(i).padStart(40, '7')}`,
      tx_hash: statuses[i % statuses.length] === 'pending' ? null : `0x${String(i).padStart(64, 'a')}`,
      chain_id: [1, 8453, 42161][i % 3],
      status: statuses[i % statuses.length],
      source: ['velora', 'cowswap', '0x'][i % 3],
      token_in: WETH, token_in_symbol: 'WETH', token_out: USDC, token_out_symbol: 'USDC',
      amount_in: '1000000000000000000', amount_out: '3400000000', amount_in_usd: 3400, amount_out_usd: 3399.5,
      slippage: 0.5, mev_protected: i % 3 === 1, fee_collected: i % 3 === 0, fee_amount: null, gas_used: '150000', gas_price: '1000000000',
      mev_savings_estimate: null, mev_savings_actual: i % 3 === 1 ? '12345' : null, is_gasless: i % 3 === 1, gas_savings_usd: i % 3 === 1 ? 1.5 : 0,
      expected_output: null,
      verified_at: verified && statuses[i % statuses.length] !== 'pending' ? new Date(NOW - i * 3_600_000).toISOString() : null,
      verified_kind: verified && statuses[i % statuses.length] !== 'pending' ? ['fee_collector', 'cow', 'router'][i % 3] : null,
      // EVERY row carries a claim, verified or not: whatever a reader picks, a claim is in it.
      claimed_tx_hash: CLAIM_HASH, claimed_chain_id: CLAIM_CHAIN, claimed_at: CLAIM_AT,
    })
  }
  return rows
}

function otherTables(): Record<string, Row[]> {
  const order = (i: number): Row => ({
    wallet: WALLET, order_type: 'dca', token_in: USDC, token_in_symbol: 'USDC', token_out: WETH, token_out_symbol: 'WETH',
    chain_id: 1, router: '0x6a000f20005980200259b80c5102003040001068', dca_total: 4, amount_in: '400000000', status: i % 2 === 0 ? 'executed' : 'active',
    token_in_decimals: 6, token_out_decimals: 18, dca_executed: 2,
  })
  return {
    order_executions: Array.from({ length: 6 }, (_, i) => ({
      id: `e-${i}`, created_at: new Date(NOW - i * 7_200_000).toISOString(), tx_hash: `0x${String(i).padStart(64, 'e')}`,
      amount_in: '1000000', amount_out: '300000000000000', status: 'confirmed', order_id: `o-${i}`, execution_number: i, executed_at: new Date(NOW - i * 7_200_000).toISOString(),
      orders: order(i),
    })),
  }
}

async function readAuth(): Promise<Record<string, string>> {
  const issuedAt = Math.floor(NOW / 1000)
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: await account.signTypedData(buildOrdersReadTypedData(WALLET, issuedAt)),
  }
}

const READERS: Record<string, () => Promise<Response | unknown>> = {
  'GET /api/stats': () => statsGet(),
  'GET /api/analytics': () => analyticsGet(),
  'GET /api/analytics/export?wallet': () => exportGet(new NextRequest(`http://localhost/api/analytics/export?wallet=${WALLET}`)),
  'GET /api/analytics/personal?wallet': () => personalGet(new NextRequest(`http://localhost/api/analytics/personal?wallet=${WALLET}`)),
  'GET /api/monitor': () => monitorGet(new Request('http://localhost/api/monitor', { headers: { authorization: 'Bearer guard-monitor-secret' } })),
  'GET /api/monitor?wallet': () => monitorGet(new Request(`http://localhost/api/monitor?wallet=${WALLET}`, { headers: { authorization: 'Bearer guard-monitor-secret' } })),
  'GET /api/health': () => healthGet(new NextRequest('http://localhost/api/health', { headers: { authorization: 'Bearer guard-health-token' } })),
  'surplus-report generateSurplusReport()': () => generateSurplusReport(),
  'GET /api/history?wallet': () => historyGet(new NextRequest(`http://localhost/api/history?wallet=${WALLET}&limit=100`)),
  'GET /api/history?wallet (read signature: swaps + fills)': async () =>
    historyGet(new NextRequest(`http://localhost/api/history?wallet=${WALLET}&limit=100`, { headers: await readAuth() })),
}

/** Problems of one answer and the selects it sent, as text; [] when nothing of a claim is in either. */
function answerProblems(name: string, body: string, ops: readonly Pick<RecordedOp, 'kind' | 'table' | 'detail'>[]): string[] {
  const problems: string[] = []
  for (const marker of MARKERS) if (body.includes(marker)) problems.push(`${name}: the answer contains ${marker}`)
  for (const op of ops) {
    if (op.table !== 'swaps' || op.kind !== 'select') continue
    for (const column of SWAP_PRIVATE_COLUMNS) if (String(op.detail).includes(column)) problems.push(`${name}: a select names ${column}`)
  }
  return problems
}

/**
 * [goal 133c P.1] The same rows as round 3 writes them outside a claim: the three columns present, and null (a POST
 * row, a verified row). A reader that stopped stripping the columns would still answer with their NAMES.
 */
function swapRowsWithEmptyClaims(): Row[] {
  return swapRows().map((r) => ({ ...r, claimed_tx_hash: null, claimed_chain_id: null, claimed_at: null }))
}

async function run(name: string, swaps: Row[] = swapRows()): Promise<{ body: string; ops: RecordedOp[]; status: number }> {
  state.db = createFakeSwapsDb({ swaps, tables: otherTables(), now: () => new Date(NOW) })
  fakeUpstash.reset()
  const answer = await READERS[name]()
  const ops = [...state.db.ops]
  if (answer instanceof Response) return { body: await answer.text(), ops, status: answer.status }
  return { body: JSON.stringify(answer), ops, status: 0 }
}

beforeEach(() => {
  delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

describe('guard, layer 1: no reader answers with a claim column, flag off or on', () => {
  it('the checker itself fails an answer that carries a claim and a select that names one', () => {
    const leaked = JSON.stringify(swapRows().slice(0, 1))
    expect(answerProblems('x', leaked, []).length).toBeGreaterThan(0)
    expect(answerProblems('x', '{"ok":1}', [{ kind: 'select', table: 'swaps', detail: 'id, claimed_at' }])).toEqual(['x: a select names claimed_at'])
    expect(answerProblems('x', '{"ok":1}', [{ kind: 'select', table: 'swaps', detail: '*' }])).toEqual([])
    // What `/api/history` did before this change (rows passed on whole) is caught; what it does now is not.
    const rows = swapRows()
    expect(answerProblems('x', JSON.stringify({ swaps: rows.map((r) => ({ ...r, kind: 'swap' })) }), []).length).toBeGreaterThan(0)
    expect(answerProblems('x', JSON.stringify({ swaps: rows.map((r) => ({ ...withoutPrivateSwapColumns(r), kind: 'swap' })) }), [])).toEqual([])
  })

  for (const flag of ['off', 'on'] as const) {
    it.each(Object.keys(READERS))(`flag ${flag}: %s`, async (name) => {
      if (flag === 'on') process.env.SWAPS_PUBLIC_VERIFIED_ONLY = 'true'
      const { body, ops } = await run(name)
      // Not vacuous: the reader answered, and it read rows of swaps (each of which carries a claim).
      expect(body.length, name).toBeGreaterThan(20)
      expect(ops.some((o) => o.table === 'swaps' && o.kind === 'select'), name).toBe(true)
      expect(answerProblems(name, body, ops)).toEqual([])
    })
  }

  it('the history answers are not vacuous: the swaps are listed (and, signed, the fills too)', async () => {
    // CHANGED EXPECTATION (goal 133c P.1, B4): a row that holds a claim is a claim row, and the History tab leaves claim
    // rows out: over rows that ALL carry a claim, history lists none of them (round 2 listed the 12, columns stripped).
    const allClaims = JSON.parse((await run('GET /api/history?wallet')).body) as { swaps: Row[]; fillsIncluded: boolean }
    expect(allClaims.swaps.filter((s) => s.kind === 'swap')).toHaveLength(0)
    // Not vacuous: over the same rows with the columns present and empty (as round 3 writes every other row), the 12 are
    // listed, and the column NAMES are stripped (answerProblems looks for them too).
    const plainRun = await run('GET /api/history?wallet', swapRowsWithEmptyClaims())
    expect(answerProblems('history, empty claims', plainRun.body, plainRun.ops)).toEqual([])
    const plain = JSON.parse(plainRun.body) as { swaps: Row[]; fillsIncluded: boolean }
    expect(plain.swaps.filter((s) => s.kind === 'swap')).toHaveLength(12)
    expect(plain.swaps.every((s) => !Object.keys(s).some((k) => k.startsWith('claimed_')))).toBe(true)
    // Every other column of the row is still there.
    expect(Object.keys(plain.swaps.find((s) => s.kind === 'swap') ?? {})).toEqual(expect.arrayContaining(['verified_at', 'verified_kind', 'tx_hash', 'expected_output']))
    const signed = JSON.parse((await run('GET /api/history?wallet (read signature: swaps + fills)', swapRowsWithEmptyClaims())).body) as { swaps: Row[]; fillsIncluded: boolean }
    expect(signed.fillsIncluded).toBe(true)
    expect(signed.swaps.filter((s) => s.kind === 'swap')).toHaveLength(12)
  })

  it('the fake database and the module name the same three columns', () => {
    expect([...SWAP_PRIVATE_COLUMNS]).toEqual([...SWAPS_CLAIM_COLUMNS])
  })
})

// ── Layer 2: the source ────────────────────────────────────────────────────────────────────────────────────────────
interface Chain { file: string; line: number; tableArg: string; calls: Array<{ name: string; args: string }> }

function skipTrivia(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue }
    return i
  }
}

function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++
      continue
    }
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) return i
  }
  return src.length
}

function fromChains(file: string, src: string): Chain[] {
  const out: Chain[] = []
  for (const m of src.matchAll(/\.from\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1
    const argClose = matchParen(src, open)
    const calls: Chain['calls'] = []
    let i = argClose + 1
    for (;;) {
      i = skipTrivia(src, i)
      if (src[i] !== '.') break
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i + 1))
      if (!id) break
      i = skipTrivia(src, i + 1 + id[0].length)
      if (src[i] !== '(') break
      const close = matchParen(src, i)
      calls.push({ name: id[0], args: src.slice(i + 1, close) })
      i = close + 1
    }
    out.push({ file, line: src.slice(0, m.index).split('\n').length, tableArg: src.slice(open + 1, argClose).trim(), calls })
  }
  return out
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

/** `*` (or no column list) and not a head-only count: the select returns whole rows. */
function selectsWholeRows(chain: Chain): boolean {
  if (chain.calls.some((c) => WRITES.has(c.name))) return false
  return chain.calls.some((c) => {
    if (c.name !== 'select') return false
    const first = /^\s*(['"`])([^'"`]*)\1/.exec(c.args)
    const columns = first ? first[2].trim() : c.args.trim() === '' ? '' : null
    if (columns === null) return true // not a literal: can not be told, counted as rows
    if (columns !== '' && columns !== '*') return false
    return !/head\s*:\s*true/.test(c.args)
  })
}

/**
 * The `*` readers of swaps that exist today, and how each keeps the claim columns out. Layer 1 drives both.
 *  - history: passes each row through withoutPrivateSwapColumns (history/route.ts mapSwapRow).
 *  - analytics: builds each trade field by field (computeDashboard); no row is passed on.
 */
const STAR_READERS: Record<string, string> = {
  'src/app/api/history/route.ts': 'withoutPrivateSwapColumns',
  'src/app/api/analytics/route.ts': 'computeDashboard',
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'test-utils' || e.name === '__fixtures__') continue
      out.push(...sourceFiles(p))
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * Every problem one file has: a claim column named outside the swap log, or a `*` swaps read not listed above. The swap
 * log itself (src/lib/swap-log/) is the one place that reads and writes claims; its answers to a caller are fixed
 * outcomes, never rows (route.ts answers `{ ok }`, a status and fixed words).
 */
function fileProblems(rel: string, src: string): string[] {
  if (rel.startsWith('src/lib/swap-log/')) return []
  const problems: string[] = []
  for (const column of SWAP_PRIVATE_COLUMNS) if (src.includes(column)) problems.push(`${rel}: names ${column} outside src/lib/swap-log/`)
  for (const chain of fromChains(rel, src)) {
    if (!/^(['"`])swaps\1$/.test(chain.tableArg) || !selectsWholeRows(chain)) continue
    const how = STAR_READERS[rel]
    if (how === undefined) problems.push(`${rel}:${chain.line}: reads whole swaps rows and is not a reviewed * reader`)
    else if (!src.includes(how)) problems.push(`${rel}:${chain.line}: listed as using ${how}, which it no longer does`)
  }
  return problems
}

describe('guard, layer 2: the source names no claim column outside the swap log, and every * reader is reviewed', () => {
  it('the scanner itself fails a claim column in a reader and an unlisted * read, and passes a head count', () => {
    expect(fileProblems('src/app/api/x/route.ts', "sb.from('swaps').select('id, claimed_tx_hash')")).toEqual([
      'src/app/api/x/route.ts: names claimed_tx_hash outside src/lib/swap-log/',
    ])
    expect(fileProblems('src/app/api/x/route.ts', "sb\n  .from('swaps')\n  .select('*')\n  .eq('wallet', w)")).toEqual([
      'src/app/api/x/route.ts:2: reads whole swaps rows and is not a reviewed * reader',
    ])
    expect(fileProblems('src/app/api/x/route.ts', "sb.from('swaps').select()")).toHaveLength(1)
    expect(fileProblems('src/app/api/x/route.ts', "sb.from('swaps').select(columns)")).toHaveLength(1)
    expect(fileProblems('src/app/api/x/route.ts', "sb.from('swaps').select('*', { count: 'exact', head: true })")).toEqual([])
    expect(fileProblems('src/app/api/x/route.ts', "sb.from('swaps').select('id, wallet')")).toEqual([])
    expect(fileProblems('src/app/api/history/route.ts', "sb.from('swaps').select('*')")).toEqual([
      'src/app/api/history/route.ts:1: listed as using withoutPrivateSwapColumns, which it no longer does',
    ])
    expect(fileProblems('src/lib/swap-log/store.ts', "sb.from('swaps').update({ claimed_tx_hash: h })")).toEqual([])
    expect(fileProblems('src/lib/swap-log/store.ts', 'sb.from(\'swaps\').select(ROW_COLUMNS)')).toEqual([])
  })

  it('src/ passes', () => {
    const root = path.resolve(process.cwd(), 'src')
    const problems: string[] = []
    let swapsReads = 0
    for (const file of sourceFiles(root)) {
      const rel = path.relative(process.cwd(), file).split(path.sep).join('/')
      const src = fs.readFileSync(file, 'utf8')
      swapsReads += fromChains(rel, src).filter((c) => /^(['"`])swaps\1$/.test(c.tableArg)).length
      problems.push(...fileProblems(rel, src))
    }
    // Not vacuous: the eight readers and the swap log read swaps in well over ten places.
    expect(swapsReads).toBeGreaterThanOrEqual(14)
    expect(problems).toEqual([])
  })
})
