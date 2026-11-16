/**
 * [feat/dca-feed-candidates-weekly] The weekly candidate list, on RECORDED fixtures: no network, no clock.
 *
 * __fixtures__/candidates-2026-11/ was recorded 2026-11-14 from the sources candidates.ts reads:
 *   directory.base.json  14 entries of Chainlink's Base directory (ten "X / USD" names, SVR siblings included; only the fields the lib reads)
 *   catalog.base.json    10 tokens of src/config/generated/token-catalog.8453.json
 *   config.base.json     3 rows of src/config/dca-feed-registrations.json (USDC phase 0 enabled, MOG and DEGEN phase 2 disabled)
 *   live.base.json       description() / decimals() / latestRoundData(), token decimals() and tokenUsdFeeds() on two RPCs
 * Every address in a test comes from a fixture; an exclusion is provoked by mutating a copy of one.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  selectCandidates, classify, sortRows, summarize, addCandidates, registrationOf, markdownTable, textTable, cell, serializeConfig,
  type SelectInput, type CandidateLive, type CandidateRow, type RegistrationConfig, type RegistrationRow, type DirectoryEntry, type CatalogEntry, type Report,
} from './candidates-lib'
import { directoryUrl, DIRECTORY_HOST } from './directory'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const fx = <T>(name: string): T => JSON.parse(read(`./__fixtures__/candidates-2026-11/${name}`)) as T
const BASE = '8453'
const NEW_ROWS = ['GHO', 'RSR', 'SNX', 'WBTC']
const EXISTING_ROWS = ['DEGEN', 'MOG']

/** The recorded inputs, with mutable lists so a test can add an entry to its own copy. */
interface Case { input: Omit<SelectInput, 'directory' | 'catalog'> & { directory: DirectoryEntry[]; catalog: CatalogEntry[] }; live: CandidateLive }
function fixture(mutate?: (c: Case) => void): Case {
  const c: Case = {
    input: { config: fx<RegistrationConfig>('config.base.json'), chainId: 8453, directory: fx<DirectoryEntry[]>('directory.base.json'), catalog: fx<CatalogEntry[]>('catalog.base.json') },
    live: fx<CandidateLive>('live.base.json'),
  }
  mutate?.(c)
  return c
}
const run = (c: Case = fixture()): CandidateRow[] => classify(selectCandidates(c.input).selected, c.live)
const rowOf = (rows: CandidateRow[], symbol: string) => rows.find(r => r.symbol === symbol) as CandidateRow
const why = (c: Case, symbol: string) => rowOf(run(c), symbol).reasons.join(' | ')
const status = (c: Case, symbol: string) => rowOf(run(c), symbol).status
const plain = (c: Case, name: string) => c.input.directory.find(e => e.name === name && e.ens && e.path === e.ens) as DirectoryEntry
const tok = (c: Case, symbol: string) => c.input.catalog.find(t => t.symbol === symbol) as CatalogEntry
const feedOf = (c: Case, symbol: string) => (plain(c, `${symbol} / USD`).proxyAddress as string).toLowerCase()
const readings = (c: Case, symbol: string) => c.live.feeds[feedOf(c, symbol)] as unknown as Array<Record<string, unknown>>
const registered = (c: Case, symbol: string) => c.live.registered[tok(c, symbol).address.toLowerCase()] as unknown as Array<Record<string, unknown>>
const configRow = (c: Case, symbol: string) => c.input.config.chains[BASE].rows.find(r => r.symbol === symbol) as RegistrationRow

