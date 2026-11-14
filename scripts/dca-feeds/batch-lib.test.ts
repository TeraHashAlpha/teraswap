/**
 * [feat/dca-feed-batch] The monthly batch rules, on RECORDED fixtures: no network, no clock.
 *
 * __fixtures__/batch-2026-11/ was recorded 2026-11-13 from the sources batch.ts reads:
 *   config.before.json   src/config/dca-feed-registrations.json at origin/main, before batch 1
 *   directory.base.json  26 entries of Chainlink's Base directory (only the fields batch-lib reads)
 *   catalog.base.json    13 tokens of src/config/generated/token-catalog.8453.json
 *   live.base.json       description() / decimals() / latestRoundData() of the eight feeds on two RPCs + token decimals()
 * Every address in a test comes from a fixture; a refusal is provoked by mutating a copy of one.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  applyBatch, selectBatch, isPlainProxy, serializeConfig, MAX_STALENESS_RULE,
  type ApplyInput, type RegistrationConfig, type RegistrationRow, type DirectoryEntry, type CatalogToken,
  type LiveReadings, type FeedReading,
} from './batch-lib'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const fx = <T>(name: string): T => JSON.parse(read(`./__fixtures__/batch-2026-11/${name}`)) as T
const BEFORE_TEXT = read('./__fixtures__/batch-2026-11/config.before.json')
const BATCH_1 = ['MORPHO', 'AAVE', 'LINK', 'USDS', 'AERO', 'cbETH', 'ZRO', 'YFI']
const CREATED = ['AAVE', 'LINK', 'USDS']
const BASE = '8453'

function input(mutate?: (i: ApplyInput) => void, symbols: string[] = BATCH_1): ApplyInput {
  const i: ApplyInput = {
    config: JSON.parse(BEFORE_TEXT) as RegistrationConfig, chainId: 8453, symbols, batch: '2026-11', date: '2026-11-13',
    directory: fx<DirectoryEntry[]>('directory.base.json'), catalog: fx<CatalogToken[]>('catalog.base.json'),
    live: fx<LiveReadings>('live.base.json'),
  }
  mutate?.(i)
  return i
}
const baseRows = (c: RegistrationConfig) => c.chains[BASE].rows
const rowOf = (c: RegistrationConfig, symbol: string) => baseRows(c).find(r => r.symbol === symbol) as RegistrationRow
const entry = (i: ApplyInput, path: string) => i.directory.find(e => e.path === path) as DirectoryEntry
const token = (i: ApplyInput, symbol: string) => i.catalog.find(t => t.symbol === symbol) as CatalogToken
/** Both RPC readings of a symbol's feed, mutable. */
function readings(i: ApplyInput, symbol: string): FeedReading[] {
  const c = selectBatch(i).find(s => s.symbol === symbol)?.candidate
  if (!c) throw new Error(`${symbol} is not selectable in this fixture`)
  return i.live.feeds[c.feed.toLowerCase()] as FeedReading[]
}
const setBoth = (i: ApplyInput, symbol: string, patch: Partial<FeedReading>) => readings(i, symbol).forEach(r => Object.assign(r, patch))
/** The reasons a symbol was refused with ('' when it was not). */
function refusal(i: ApplyInput, symbol: string): string {
  const { next, report } = applyBatch(i)
  const r = report.find(x => x.symbol === symbol)
  if (r?.status === 'refused') expect(next, 'a refusal must produce no config').toBeNull()
  return r?.status === 'refused' ? r.reasons.join(' | ') : ''
}

