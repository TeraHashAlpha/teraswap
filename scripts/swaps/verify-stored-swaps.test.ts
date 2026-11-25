// @vitest-environment node
/**
 * [ADR-029 section 4, details F] scripts/swaps/verify-stored-swaps.ts on recorded REAL receipts: report mode writes
 * nothing; --apply sets the two columns on passing rows only; a row that verifies but stores other values than the
 * receipt's is reported and left alone (owner, 2026-11-25); no key and no RPC URL is ever printed.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_FEE_COLLECTOR
  process.env.NEXT_PUBLIC_BASE_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
  process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
})

import { SWAP_RECEIPTS as R, recordedChainRead, type SwapReceiptFixture } from '@/lib/__fixtures__/swap-receipts'
import { verifySwapOnChain } from '@/lib/swap-verify/verify-swap-on-chain'
import { createFakeSwapsDb, type Row } from '@/test-utils/fake-swaps-db'
import { checkRow, compareStored, main, parseArgs, parseRows, USAGE, type MainDeps, type RowReport, type Summary, type SwapsDb } from './verify-stored-swaps-lib'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const sender = (f: SwapReceiptFixture) => String(f.tx.from).toLowerCase()

/** A row as main stored it: the caller's status and hash, and whatever tokens and amounts it declared. */
function stored(f: SwapReceiptFixture, overrides: Row = {}): Row {
  return {
    id: `row-${f.name}`, created_at: '2026-11-01T10:00:00.000Z', wallet: sender(f), chain_id: f.chainId, source: 'velora', tx_hash: f.hash,
    status: 'confirmed', token_in: WETH, token_in_symbol: 'WETH', token_out: USDC, token_out_symbol: 'USDC', amount_in: '1', amount_out: '1',
    amount_in_usd: 10, slippage: 0.5, mev_protected: false, fee_collected: true, is_gasless: false, gas_savings_usd: 0,
    verified_at: null, verified_kind: null, ...overrides,
  }
}

/** The honest old row of the mainnet FeeCollector token-to-token swap: declared what the receipt shows; out was the quote. */
const honest = (overrides: Row = {}) =>
  stored(R.mainnetFcTokenToToken, {
    token_in: '0x5086bf358635b81d8c47c66d1c8b9e567db70c72', token_out: USDC, amount_in: '46080134130180921522', amount_out: '51000000', ...overrides,
  })

interface Ran {
  code: number
  lines: Array<Record<string, unknown>>
  rows: RowReport[]
  summary: Summary
  stderr: string[]
  stdoutText: string
  reads: number
}

async function runScript(argv: string[], options: { stdin?: unknown; db?: SwapsDb | null; delay?: number[] } = {}): Promise<Ran> {
  const chain = recordedChainRead()
  const stdout: string[] = []
  const stderr: string[] = []
  const deps: MainDeps = {
    argv,
    readStdin: async () => (typeof options.stdin === 'string' ? options.stdin : JSON.stringify(options.stdin ?? [])),
    out: async (line) => {
      stdout.push(line)
    },
    err: (line) => stderr.push(line),
    verify: (input) => verifySwapOnChain(input, { read: chain.read }),
    db: () => options.db ?? null,
    describe: () => [{ info: 'rpc', chain: 1, source: 'RPC_URL_1' }],
    sleep: async (ms) => {
      options.delay?.push(ms)
    },
    now: () => new Date('2026-11-25T12:00:00.000Z'),
  }
  const code = await main(deps)
  const lines = stdout.flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>]
    } catch {
      return []
    }
  })
  return {
    code,
    lines,
    rows: lines.filter((l) => 'decision' in l) as unknown as RowReport[],
    summary: lines.find((l) => l.summary === true) as unknown as Summary,
    stderr,
    stdoutText: stdout.join('\n'),
    reads: chain.calls.length,
  }
}