describe('the recorded Base fixture, as the weekly job sees it', () => {
  const rows = run()
  it('lists six candidates: four new rows and two rows that already exist as disabled phase 2', () => {
    expect(rows.filter(r => r.status === 'candidate').map(r => r.symbol).sort()).toEqual([...NEW_ROWS, ...EXISTING_ROWS].sort())
    expect(rows.filter(r => r.addToConfig).map(r => r.symbol).sort()).toEqual(NEW_ROWS)
    for (const s of EXISTING_ROWS) expect(rowOf(rows, s)).toMatchObject({ inConfig: true, enabled: false, addToConfig: false, registered: false })
    for (const s of NEW_ROWS) expect(rowOf(rows, s)).toMatchObject({ inConfig: false, enabled: null, addToConfig: true, registered: false, reasons: [] })
  })
  it('explains every row that is not a candidate, with the reason', () => {
    expect(rowOf(rows, 'VVV')).toMatchObject({ status: 'excluded' })
    expect(rowOf(rows, 'VVV').reasons.join()).toContain('category "new" is not low or medium')
    expect(rowOf(rows, 'MAMO').reasons.join()).toContain('category "high" is not low or medium')
    expect(rowOf(rows, 'SOL').reasons.join()).toContain('0 plain proxies among 2 directory entries')
    expect(rowOf(rows, 'USDC').reasons).toEqual(['already enabled in the config (registered, or waiting in a monthly batch)', 'already registered on-chain'])
    for (const r of rows.filter(x => x.status !== 'candidate')) expect(r.reasons.length, `${r.symbol} has a reason`).toBeGreaterThan(0)
  })
  it('carries what the owner chooses by: token and feed from the sources, category, heartbeat, catalog volume, age', () => {
    const w = rowOf(rows, 'WBTC')
    expect(w).toMatchObject({ category: 'low', heartbeat: 1200, decimals: 8, tokenDecimals: 8, maxStaleness: 4800, description: 'WBTC / USD' })
    expect(w.token).toBe(tok(fixture(), 'WBTC').address)
    expect(w.feed).toBe(plain(fixture(), 'WBTC / USD').proxyAddress)
    expect(w.volume24hUsd).toBe(tok(fixture(), 'WBTC').volume24hUsd)
    expect(w.ageSec).toBeGreaterThanOrEqual(0)
  })
  it('never reads the chain for a row a static rule already excluded', () => {
    const sel = selectCandidates(fixture().input).selected
    for (const s of ['VVV', 'MAMO', 'SOL']) expect(sel.find(x => x.row.symbol === s)?.candidate, s).toBeNull()
    expect(sel.find(x => x.row.symbol === 'USDC')?.candidate, 'an enabled row still gets its on-chain read').not.toBeNull()
  })
  it('sorts candidates first, by catalog volume, then the rest: the same input prints the same table', () => {
    const sorted = sortRows([...rows].reverse())
    expect(sorted.map(r => r.status)).toEqual([...sorted.map(r => r.status)].sort((a, b) => ['candidate', 'excluded', 'needs-manual-match'].indexOf(a) - ['candidate', 'excluded', 'needs-manual-match'].indexOf(b)))
    const cands = sorted.filter(r => r.status === 'candidate').map(r => r.volume24hUsd ?? -1)
    expect(cands).toEqual([...cands].sort((a, b) => b - a))
    expect(sortRows(rows)).toEqual(sorted)
  })
  it('counts: skipped feeds with no catalog token are counted, never listed', () => {
    const c = fixture(x => x.input.directory.push({ name: 'NOPE / USD', path: 'nope-usd', ens: 'nope-usd', proxyAddress: tok(x, 'WBTC').address, heartbeat: 86400, decimals: 8, feedCategory: 'low', docs: { baseAsset: 'NOPE', quoteAsset: 'USD' } } as DirectoryEntry))
    const { selected, skipped } = selectCandidates(c.input)
    expect(skipped.noCatalogToken).toBe(1)
    expect(selected.some(s => s.row.symbol === 'NOPE')).toBe(false)
  })
})