describe('applyBatch: batch 2026-11 on the recorded Base fixtures', () => {
  const before = JSON.parse(BEFORE_TEXT) as RegistrationConfig
  const { next, report } = applyBatch(input())
  const after = next as RegistrationConfig

  it('switches on exactly the eight named rows: five existing, three created', () => {
    expect(next).not.toBeNull()
    expect(report.map(r => `${r.symbol}:${r.status}`)).toEqual([
      'MORPHO:enable', 'AAVE:create', 'LINK:create', 'USDS:create', 'AERO:enable', 'cbETH:enable', 'ZRO:enable', 'YFI:enable'])
    expect(baseRows(after).filter(r => r.batch === '2026-11').map(r => r.symbol).sort()).toEqual([...BATCH_1].sort())
    for (const s of BATCH_1) {
      expect(rowOf(after, s), s).toMatchObject({ enabled: true, action: 'register', phase: 2, batch: '2026-11' })
    }
    expect(baseRows(after)).toHaveLength(baseRows(before).length + CREATED.length)
  })

  it('leaves every other row byte-identical: phase-0, phase-1, the other phase-2 rows, and all of Arbitrum', () => {
    const untouched = baseRows(before).filter(r => !BATCH_1.includes(r.symbol))
    expect(untouched.filter(r => r.phase === 1).map(r => r.symbol)).toEqual(['USDC', 'COMP', 'EURC', 'USDT', 'VIRTUAL', 'cbBTC'])
    for (const r of untouched) expect(JSON.stringify(rowOf(after, r.symbol)), r.symbol).toBe(JSON.stringify(r))
    expect(JSON.stringify(after.chains['42161'])).toBe(JSON.stringify(before.chains['42161']))
    expect({ schema: after.schema, source: after.source }).toEqual({ schema: before.schema, source: before.source })
    // Row order: existing rows keep their place, created rows are appended.
    expect(baseRows(after).slice(0, baseRows(before).length).map(r => r.symbol)).toEqual(baseRows(before).map(r => r.symbol))
    expect(baseRows(after).slice(-CREATED.length).map(r => r.symbol)).toEqual(CREATED)
  })

  it('an existing row changes only in enabled, action, batch (and tier / maxStaleness when the directory says so)', () => {
    for (const s of BATCH_1.filter(x => !CREATED.includes(x))) {
      const { enabled: _e, action: _a, batch: _b, ...rest } = rowOf(after, s)
      const { enabled: was, action: _a0, ...restBefore } = rowOf(before, s)
      expect(was, s).toBe(false)
      expect(rest, s).toEqual(restBefore) // tier and maxStaleness were already what the directory and the rule give
    }
  })

  it('a created row: token from OUR catalog, feed from the directory plain proxy, same key order as a built row', () => {
    const i = input()
    for (const s of CREATED) {
      const row = rowOf(after, s)
      const plain = entry(i, `${s.toLowerCase()}-usd`)
      expect(row.token).toBe(token(i, s).address)
      expect(row.feed).toBe(plain.proxyAddress)
      expect(row).toMatchObject({ description: `${s} / USD`, decimals: 8, tokenDecimals: 18, heartbeat: 86400, tier: plain.feedCategory, source: 'chainlink-directory 2026-11-13' })
      expect(Object.keys(row)).toEqual([...Object.keys(rowOf(before, 'COMP')), 'batch'])
    }
    expect(CREATED.map(s => rowOf(after, s).tier)).toEqual(['low', 'low', 'medium'])
  })

  it('AAVE has two proxies in the directory: the PLAIN one is taken, never the SVR one or its secondary', () => {
    const i = input()
    const svr = entry(i, 'aave-usd-svr'), plain = entry(i, 'aave-usd')
    expect(svr.name).toBe('AAVE / USD')
    expect(svr.secondaryProxyAddress).toBeTruthy()
    expect([isPlainProxy(plain), isPlainProxy(svr)]).toEqual([true, false])
    const feed = rowOf(after, 'AAVE').feed
    expect(feed).toBe(plain.proxyAddress)
    expect([svr.proxyAddress, svr.secondaryProxyAddress]).not.toContain(feed)
  })

  it('maxStaleness follows the chain rule: Base heartbeat + 3600, Arbitrum 2 x (heartbeat + 13) + 60', () => {
    for (const s of BATCH_1) expect(rowOf(after, s).maxStaleness, s).toBe(rowOf(after, s).heartbeat + 3600)
    expect(rowOf(after, 'cbETH').maxStaleness).toBe(4800)
    expect(rowOf(after, 'AAVE').maxStaleness).toBe(90000)
    expect(MAX_STALENESS_RULE[42161](86400)).toBe(172886)
    expect(Object.keys(MAX_STALENESS_RULE)).toEqual(['8453', '42161'])
  })

  it('tier is the directory category of the day, not the tier the row was built with', () => {
    const r = applyBatch(input(i => { entry(i, 'morpho-usd').feedCategory = 'low' }))
    expect(rowOf(r.next as RegistrationConfig, 'MORPHO').tier).toBe('low')
    expect(rowOf(before, 'MORPHO').tier).toBe('medium')
  })

  it('the COMMITTED config carries exactly these eight rows for batch 2026-11, equal to the replay', () => {
    const committed = JSON.parse(read('../../src/config/dca-feed-registrations.json')) as RegistrationConfig
    const rows = baseRows(committed).filter(r => r.batch === '2026-11')
    expect(rows.map(r => r.symbol).sort()).toEqual([...BATCH_1].sort())
    for (const r of rows) expect(r, r.symbol).toEqual(rowOf(after, r.symbol))
    expect(serializeConfig(committed)).toBe(read('../../src/config/dca-feed-registrations.json'))
  })

  it('is idempotent: a second run refuses all eight as already enabled and changes nothing', () => {
    const first = serializeConfig(after)
    const again = applyBatch(input(i => { i.config = JSON.parse(first) as RegistrationConfig }))
    expect(again.next).toBeNull()
    expect(again.report.map(r => [r.status, r.reasons.join()])).toEqual(BATCH_1.map(() => ['refused', 'already enabled']))
    const i = input()
    const snapshot = serializeConfig(i.config)
    applyBatch(i)
    expect(serializeConfig(i.config), 'the input config is never mutated').toBe(snapshot)
    expect(snapshot).toBe(BEFORE_TEXT)
  })
})