describe('report mode is the default and writes nothing', () => {
  it('one JSON line per row (id, chain, kind or reason, derived sides) and a summary; exit 0', async () => {
    const db = createFakeSwapsDb()
    const rows = [
      honest(),
      stored(R.mainnetFcTokenToToken, { id: 'invented', tx_hash: `0x${'11'.repeat(32)}`, wallet: '0x1111111111111111111111111111111111111111' }),
      stored(R.mainnetCowDirect, { id: 'cow', wallet: '0x7249c6f7434dd3d884a2e1eb19b57076d5af6f67', source: 'cowswap', token_in: USDC, token_out: USDT, amount_in: '649256721', amount_out: '650000000' }),
    ]
    const ran = await runScript([], { stdin: rows, db: db.service as unknown as SwapsDb })
    expect(ran.code).toBe(0)
    expect(ran.stderr).toEqual([])
    expect(ran.lines[0]).toEqual({ info: 'mode', mode: 'report', rows: 3, input: 'stdin' })
    expect(ran.rows).toEqual([
      {
        id: 'row-1-fee-collector-token-to-token', chain: 1, decision: 'mark', outcome: 'confirmed', kind: 'fee_collector',
        derived: { tokenIn: '0x5086bf358635b81d8c47c66d1c8b9e567db70c72', amountIn: '46080134130180921522', tokenOut: USDC, amountOut: '51012637', source: 'velora' },
        outRatio: '1.0002',
      },
      { id: 'invented', chain: 1, decision: 'not_found', outcome: 'not_found', reason: 'tx_missing' },
      {
        id: 'cow', chain: 1, decision: 'mark', outcome: 'confirmed', kind: 'cow',
        derived: { tokenIn: USDC, amountIn: '649256721', tokenOut: USDT, amountOut: '650044918', source: 'cowswap' },
        outRatio: '1.0000',
      },
    ])
    expect(ran.summary).toEqual({
      summary: true, mode: 'report', rows: 3,
      byDecision: { mark: 2, not_found: 1 }, byKind: { fee_collector: 1, cow: 1 }, byReason: { tx_missing: 1 },
      byChain: { 1: { mark: 2, not_found: 1 } }, applied: {},
    })
    // The summary is the last line, and nothing was read from or written to the database.
    expect(ran.lines[ran.lines.length - 1]).toEqual(ran.summary)
    expect(db.ops).toEqual([])
  })

  it('--from-db reads the table oldest first and still writes nothing', async () => {
    const db = createFakeSwapsDb({ swaps: [honest({ created_at: '2026-11-02T00:00:00.000Z' }), stored(R.mainnetRouterReverted, { id: 'older', source: '0x', created_at: '2026-11-01T00:00:00.000Z' })] })
    const before = JSON.stringify(db.rows())
    const ran = await runScript(['--from-db'], { db: db.service as unknown as SwapsDb })
    expect(ran.code).toBe(0)
    expect(ran.lines[0]).toEqual({ info: 'mode', mode: 'report', rows: 2, input: 'database' })
    expect(ran.rows.map((r) => r.id)).toEqual(['older', 'row-1-fee-collector-token-to-token'])
    expect(db.writes()).toEqual([])
    expect(JSON.stringify(db.rows())).toBe(before)
  })

  it('--from-db before the migration (no verified_at column): every row is read as unverified', async () => {
    const db = createFakeSwapsDb({ migrated: false, swaps: [honest()] })
    const ran = await runScript(['--from-db'], { db: db.service as unknown as SwapsDb })
    expect(ran.code).toBe(0)
    expect(ran.rows.map((r) => r.decision)).toEqual(['mark'])
    expect(db.writes()).toEqual([])
  })
})