describe('each exclusion reason', () => {
  it('directory category other than low or medium', () => {
    const c = fixture(x => { plain(x, 'WBTC / USD').feedCategory = 'custom' })
    expect(status(c, 'WBTC')).toBe('excluded')
    expect(why(c, 'WBTC')).toContain('category "custom" is not low or medium')
  })
  it('catalog token not verified', () => {
    const c = fixture(x => { tok(x, 'WBTC').verified = false })
    expect(why(c, 'WBTC')).toContain('catalog token is not verified')
  })
  it('catalog address that fails EIP-55 (all lowercase)', () => {
    const c = fixture(x => { const t = tok(x, 'RSR'); t.address = t.address.toLowerCase() })
    expect(status(c, 'RSR')).toBe('excluded')
    expect(why(c, 'RSR')).toContain('catalog address is not EIP-55')
    expect(rowOf(run(c), 'RSR').addToConfig).toBe(false)
  })
  it('directory proxy that fails EIP-55', () => {
    const c = fixture(x => { const e = plain(x, 'SNX / USD'); e.proxyAddress = (e.proxyAddress as string).toLowerCase() })
    expect(status(c, 'SNX')).toBe('excluded')
    expect(why(c, 'SNX')).toContain('directory proxy is not EIP-55')
    expect(rowOf(run(c), 'SNX').feed).toBeNull()
  })
  it('the native-asset placeholder of the catalog is never a token', () => {
    const c = fixture(x => { tok(x, 'WBTC').category = 'Native' })
    expect(why(c, 'WBTC')).toContain('native-asset placeholder')
  })
  it('only an SVR or secondary proxy exists (no plain one)', () => {
    expect(why(fixture(), 'SOL')).toContain('0 plain proxies')
  })
  it('two plain proxies for one name', () => {
    const c = fixture(x => { const e = plain(x, 'RSR / USD'); x.input.directory.push({ ...e, path: 'rsr-usd-2', ens: 'rsr-usd-2' }) })
    expect(why(c, 'RSR')).toContain('2 plain proxies among 2 directory entries')
  })
  it('hidden or shutting-down feed', () => {
    const c = fixture(x => { plain(x, 'GHO / USD').docs = { ...plain(x, 'GHO / USD').docs, shutdownDate: '2026-12-01' } })
    expect(why(c, 'GHO')).toContain('hidden or has a shutdown date')
  })
  it('heartbeat that is not a positive integer, and a missing decimals', () => {
    const c = fixture(x => { plain(x, 'SNX / USD').heartbeat = 0; delete plain(x, 'RSR / USD').decimals })
    expect(why(c, 'SNX')).toContain('heartbeat 0 is not a positive integer')
    expect(why(c, 'RSR')).toContain('directory entry has no decimals')
  })
  it('already registered on-chain (both RPCs say so)', () => {
    const c = fixture(x => registered(x, 'WBTC').forEach(r => Object.assign(r, { registered: true, feed: feedOf(x, 'WBTC') })))
    expect(status(c, 'WBTC')).toBe('excluded')
    expect(why(c, 'WBTC')).toBe('already registered on-chain')
    expect(rowOf(run(c), 'WBTC')).toMatchObject({ registered: true, addToConfig: false })
  })
  it('already enabled in the config, registered or not', () => {
    const c = fixture(x => { configRow(x, 'MOG').enabled = true })
    expect(why(c, 'MOG')).toBe('already enabled in the config (registered, or waiting in a monthly batch)')
  })
  it('a config row that disagrees with the directory or the catalog is a conflict, never a rewrite', () => {
    const feed = fixture(x => { configRow(x, 'MOG').feed = tok(x, 'WBTC').address })
    expect(status(feed, 'MOG')).toBe('excluded')
    expect(why(feed, 'MOG')).toContain("is not the directory's plain proxy")
    const hb = fixture(x => { plain(x, 'DEGEN / USD').heartbeat = 3600 })
    expect(why(hb, 'DEGEN')).toContain('config row heartbeat 86400 != directory 3600')
    const dec = fixture(x => { tok(x, 'MOG').decimals = 6 })
    expect(why(dec, 'MOG')).toContain('config row tokenDecimals 18 != catalog 6')
    const two = fixture(x => { x.input.config.chains[BASE].rows.push({ ...configRow(x, 'MOG'), symbol: 'MOG2', description: 'MOG2 / USD' }) })
    expect(why(two, 'MOG')).toContain('2 config rows match this token or description')
  })
  it('the live feed fails a check on both RPCs: stale, answer 0, wrong description, wrong feed decimals', () => {
    const stale = fixture(x => readings(x, 'WBTC').forEach(r => { r.updatedAt = x.live.now - 5000 }))
    expect(why(stale, 'WBTC')).toContain('age 5000s > 2x heartbeat 1200s')
    const day = fixture(x => readings(x, 'RSR').forEach(r => { r.updatedAt = x.live.now - 90000 }))
    expect(why(day, 'RSR')).toContain('executeTokenUsdFeed would revert')
    const zero = fixture(x => readings(x, 'SNX').forEach(r => { r.answer = '0' }))
    expect(why(zero, 'SNX')).toContain('answer 0 not > 0')
    const desc = fixture(x => readings(x, 'GHO').forEach(r => { r.description = 'GHO / EUR' }))
    expect(why(desc, 'GHO')).toContain('description "GHO / EUR" != "GHO / USD"')
    const dec = fixture(x => readings(x, 'WBTC').forEach(r => { r.decimals = 18 }))
    expect(why(dec, 'WBTC')).toContain('feed decimals 18 != 8')
  })
  it('the token decimals() on chain differ from the catalog', () => {
    const c = fixture(x => { x.live.tokenDecimals[tok(x, 'WBTC').address.toLowerCase()] = 6 })
    expect(why(c, 'WBTC')).toContain('token decimals() 6 != 8')
  })
  it('a stablecoin answering outside 0.98 to 1.02', () => {
    const c = fixture(x => { tok(x, 'GHO').category = 'Stablecoin'; readings(x, 'GHO').forEach(r => { r.answer = '130000000' }) })
    expect(why(c, 'GHO')).toContain('outside 0.98 to 1.02')
    const ok = fixture(x => { tok(x, 'GHO').category = 'Stablecoin'; readings(x, 'GHO').forEach(r => { r.answer = '100010000' }) })
    expect(status(ok, 'GHO')).toBe('candidate')
  })
})