describe('applyBatch: refusals (each one produces NO config)', () => {
  it('ALL OR NOTHING: one refused symbol stops the whole batch, the others are still reported', () => {
    const { next, report } = applyBatch(input(undefined, [...BATCH_1, 'wstETH']))
    expect(next).toBeNull()
    expect(report.filter(r => r.status !== 'refused').map(r => r.symbol)).toEqual(BATCH_1)
  })

  it('wstETH: Base has only WSTETH / ETH and exchange-rate feeds, no USD feed, so it cannot be built', () => {
    const i = input(undefined, ['wstETH'])
    expect(token(i, 'wstETH').verified).toBe(true)
    expect(i.directory.filter(e => /wsteth/i.test(e.name ?? '')).map(e => e.name).sort()).toEqual([
      'WSTETH / ETH', 'WSTETH / STETH Exchange Rate', 'inwstETH / wstETH Exchange Rate', 'tETH / wstETH Exchange Rate',
      'wstETH-ETH Exchange Rate', 'wstETH-stETH Exchange Rate'])
    expect(i.directory.some(e => /wsteth/i.test(e.docs?.baseAsset ?? '') && e.docs?.quoteAsset === 'USD')).toBe(false)
    expect(refusal(i, 'wstETH')).toBe('the directory has no "wstETH / USD" feed on this chain')
  })

  it('a symbol that is already enabled (phase 1, phase 0 or an earlier batch)', () => {
    for (const s of ['COMP', 'USDC', 'WETH']) expect(refusal(input(undefined, [s]), s), s).toBe('already enabled')
  })

  it.each(['high', 'custom', 'new', 'deprecating', ''])('directory category "%s" is not low or medium', (category) => {
    expect(refusal(input(i => { entry(i, 'zro-usd').feedCategory = category }), 'ZRO')).toBe(`directory category "${category}" is not low or medium`)
    expect(refusal(input(i => { entry(i, 'link-usd').feedCategory = category }), 'LINK')).toBe(`directory category "${category}" is not low or medium`)
  })

  it('SVR: a pair whose only proxies are SVR / shared-SVR has no plain proxy to take', () => {
    const onlySvr = (i: ApplyInput) => { i.directory = i.directory.filter(e => e.path !== 'aave-usd') }
    expect(refusal(input(onlySvr), 'AAVE')).toContain('"AAVE / USD": 0 plain proxies among 1 directory entries')
    // Real data: every "ETH / USD" entry of the Base directory is an SVR one.
    const eth = input().directory.filter(e => e.name === 'ETH / USD')
    expect(eth.length).toBeGreaterThan(0)
    expect(eth.some(isPlainProxy)).toBe(false)
  })

  it('SVR: an existing row that points at the SVR proxy is refused, not switched on', () => {
    const i = input(x => { rowOf(x.config, 'AERO').feed = entry(x, 'aave-usd-svr').proxyAddress as string })
    expect(refusal(i, 'AERO')).toContain("is not the directory's plain proxy")
  })

  it('SVR: the classifier on the recorded USDC siblings and the hidden test feed', () => {
    const i = input()
    expect(['usdc-usd', 'usdc-usd-svr', 'usdc-usd-shared-svr', 'usdc-usd-capped-test'].map(p => isPlainProxy(entry(i, p)))).toEqual([true, false, false, false])
    expect(isPlainProxy({ ...entry(i, 'usdc-usd'), secondaryProxyAddress: entry(i, 'usdc-usd-svr').secondaryProxyAddress })).toBe(false)
    expect(isPlainProxy({ ...entry(i, 'usdc-usd'), docs: { ...entry(i, 'usdc-usd').docs, shutdownDate: '2026-12-01' } })).toBe(false)
  })

  it('two plain proxies for one pair is ambiguous', () => {
    const i = input(x => { x.directory = [...x.directory, { ...entry(x, 'link-usd'), proxyAddress: entry(x, 'comp-usd').proxyAddress }] })
    expect(refusal(i, 'LINK')).toContain('2 plain proxies among 2')
  })

  it('the join to OUR catalog: missing, ambiguous, unverified, or not EIP-55', () => {
    expect(refusal(input(i => { i.catalog = i.catalog.filter(t => t.symbol !== 'LINK') }), 'LINK')).toBe('0 catalog tokens match (need exactly 1)')
    expect(refusal(input(i => { i.catalog = [...i.catalog, { ...token(i, 'COMP'), symbol: 'LINK' }] }), 'LINK')).toBe('2 catalog tokens match (need exactly 1)')
    expect(refusal(input(i => { token(i, 'USDS').verified = false }), 'USDS')).toBe('catalog token is not verified')
    expect(refusal(input(i => { token(i, 'AAVE').address = token(i, 'AAVE').address.toLowerCase() }), 'AAVE')).toContain('catalog address is not EIP-55')
    // An existing row joins by token ADDRESS, so a catalog without that address refuses it.
    expect(refusal(input(i => { i.catalog = i.catalog.filter(t => t.symbol !== 'YFI') }), 'YFI')).toBe('0 catalog tokens match (need exactly 1)')
    expect(refusal(input(i => { entry(i, 'usds-usd').proxyAddress = (entry(i, 'usds-usd').proxyAddress as string).toLowerCase() }), 'USDS')).toContain('directory proxy is not EIP-55')
  })

  it('an existing row that no longer matches the directory or the catalog', () => {
    expect(refusal(input(i => { entry(i, 'yfi-usd').heartbeat = 3600 }), 'YFI')).toBe('row heartbeat 86400 != directory 3600')
    expect(refusal(input(i => { entry(i, 'yfi-usd').decimals = 18 }), 'YFI')).toBe('row feed decimals 8 != directory 18')
    expect(refusal(input(i => { token(i, 'YFI').decimals = 6 }), 'YFI')).toBe('row tokenDecimals 18 != catalog 6')
    expect(refusal(input(i => { entry(i, 'link-usd').heartbeat = 0 }), 'LINK')).toContain('is not a positive integer')
  })

  it('live: description() must be exactly "SYMBOL / USD" and decimals() the directory value', () => {
    expect(refusal(input(i => setBoth(i, 'LINK', { description: 'LINK / ETH' })), 'LINK')).toBe('description "LINK / ETH" != "LINK / USD"')
    expect(refusal(input(i => setBoth(i, 'cbETH', { description: 'cbETH / USD' })), 'cbETH')).toBe('description "cbETH / USD" != "CBETH / USD"')
    expect(refusal(input(i => setBoth(i, 'AAVE', { decimals: 18 })), 'AAVE')).toContain('feed decimals 18 != 8')
  })

  it('live: answer must be > 0', () => {
    for (const answer of ['0', '-1']) expect(refusal(input(i => setBoth(i, 'ZRO', { answer })), 'ZRO')).toBe(`answer ${answer} not > 0`)
  })

  it('live: age <= 2 x heartbeat and < 86400 s', () => {
    const aged = (symbol: string, age: number) => input(i => setBoth(i, symbol, { updatedAt: i.live.now - age }))
    expect(refusal(aged('cbETH', 2400), 'cbETH')).toBe('') // heartbeat 1200: exactly 2x passes
    expect(refusal(aged('cbETH', 2401), 'cbETH')).toBe('age 2401s > 2x heartbeat 1200s')
    expect(refusal(aged('MORPHO', 86399), 'MORPHO')).toBe('') // heartbeat 86400: the 24 h execute limit binds first
    expect(refusal(aged('MORPHO', 86400), 'MORPHO')).toBe('age 86400s >= 86400s: executeTokenUsdFeed would revert')
  })

  it('live: two RPCs must both answer and agree', () => {
    expect(refusal(input(i => { readings(i, 'AERO')[1].answer = '1' }), 'AERO')).toContain('RPCs disagree on the feed')
    expect(refusal(input(i => { readings(i, 'AERO')[1].updatedAt -= 1 }), 'AERO')).toContain('RPCs disagree on the feed')
    expect(refusal(input(i => { readings(i, 'AERO').pop() }), 'AERO')).toBe('1 RPC reading(s) of the feed (need 2)')
    expect(refusal(input(i => { (readings(i, 'AERO') as unknown[])[1] = { error: 'timeout' } }), 'AERO')).toBe('RPC 2 read failed: timeout')
    expect(refusal(input(i => { (readings(i, 'AERO') as unknown[]).splice(0, 2, { error: 'no contract code at feed' }, { error: 'no contract code at feed' }) }), 'AERO')).toContain('RPC 1 read failed: no contract code at feed')
  })

  it('live: the token decimals() must equal the row', () => {
    const key = (i: ApplyInput, s: string) => (s === 'ZRO' ? rowOf(i.config, s).token : token(i, s).address).toLowerCase()
    expect(refusal(input(i => { i.live.tokenDecimals[key(i, 'ZRO')] = 6 }), 'ZRO')).toBe('token decimals() 6 != 18')
    expect(refusal(input(i => { i.live.tokenDecimals[key(i, 'LINK')] = { error: 'execution reverted' } }), 'LINK')).toBe('token decimals() read failed: execution reverted')
    expect(refusal(input(i => { delete i.live.tokenDecimals[key(i, 'LINK')] }), 'LINK')).toBe('token decimals() was not read')
  })

  it('a stablecoin whose feed answers outside 0.98 to 1.02 (the band is inclusive and applies to stables only)', () => {
    const at = (symbol: string, answer: string) => refusal(input(i => setBoth(i, symbol, { answer })), symbol)
    expect(token(input(), 'USDS').category).toBe('Stablecoin')
    expect(at('USDS', '97999999')).toContain('is outside 0.98 to 1.02')
    expect(at('USDS', '102000001')).toContain('is outside 0.98 to 1.02')
    expect(at('USDS', '98000000')).toBe('')
    expect(at('USDS', '102000000')).toBe('')
    expect(at('ZRO', '50000000')).toBe('') // not a stablecoin: 0.50 is a price, not a depeg
  })

  it('the request itself: duplicate symbol, bad batch label, bad date, empty list, a chain with no rule', () => {
    expect(refusal(input(undefined, ['ZRO', 'ZRO']), 'ZRO')).toBe('symbol named more than once')
    expect(refusal(input(i => { i.batch = '2026-13' }), 'ZRO')).toContain('batch "2026-13" is not YYYY-MM')
    expect(refusal(input(i => { i.batch = 'november' }), 'ZRO')).toContain('is not YYYY-MM')
    expect(refusal(input(i => { i.date = '13/11/2026' }), 'ZRO')).toContain('is not YYYY-MM-DD')
    expect(applyBatch(input(undefined, []))).toEqual({ next: null, report: [{ symbol: '(batch)', status: 'refused', reasons: ['no symbols named'] }] })
    expect(refusal(input(i => { i.chainId = 1 }), 'ZRO')).toBe('no maxStaleness rule for chain 1')
  })
})