describe('the rows of the incident: none is marked', () => {
  it('invented wallets and hashes, every status, an XSS symbol, 500 WETH declared', async () => {
    const f = R.mainnetFcTokenToToken
    const rows = [
      stored(f, { id: 'a', wallet: '0x1111111111111111111111111111111111111111', tx_hash: `0x${'11'.repeat(32)}`, status: 'confirmed' }),
      stored(f, { id: 'b', wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tx_hash: `0x${'00'.repeat(32)}`, status: 'filled' }),
      stored(f, { id: 'c', wallet: USDC, tx_hash: `0x${'ab'.repeat(32)}`, status: 'reverted', token_in_symbol: '<img src=x onerror=alert(1)>' }),
      // A REAL transaction of another wallet, claimed by an invented one.
      stored(f, { id: 'd', wallet: '0x2222222222222222222222222222222222222222', status: 'confirmed', amount_in: '500000000000000000000', amount_in_usd: 1_700_000 }),
      stored(f, { id: 'e', wallet: sender(f), tx_hash: 'not-a-hash', status: 'confirmed' }),
      stored(f, { id: 'f', wallet: sender(f), tx_hash: null, status: 'confirmed' }),
      stored(f, { id: 'g', wallet: sender(f), source: 'made-up-source', status: 'confirmed' }),
    ]
    const ran = await runScript([], { stdin: rows })
    expect(ran.rows.map((r) => [r.id, r.decision, r.reason])).toEqual([
      ['a', 'not_found', 'tx_missing'],
      ['b', 'not_found', 'tx_missing'],
      ['c', 'not_found', 'tx_missing'],
      ['d', 'rejected', 'wrong_sender'],
      ['e', 'rejected', 'bad_tx_hash'],
      ['f', 'no_tx_hash', undefined],
      ['g', 'rejected', 'bad_source'],
    ])
    expect(ran.summary.byDecision.mark).toBeUndefined()
  })
})