describe('two RPCs that disagree, or fail, never make a candidate', () => {
  it('the RPCs answer different feed values', () => {
    const c = fixture(x => { readings(x, 'WBTC')[1].answer = '1' })
    expect(status(c, 'WBTC')).toBe('excluded')
    expect(why(c, 'WBTC')).toContain('RPCs disagree on the feed')
    expect(rowOf(run(c), 'WBTC').addToConfig).toBe(false)
  })
  it('the RPCs answer different rounds', () => {
    const c = fixture(x => { readings(x, 'RSR')[1].updatedAt = (readings(x, 'RSR')[0].updatedAt as number) - 60 })
    expect(why(c, 'RSR')).toContain('RPCs disagree on the feed')
  })
  it('one RPC fails, or only one RPC answered', () => {
    const fail = fixture(x => { readings(x, 'SNX')[1] = { error: 'HTTP 429' } })
    expect(why(fail, 'SNX')).toContain('RPC 2 read failed: HTTP 429')
    const one = fixture(x => { x.live.feeds[feedOf(x, 'GHO')] = [readings(x, 'GHO')[0]] as never })
    expect(why(one, 'GHO')).toContain('1 RPC reading(s) of the feed (need 2)')
  })
  it('the RPCs disagree on whether the token is registered, or the registration read fails', () => {
    const split = fixture(x => { registered(x, 'WBTC')[1] = { registered: true, feed: feedOf(x, 'WBTC') } })
    expect(why(split, 'WBTC')).toContain('RPCs disagree on tokenUsdFeeds')
    expect(rowOf(run(split), 'WBTC')).toMatchObject({ status: 'excluded', registered: null, addToConfig: false })
    const fail = fixture(x => { registered(x, 'RSR')[0] = { error: 'timeout' } })
    expect(why(fail, 'RSR')).toContain('RPC 1 tokenUsdFeeds read failed: timeout')
    const none = fixture(x => { delete x.live.registered[tok(x, 'SNX').address.toLowerCase()] })
    expect(why(none, 'SNX')).toContain('0 RPC reading(s) of tokenUsdFeeds')
  })
  it('registrationOf: agreement is required, a failure never reads as "not registered"', () => {
    const r = { registered: false, feed: '0x0000000000000000000000000000000000000000' }
    expect(registrationOf([r, r])).toEqual({ registered: false, reasons: [] })
    expect(registrationOf([{ ...r, registered: true }, { ...r, registered: true }]).registered).toBe(true)
    expect(registrationOf([r, { error: 'x' }]).registered).toBeNull()
    expect(registrationOf(undefined).registered).toBeNull()
  })
})