describe('a row that verifies but stores other values than the receipt is not marked (owner, 2026-11-25)', () => {
  const real = R.mainnetFcTokenToToken

  it('a real swap stored as 500 WETH: stored_differs, with both values printed', async () => {
    const ran = await runScript([], { stdin: [stored(real, { amount_in: '500000000000000000000', amount_out: '1700000000000', amount_in_usd: 1_700_000 })] })
    expect(ran.rows[0]).toMatchObject({
      decision: 'stored_differs', outcome: 'confirmed', kind: 'fee_collector',
      differs: ['token_in', 'amount_in', 'amount_out'],
      stored: { status: 'confirmed', tokenIn: WETH, amountIn: '500000000000000000000', tokenOut: USDC, amountOut: '1700000000000' },
      derived: { tokenIn: '0x5086bf358635b81d8c47c66d1c8b9e567db70c72', amountIn: '46080134130180921522', amountOut: '51012637' },
      outRatio: '0.0000',
    })
  })

  it('each stored value is compared on its own', async () => {
    const cases: Array<[Row, string[]]> = [
      [{}, []],
      [{ token_in: WETH }, ['token_in']],
      [{ token_out: USDT }, ['token_out']],
      [{ amount_in: '46080134130180921523' }, ['amount_in']],
      [{ amount_in: '46080134130180921522.00' }, []],
      [{ amount_in: 'forty-six' }, ['amount_in']],
      [{ amount_out: '0' }, ['amount_out']],
      [{ amount_out: null }, ['amount_out']],
      [{ token_in: '0x5086BF358635B81D8C47C66D1C8B9E567DB70C72' }, []],
    ]
    for (const [change, differs] of cases) {
      const ran = await runScript([], { stdin: [honest(change)] })
      expect(ran.rows[0].differs ?? [], JSON.stringify(change)).toEqual(differs)
      expect(ran.rows[0].decision, JSON.stringify(change)).toBe(differs.length === 0 ? 'mark' : 'stored_differs')
    }
  })

  it('amount-out bound: the receipt\'s amount must be 50% to 200% of the stored one, both ends included', async () => {
    // The receipt shows 51012637.
    const cases: Array<[string, boolean]> = [
      ['102025274', true], // receipt is exactly 50% of stored
      ['102025275', false], // one unit more stored: the receipt is below 50%
      ['51012637', true],
      ['25506319', true], // receipt is just under 200% of stored (2 x 25506319 = 51012638)
      ['25506318', false], // 2 x 25506318 = 51012636 < 51012637: above 200%
      ['1', false],
    ]
    for (const [amountOut, ok] of cases) {
      const ran = await runScript([], { stdin: [honest({ amount_out: amountOut })] })
      expect(ran.rows[0].decision, amountOut).toBe(ok ? 'mark' : 'stored_differs')
    }
  })

  it('a side the receipt can not give counts as differing (Base, 0x, token to ETH)', async () => {
    const f = R.baseRouterTokenToEth
    const ran = await runScript([], { stdin: [stored(f, { source: '0x', token_in: '0xe43df70a3a8067680aae799fa5171c3f473b46ed', token_out: NATIVE, amount_in: '5680910050800089169920', amount_out: '1000' })] })
    expect(ran.rows[0]).toMatchObject({ decision: 'stored_differs', kind: 'router', differs: ['token_out', 'amount_out'], derived: { tokenOut: null, amountOut: null } })
    expect(ran.rows[0].outRatio).toBeUndefined()
  })

  it('the stored status must agree with the chain: "confirmed" on a reverted transaction is status_differs', async () => {
    const f = R.mainnetRouterReverted
    const claimedConfirmed = await runScript([], { stdin: [stored(f, { source: '0x', status: 'confirmed' })] })
    expect(claimedConfirmed.rows[0]).toMatchObject({ decision: 'status_differs', outcome: 'failed', differs: ['status', 'token_in', 'token_out', 'amount_in', 'amount_out'] })
    // A stored "failed" agrees on the status, but a reverted transaction gives no side: still not marked.
    const storedFailed = await runScript([], { stdin: [stored(f, { source: '0x', status: 'failed' })] })
    expect(storedFailed.rows[0]).toMatchObject({ decision: 'stored_differs', outcome: 'failed' })
    // "failed" stored for a transaction that succeeded.
    const wrongWay = await runScript([], { stdin: [honest({ status: 'failed' })] })
    expect(wrongWay.rows[0]).toMatchObject({ decision: 'status_differs', differs: ['status'] })
    // "pending" with a hash and a confirmed transaction agrees.
    expect((await runScript([], { stdin: [honest({ status: 'pending' })] })).rows[0].decision).toBe('mark')
    for (const status of ['filled', 'reverted', 'success', '', null]) {
      expect((await runScript([], { stdin: [honest({ status })] })).rows[0].decision, String(status)).toBe('status_differs')
    }
  })

  it('the frozen mainnet FeeCollector V1 counts as kind fee_collector for old rows', async () => {
    const f = R.mainnetFcV1EthToToken
    const ran = await runScript([], { stdin: [stored(f, { source: 'uniswapv3', token_in: NATIVE, token_out: '0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb', amount_in: '5000000000000000', amount_out: '17000000000000000000' })] })
    expect(ran.rows[0]).toMatchObject({ decision: 'mark', kind: 'fee_collector', derived: { tokenIn: NATIVE, amountIn: '5000000000000000', source: 'uniswapv3' }, outRatio: '1.0477' })
  })
})