describe('needs manual match: no token address in the directory, so no guess', () => {
  it('a directory row with no baseAsset (no token at all) is "needs manual match" and never a candidate', () => {
    const c = fixture(x => {
      x.input.directory.push({ name: 'RSR2 / USD', path: 'rsr2-usd', ens: 'rsr2-usd', proxyAddress: plain(x, 'RSR / USD').proxyAddress, heartbeat: 86400, decimals: 8, feedCategory: 'low', docs: { quoteAsset: 'USD' } } as DirectoryEntry)
      x.input.catalog.push({ ...tok(x, 'RSR'), address: tok(x, 'WBTC').address, symbol: 'RSR2' })
    })
    const r = rowOf(run(c), 'RSR2')
    expect(r.status).toBe('needs-manual-match')
    expect(r.reasons.join()).toContain('no baseAsset')
    expect(r).toMatchObject({ addToConfig: false, token: null })
  })
  it('two catalog tokens carry the symbol: ambiguous, so manual', () => {
    const c = fixture(x => { x.input.catalog.push({ ...tok(x, 'WBTC'), address: tok(x, 'RSR').address }) })
    const r = rowOf(run(c), 'WBTC')
    expect(r.status).toBe('needs-manual-match')
    expect(r.reasons.join()).toContain('2 catalog tokens carry the symbol "WBTC" (need exactly 1)')
    expect(r.addToConfig).toBe(false)
  })
  it('the catalog spells the symbol in another case: a hint, not a match', () => {
    const c = fixture(x => { tok(x, 'RSR').symbol = 'rsr' })
    const r = rowOf(run(c), 'RSR')
    expect(r.status).toBe('needs-manual-match')
    expect(r.reasons.join()).toContain('same letters in another case: rsr')
  })
  it('the directory baseAsset is not the name symbol', () => {
    const c = fixture(x => { plain(x, 'SNX / USD').docs = { baseAsset: 'KNC', quoteAsset: 'USD' } })
    expect(status(c, 'SNX')).toBe('needs-manual-match')
  })
  it('a symbol that could carry markup is skipped, counted, and never reaches a table', () => {
    const c = fixture(x => {
      x.input.directory.push({ name: '[x](http://e.vil) / USD', path: 'x', ens: 'x', proxyAddress: tok(x, 'WBTC').address, heartbeat: 1, decimals: 8, feedCategory: 'low', docs: { baseAsset: '[x](http://e.vil)', quoteAsset: 'USD' } } as DirectoryEntry)
      x.input.catalog.push({ ...tok(x, 'WBTC'), symbol: '[x](http://e.vil)' })
    })
    const { selected, skipped } = selectCandidates(c.input)
    expect(skipped.unsafeSymbol).toBe(1)
    expect(selected.some(s => s.row.symbol.includes('e.vil'))).toBe(false)
  })
})

describe('addCandidates: new rows only, existing rows never touched', () => {
  const before = fixture().input.config
  const rows = run()
  const { next, added } = addCandidates(before, 8453, rows, '2026-11-14')
  it('adds exactly the four new candidates as disabled phase-2 rows with no batch', () => {
    expect(added.sort()).toEqual(NEW_ROWS)
    const created = next.chains[BASE].rows.slice(before.chains[BASE].rows.length)
    expect(created.map(r => r.symbol).sort()).toEqual(NEW_ROWS)
    for (const r of created) {
      expect(r).toMatchObject({ phase: 2, enabled: false, action: 'none', source: 'chainlink-directory 2026-11-14' })
      expect(Object.keys(r)).toEqual(['symbol', 'token', 'feed', 'description', 'decimals', 'tokenDecimals', 'heartbeat', 'maxStaleness', 'tier', 'phase', 'enabled', 'action', 'source'])
      expect(r.batch).toBeUndefined()
    }
    const wbtc = created.find(r => r.symbol === 'WBTC') as RegistrationRow
    expect(wbtc).toMatchObject({ token: tok(fixture(), 'WBTC').address, feed: plain(fixture(), 'WBTC / USD').proxyAddress, heartbeat: 1200, maxStaleness: 4800, tier: 'low' })
  })
  it('leaves every existing row, the top-level fields and the other chains byte-identical', () => {
    expect(next.chains[BASE].rows.slice(0, before.chains[BASE].rows.length)).toEqual(before.chains[BASE].rows)
    expect(JSON.stringify(next.chains[BASE].rows.slice(0, 3))).toBe(JSON.stringify(before.chains[BASE].rows))
    expect(next.schema).toBe(before.schema)
    expect(next.source).toBe(before.source)
    expect(Object.keys(next.chains)).toEqual(Object.keys(before.chains))
    expect(before.chains[BASE].rows).toHaveLength(3) // the input was not mutated
  })
  it('an existing disabled row (MOG, DEGEN) is never modified, even when the directory has moved', () => {
    const c = fixture(x => { plain(x, 'MOG / USD').heartbeat = 3600 })
    const r = addCandidates(c.input.config, 8453, run(c), '2026-11-14')
    expect(r.next.chains[BASE].rows.find(x => x.symbol === 'MOG')).toEqual(configRow(fixture(), 'MOG'))
    expect(rowOf(run(c), 'MOG').status).toBe('excluded')
  })
  it('is idempotent: a second run on the result adds nothing and reproduces the file byte for byte', () => {
    const again = fixture(x => { x.input.config = next })
    const rows2 = run(again)
    for (const s of NEW_ROWS) expect(rowOf(rows2, s)).toMatchObject({ status: 'candidate', inConfig: true, enabled: false, addToConfig: false })
    const r2 = addCandidates(next, 8453, rows2, '2026-11-21')
    expect(r2.added).toEqual([])
    expect(serializeConfig(r2.next)).toBe(serializeConfig(next))
  })
  it('refuses a duplicate symbol, token or feed, an incomplete candidate and a bad date', () => {
    const dup = { ...rowOf(rows, 'WBTC'), symbol: 'MOG' }
    expect(() => addCandidates(before, 8453, [dup], '2026-11-14')).toThrow(/already carries/)
    const half = { ...rowOf(rows, 'WBTC'), feed: null }
    expect(() => addCandidates(before, 8453, [half], '2026-11-14')).toThrow()
    expect(() => addCandidates(before, 8453, rows, '14-11-2026')).toThrow(/YYYY-MM-DD/)
    expect(() => addCandidates(before, 1, rows, '2026-11-14')).toThrow(/no rows/)
  })
  it('only a candidate is ever written: an excluded or manual row with addToConfig set by mistake is refused', () => {
    const bad = { ...rowOf(rows, 'VVV'), addToConfig: true }
    expect(() => addCandidates(before, 8453, [bad], '2026-11-14')).toThrow(/not a complete candidate/)
  })
  it('summarize counts what the PR says', () => {
    expect(summarize(rows)).toEqual({ candidates: 6, newConfigRows: 4, excluded: rows.filter(r => r.status === 'excluded').length, needsManualMatch: 0 })
  })
})