describe('--apply sets the two columns on passing rows only', () => {
  it('marks the passing row, leaves every other row and every other column as they were', async () => {
    const differing = stored(R.mainnetFcTokenToEth, { id: 'differs', amount_in: '500000000000000000000' })
    const invented = stored(R.mainnetFcTokenToToken, { id: 'invented', tx_hash: `0x${'11'.repeat(32)}`, wallet: '0x1111111111111111111111111111111111111111' })
    const db = createFakeSwapsDb({ swaps: [honest(), differing, invented] })
    const before = db.rows().map((r) => ({ ...r }))

    const ran = await runScript(['--from-db', '--apply'], { db: db.service as unknown as SwapsDb })
    expect(ran.code).toBe(0)
    expect(ran.lines[0]).toEqual({ info: 'mode', mode: 'apply', rows: 3, input: 'database' })
    expect(Object.fromEntries(ran.rows.map((r) => [r.id, [r.decision, r.applied]]))).toEqual({
      'row-1-fee-collector-token-to-token': ['mark', 'marked'],
      differs: ['stored_differs', undefined],
      invented: ['not_found', undefined],
    })
    expect(ran.summary.applied).toEqual({ marked: 1 })

    // One write, of exactly two columns, on one row, guarded by "still unverified".
    expect(db.writes()).toEqual([
      { role: 'service', kind: 'update', table: 'swaps', detail: { verified_at: '2026-11-25T12:00:00.000Z', verified_kind: 'fee_collector' }, filters: ['id=eq.row-1-fee-collector-token-to-token', 'verified_at=is.null'] },
    ])
    const after = db.rows()
    expect(after[0]).toEqual({ ...before[0], verified_at: '2026-11-25T12:00:00.000Z', verified_kind: 'fee_collector' })
    expect(after[1]).toEqual(before[1])
    expect(after[2]).toEqual(before[2])
  })

  it('two rows with one transaction: the second is refused by the unique index and reported duplicate_tx', async () => {
    const db = createFakeSwapsDb({ swaps: [honest({ id: 'first', created_at: '2026-11-01T00:00:00.000Z' }), honest({ id: 'second', created_at: '2026-11-02T00:00:00.000Z' })] })
    const ran = await runScript(['--from-db', '--apply'], { db: db.service as unknown as SwapsDb })
    expect(ran.rows.map((r) => [r.id, r.applied])).toEqual([['first', 'marked'], ['second', 'duplicate_tx']])
    expect(db.rows().map((r) => r.verified_at !== null)).toEqual([true, false])
    expect(ran.summary.applied).toEqual({ marked: 1, duplicate_tx: 1 })
  })

  it('a row already verified is skipped without a chain read; running --apply twice changes nothing the second time', async () => {
    const db = createFakeSwapsDb({ swaps: [honest()] })
    await runScript(['--from-db', '--apply'], { db: db.service as unknown as SwapsDb })
    const after = JSON.stringify(db.rows())
    const again = await runScript(['--from-db', '--apply'], { db: db.service as unknown as SwapsDb })
    expect(again.rows[0]).toEqual({ id: 'row-1-fee-collector-token-to-token', chain: 1, decision: 'already_verified' })
    expect(again.reads).toBe(0)
    expect(JSON.stringify(db.rows())).toBe(after)
  })

  it('--apply before the migration is applied: stops with a fixed message, exit 1, nothing written', async () => {
    const db = createFakeSwapsDb({ migrated: false, swaps: [honest()] })
    const fromDb = await runScript(['--from-db', '--apply'], { db: db.service as unknown as SwapsDb })
    expect([fromDb.code, fromDb.stderr]).toEqual([1, ['verify-stored-swaps: migration_not_applied']])
    const fromStdin = await runScript(['--apply'], { stdin: [honest()], db: db.service as unknown as SwapsDb })
    expect([fromStdin.code, fromStdin.stderr]).toEqual([1, ['verify-stored-swaps: migration_not_applied']])
    expect(db.rows()[0].verified_at ?? null).toBeNull()
  })

  it('--apply or --from-db without the database configured: exit 1, and the message names the two variables, not their values', async () => {
    const ran = await runScript(['--apply'], { stdin: [honest()], db: null })
    expect(ran.code).toBe(1)
    expect(ran.stderr).toEqual(['verify-stored-swaps: database_not_configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'])
    expect(ran.rows).toEqual([])
  })
})