describe('output: the table and the PR body carry no markup from outside', () => {
  const report = (rows: CandidateRow[]): Report => ({
    chain: 'Base', chainId: 8453, directoryUrl: 'https://example.invalid', directoryEntries: 14, rpcs: 2, date: '2026-11-14',
    summary: summarize(rows), skipped: { noCatalogToken: 3, unsafeSymbol: 0 }, rows,
  })
  it('cell() strips pipes, backticks, mentions, links and newlines, and bounds the length', () => {
    const s = cell('a|b `c` @team [l](http://x)\n<img src=x> ![i](u) *b* ' + 'z'.repeat(400))
    for (const bad of ['|', '`', '@', '[', ']', '<', '>', '\n', '!', '*']) expect(s).not.toContain(bad)
    expect(s.length).toBeLessThanOrEqual(160)
    expect(cell(undefined)).toBe('-')
  })
  it('an RPC error string with markup is neutralised in the markdown body', () => {
    const c = fixture(x => { readings(x, 'SNX')[1] = { error: 'bad | row\n@maintainers [click](http://evil.example) `x`' } })
    const md = markdownTable(report(sortRows(run(c))))
    expect(md).not.toContain('@maintainers')
    expect(md).not.toContain('](http')
    expect(md).toContain('RPC 2 read failed')
    // every table line has the same number of cells: a pipe in a value cannot add a column
    const lines = md.split('\n').filter(l => l.startsWith('|'))
    expect(new Set(lines.map(l => l.split('|').length)).size).toBe(1)
  })
  it('the body states what it is, lists the candidates, and is cut under the size bound', () => {
    const rows = sortRows(run())
    const md = markdownTable(report(rows))
    expect(md).toContain('Nothing here enables a row')
    expect(md).toContain('| WBTC |')
    expect(md).toContain('CANDIDATE (new row)')
    const small = markdownTable(report(rows), 1200)
    expect(small.length).toBeLessThan(1500)
    expect(small).toContain('further row(s)')
  })
  it('the text table names every row and every reason', () => {
    const rows = sortRows(run())
    const t = textTable(report(rows))
    for (const r of rows) expect(t).toContain(r.symbol)
    expect(t).toContain('why not:')
  })
})

describe('the sources stay single and read-only', () => {
  const src = (f: string) => read(f)
  it('the directory host lives in directory.ts only; nothing from argv reaches the URL', () => {
    expect(directoryUrl(8453)).toBe(`https://${DIRECTORY_HOST}/feeds-ethereum-mainnet-base-1.json`)
    expect(directoryUrl(42161)).toBe(`https://${DIRECTORY_HOST}/feeds-ethereum-mainnet-arbitrum-1.json`)
    expect(directoryUrl(1)).toBeNull()
    for (const f of ['./batch.ts', './candidates.ts', './candidates-lib.ts']) expect(src(f), f).not.toContain(DIRECTORY_HOST)
  })
  it('no signing, key or transaction vocabulary in the candidate scripts', () => {
    for (const f of ['./candidates.ts', './candidates-lib.ts', './directory.ts']) {
      expect(src(f), f).not.toMatch(/sendTransaction|writeContract|signMessage|signTypedData|privateKey|private key|mnemonic|PRIVATE_KEY|process\.env/i)
    }
  })
})