describe('input, arguments and what is printed', () => {
  it('stdin may be an array, { rows: [...] }, one object, or one object per line', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    expect(parseRows(JSON.stringify([a, b]))).toEqual([a, b])
    expect(parseRows(JSON.stringify({ rows: [a, b] }))).toEqual([a, b])
    expect(parseRows(JSON.stringify(a))).toEqual([a])
    expect(parseRows(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`)).toEqual([a, b])
    expect(() => parseRows('')).toThrow(/no input/)
    expect(() => parseRows('id,wallet\n1,0x')).toThrow(/not JSON/)
  })

  it('unreadable input: exit 1 and a fixed message; rows that are not rows are reported, not fatal', async () => {
    const bad = await runScript([], { stdin: 'this is not json' })
    expect(bad.code).toBe(1)
    expect(bad.stderr[0]).toMatch(/^verify-stored-swaps: input is not JSON/)
    const odd = await runScript([], { stdin: [5, null, 'x', [], { tx_hash: R.mainnetFcTokenToToken.hash }, { id: 'no-chain', tx_hash: R.mainnetFcTokenToToken.hash, wallet: 'w', source: 's' }] })
    expect(odd.code).toBe(0)
    expect(odd.rows.map((r) => [r.decision, r.reason])).toEqual([
      ['bad_row', 'not_an_object'], ['bad_row', 'not_an_object'], ['bad_row', 'not_an_object'], ['bad_row', 'not_an_object'], ['bad_row', 'no_id'], ['bad_row', 'no_chain_id'],
    ])
    expect(odd.reads).toBe(0)
  })

  it('arguments', () => {
    expect(parseArgs([])).toEqual({ apply: false, fromDb: false, delayMs: 200, limit: null, help: false })
    expect(parseArgs(['--apply', '--from-db', '--delay-ms', '0', '--limit', '5'])).toEqual({ apply: true, fromDb: true, delayMs: 0, limit: 5, help: false })
    expect(parseArgs(['--delay-ms'])).toEqual({ error: '--delay-ms needs a whole number' })
    expect(parseArgs(['--limit', '-1'])).toEqual({ error: '--limit needs a whole number' })
    expect(parseArgs(['--aply'])).toEqual({ error: 'unknown argument: --aply' })
    expect(parseArgs(['--x\u001b[31m'])).toEqual({ error: 'unknown argument: --x?[31m' })
  })

  it('a bad argument: exit 2 and the usage on stderr; --help: the usage on stdout, exit 0', async () => {
    const bad = await runScript(['--nope'])
    expect(bad.code).toBe(2)
    expect(bad.stderr[0]).toBe('verify-stored-swaps: unknown argument: --nope')
    expect(bad.stderr[1]).toBe(USAGE)
    const help = await runScript(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdoutText).toBe(USAGE)
  })

  it('--limit checks at most that many rows; the pause runs only after a row that read the chain', async () => {
    const delay: number[] = []
    const rows = [honest({ id: 'one' }), honest({ id: 'two', tx_hash: null }), honest({ id: 'three' }), honest({ id: 'four' })]
    const ran = await runScript(['--limit', '3', '--delay-ms', '7'], { stdin: rows, delay })
    expect(ran.rows.map((r) => r.id)).toEqual(['one', 'two', 'three'])
    expect(delay).toEqual([7, 7])
  })

  it('no key, no RPC URL and no database host is ever printed, on success or on failure', async () => {
    const saved = { ...process.env }
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'SECRET-SERVICE-ROLE-KEY'
    process.env.SUPABASE_URL = 'https://secret-project-ref.supabase.co'
    process.env.RPC_URL_1 = 'https://provider.example/v2/SECRET-RPC-KEY'
    try {
      const failing: SwapsDb = {
        from: () => ({
          select: () => ({ order: () => ({ range: async () => ({ data: null, error: { code: '08006', message: 'connection to https://secret-project-ref.supabase.co failed for key SECRET-SERVICE-ROLE-KEY' } }) }) }),
          update: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: null, error: { code: 'XX000', message: 'SECRET-SERVICE-ROLE-KEY' } }) }) }) }),
        }),
      }
      const read = await runScript(['--from-db'], { db: failing })
      expect([read.code, read.stderr]).toEqual([1, ['verify-stored-swaps: db_read_failed code=08006']])
      const write = await runScript(['--apply'], { stdin: [honest()], db: failing })
      expect(write.rows[0].applied).toBe('error')
      const ok = await runScript([], { stdin: [honest()] })
      for (const ran of [read, write, ok]) {
        const everything = `${ran.stdoutText}\n${ran.stderr.join('\n')}`
        expect(everything).not.toContain('SECRET')
        expect(everything).not.toContain('secret-project-ref')
        expect(everything).not.toContain('provider.example')
      }
    } finally {
      process.env = saved
    }
  })

  it('an unexpected failure is reported as "failed", never with its text', async () => {
    const chain = recordedChainRead()
    const stderr: string[] = []
    const code = await main({
      argv: [], readStdin: async () => JSON.stringify([honest()]), out: async () => {}, err: (l) => stderr.push(l),
      verify: async () => {
        throw new Error('https://provider.example/v2/SECRET-RPC-KEY refused')
      },
      db: () => null, describe: () => [], sleep: async () => {},
    })
    void chain
    expect([code, stderr]).toEqual([1, ['verify-stored-swaps: failed']])
  })
})

describe('the command-line file', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/swaps/verify-stored-swaps.ts'), 'utf8')
  const lib = readFileSync(join(process.cwd(), 'scripts/swaps/verify-stored-swaps-lib.ts'), 'utf8')
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('ends with process.exitCode and never calls process.exit, so a piped report is not cut short', () => {
    expect(code(source)).toMatch(/process\.exitCode = code/)
    expect(code(source)).not.toMatch(/process\.exit\s*\(/)
    expect(code(lib)).not.toMatch(/process\.exit\s*\(/)
  })

  it('reads the database key by NAME from the environment and prints neither it nor an RPC URL', () => {
    expect(code(source)).toMatch(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/)
    expect(code(source)).not.toMatch(/console\.(log|error)\([^)]*(key|url)/i)
    expect(code(source)).toMatch(/serverOnlyRpcSource/)
    expect(code(source)).not.toMatch(/serverOnlyRpcUrl|serverRpcUrl/)
  })

  it('checks rows with the same function the route uses', () => {
    expect(code(source)).toMatch(/verifySwapOnChain\(input\)/)
    expect(code(readFileSync(join(process.cwd(), 'src/lib/swap-log/confirm.ts'), 'utf8'))).toMatch(/verifySwapOnChain\(/)
  })
})

describe('compareStored and checkRow, directly', () => {
  it('compareStored reports the ratio to four decimals', () => {
    const derived = { tokenIn: WETH, amountIn: '10', tokenOut: USDC, amountOut: '15', source: 'x', gasUsed: null, gasPrice: null }
    expect(compareStored({ status: 'confirmed', token_in: WETH, token_out: USDC, amount_in: '10', amount_out: '10' }, 'confirmed', derived)).toEqual({ statusAgrees: true, differs: [], outRatio: '1.5000' })
    expect(compareStored({ status: 'confirmed', token_in: WETH, token_out: USDC, amount_in: 10, amount_out: 30 }, 'confirmed', derived)).toEqual({ statusAgrees: true, differs: [], outRatio: '0.5000' })
  })

  it('checkRow never calls verify for a row with no hash, no id, or already verified', async () => {
    const verify = vi.fn()
    expect((await checkRow({ id: 'x', chain_id: 1, verified_at: '2026-11-01T00:00:00Z', tx_hash: 'h' }, verify)).decision).toBe('already_verified')
    expect((await checkRow({ id: 'x', chain_id: 1, tx_hash: '' }, verify)).decision).toBe('no_tx_hash')
    expect((await checkRow({ chain_id: 1, tx_hash: 'h' }, verify)).decision).toBe('bad_row')
    expect(verify).not.toHaveBeenCalled()
  })
})
