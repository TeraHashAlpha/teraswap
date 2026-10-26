/**
 * [feat/catalog-single-source-volume] The single-source volume rule, table-driven, against a
 * RECORDED CoinGecko market_chart payload (fixtures/market_chart/ether-fi-7d-daily.recorded-2026-10-26.json,
 * `…/coins/ether-fi/market_chart?vs_currency=usd&days=7&interval=daily`, fetched live 2026-10-26 16:01 UTC).
 * Variants (6/7, boundary, short history) are derived from that recording by overwriting values — the
 * payload SHAPE is always the real one. Zero network: fetch and sleep are injected; no real waiting.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getAddress } from 'viem'
import type { Allowlist, Verdict } from '@/lib/chains/catalog-guard'
import type { Candidate, SingleSourceConfig, SourceEntry, SourceFetchResult } from './types'
import { PIPELINE_CONFIG } from './config'
import { buildChainCatalog } from './build-chain'
import { parseMarketChartDailyVolumes } from './sources'
import {
  CG_HISTORY_BACKOFF_BASE_MS,
  CG_HISTORY_MAX_RETRIES,
  CG_HISTORY_MIN_INTERVAL_MS,
  makeCoingeckoHistoryClient,
  makeCoingeckoJsonClient,
  makeVolumeFetcher,
  makeVolumeHistoryFetcher,
} from './fetch-sources'
import { crossVerify, evaluateSingleSource, isSingleSourceCoingecko, resolveSingleSourceConfig, type SingleSourceVerdict } from './verify'

const RECORDED = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'market_chart', 'ether-fi-7d-daily.recorded-2026-10-26.json'), 'utf8'),
) as { prices: unknown[]; market_caps: unknown[]; total_volumes: Array<[number, number]> }

/** A market_chart payload whose 7 complete-day values are `days` (oldest→newest) + the real trailing "now" point. */
function payload(days: number[]): unknown {
  const midnights = RECORDED.total_volumes.filter(([ts]) => ts % 86_400_000 === 0)
  const trailing = RECORDED.total_volumes.find(([ts]) => ts % 86_400_000 !== 0)!
  const base = midnights.at(-1)![0]
  const pts = days.map((v, i): [number, number] => [base - (days.length - 1 - i) * 86_400_000, v])
  return { ...RECORDED, total_volumes: [...pts, trailing] }
}
const FLOOR = 100_000
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

describe('recording sanity + parser', () => {
  it('the recording is 7 UTC-midnight points + 1 trailing in-progress point; parser keeps only the 7 complete days', () => {
    expect(RECORDED.total_volumes).toHaveLength(8)
    const v = parseMarketChartDailyVolumes(RECORDED)!
    expect(v).toHaveLength(7)
    expect(v[0]).toBeCloseTo(39_327_713.85, 1)
    expect(v.at(-1)).toBeCloseTo(22_281_492.57, 1)
  })
  it('alien / malformed payloads parse to null (a failed fetch, never an empty pass)', () => {
    for (const raw of [null, {}, { total_volumes: 'x' }, { total_volumes: [[1, 'a']] }, { total_volumes: [[0, Number.NaN]] }]) {
      expect(parseMarketChartDailyVolumes(raw)).toBeNull()
    }
  })
})

describe('evaluateSingleSource — table', () => {
  const cfg: SingleSourceConfig = { enabled: true, minDailyVolumeUsd: FLOOR, days: 7, requireEveryDay: true }
  const hist = (daily: number[]) => ({ ok: true as const, dailyVolumeUsd: parseMarketChartDailyVolumes(payload(daily))! })
  const rows: Array<[string, Parameters<typeof evaluateSingleSource>[0], SingleSourceConfig, SingleSourceVerdict['status']]> = [
    ['recorded ETHFI 7/7 days ≥ $100k', { ok: true, dailyVolumeUsd: parseMarketChartDailyVolumes(RECORDED)! }, cfg, 'admitted'],
    ['7/7 exactly at the floor ($100,000 passes — ≥)', hist(Array(7).fill(FLOOR)), cfg, 'admitted'],
    ['6/7: one day $99,999', hist([5e6, 5e6, 99_999, 5e6, 5e6, 5e6, 5e6]), cfg, 'below-floor'],
    ['6/7: the NEWEST day is the one that dips', hist([5e6, 5e6, 5e6, 5e6, 5e6, 5e6, 10]), cfg, 'below-floor'],
    ['one huge day cannot carry the rest (min, not mean/median)', hist([9e9, 1, 1, 1, 1, 1, 1]), cfg, 'below-floor'],
    ['short history: 5 complete days', { ok: true, dailyVolumeUsd: [5e6, 5e6, 5e6, 5e6, 5e6] }, cfg, 'below-floor'],
    ['fetch error', { ok: false, error: 'ether-fi: HTTP 429 (gave up after 5 attempts)' }, cfg, 'fetch-failed'],
    ['malformed (NaN) value', { ok: true, dailyVolumeUsd: [5e6, Number.NaN, 5e6, 5e6, 5e6, 5e6, 5e6] }, cfg, 'fetch-failed'],
    ['negative value', { ok: true, dailyVolumeUsd: [5e6, -1, 5e6, 5e6, 5e6, 5e6, 5e6] }, cfg, 'fetch-failed'],
    ['requireEveryDay=false: median clears even with a dip', hist([5e6, 5e6, 10, 5e6, 5e6, 5e6, 5e6]), { ...cfg, requireEveryDay: false }, 'admitted'],
    ['raised threshold ($1M) rejects what $100k admits', hist(Array(7).fill(500_000)), { ...cfg, minDailyVolumeUsd: 1_000_000 }, 'below-floor'],
    ['lowered threshold ($50k) admits what $100k rejects', hist(Array(7).fill(60_000)), { ...cfg, minDailyVolumeUsd: 50_000 }, 'admitted'],
    ['days=3 only looks at the newest 3 values', hist([1, 1, 1, 1, 5e6, 5e6, 5e6]), { ...cfg, days: 3 }, 'admitted'],
  ]
  it.each(rows)('%s → %s', (_name, history, c, expected) => {
    const v = evaluateSingleSource(history, c)
    expect(v.status).toBe(expected)
    if (v.status === 'admitted') {
      expect(v.admission).toMatchObject({ rule: 'single-source-volume', minDailyVolumeUsd: c.minDailyVolumeUsd, days: c.days })
      expect(v.admission.dailyVolumeUsd).toHaveLength(c.days)
    }
  })
})

describe('config', () => {
  it('defaults are the owner decision (26 Oct): enabled, $100,000, 7 days, every day', () => {
    expect(PIPELINE_CONFIG.singleSource).toEqual({ enabled: true, minDailyVolumeUsd: 100_000, days: 7, requireEveryDay: true })
  })
  it('per-chain override merges over the default; unset keys inherit; other chains unaffected', () => {
    const cfg = { ...PIPELINE_CONFIG, singleSourceByChain: { 8453: { minDailyVolumeUsd: 250_000 }, 42161: { enabled: false } } }
    expect(resolveSingleSourceConfig(cfg, 8453)).toEqual({ enabled: true, minDailyVolumeUsd: 250_000, days: 7, requireEveryDay: true })
    expect(resolveSingleSourceConfig(cfg, 42161).enabled).toBe(false)
    expect(resolveSingleSourceConfig(cfg, 1)).toEqual(PIPELINE_CONFIG.singleSource)
  })
})

describe('applicability + crossVerify', () => {
  const A = getAddress('0x00000000000000000000000000000000000000a1')
  const cand = (sources: Candidate['sources']): Candidate => ({ chainId: 1, address: A, sources, symbol: 'X', name: 'X', decimals: 18, decimalsDisagree: false })
  const admitted = evaluateSingleSource({ ok: true, dailyVolumeUsd: Array(7).fill(5e6) }, PIPELINE_CONFIG.singleSource)

  it('isSingleSourceCoingecko: exactly one external vote and it is CoinGecko (non-voting provenance ignored)', () => {
    expect(isSingleSourceCoingecko(cand(['coingecko']))).toBe(true)
    expect(isSingleSourceCoingecko(cand(['curated', 'coingecko', 'defillama']))).toBe(true)
    expect(isSingleSourceCoingecko(cand(['uniswap', 'coingecko']))).toBe(false)
    expect(isSingleSourceCoingecko(cand(['oneinch']))).toBe(false)
    expect(isSingleSourceCoingecko(cand(['curated']))).toBe(false)
  })

  it('an admitted verdict never rescues a two-source or non-CoinGecko candidate, and never touches the low-liquidity floor of two-source tokens', () => {
    const verdicts = new Map([[`1:${A.toLowerCase()}`, admitted]])
    const lowLiq = new Map() // no market data ⇒ low-liquidity ⇒ 2 votes < 3 required
    const two = crossVerify([cand(['uniswap', 'coingecko'])], lowLiq, new Set(), PIPELINE_CONFIG, verdicts)
    expect(two.qualified).toHaveLength(0)
    expect(two.rejected[0].reason).toBe('insufficient-sources-low-liquidity')
    const oneInch = crossVerify([cand(['oneinch'])], lowLiq, new Set(), PIPELINE_CONFIG, verdicts)
    expect(oneInch.qualified).toHaveLength(0)
    const cg = crossVerify([cand(['coingecko'])], lowLiq, new Set(), PIPELINE_CONFIG, verdicts)
    expect(cg.qualified).toHaveLength(1)
    expect(cg.qualified[0].admission?.rule).toBe('single-source-volume')
  })

  it('still enforces requiredSourceForNew on an admitted single-source token', () => {
    const verdicts = new Map([[`1:${A.toLowerCase()}`, admitted]])
    const r = crossVerify([cand(['coingecko'])], new Map(), new Set(), { ...PIPELINE_CONFIG, requiredSourceForNew: 'uniswap' }, verdicts)
    expect(r.qualified).toHaveLength(0)
    expect(r.rejected[0].reason).toBe('missing-required-source')
  })

  it('without a verdict (rule off / not evaluated) a one-vote token is rejected exactly as before', () => {
    const r = crossVerify([cand(['coingecko'])], new Map(), new Set(), PIPELINE_CONFIG)
    expect(r.rejected).toEqual([{ chainId: 1, address: A, symbol: 'X', reason: 'insufficient-sources', detail: '1 source vote(s)' }])
  })
})

describe('makeCoingeckoHistoryClient — throttle + backoff (injected clock)', () => {
  function harness(responses: Array<Response | Error>) {
    let t = 1_000_000
    const sleeps: number[] = []
    const urls: string[] = []
    const inits: RequestInit[] = []
    const stamps: number[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url))
      inits.push(init ?? {})
      stamps.push(t)
      const r = responses.shift()
      if (!r) throw new Error('unexpected extra call')
      if (r instanceof Error) throw r
      return r
    }) as unknown as typeof fetch
    const client = makeCoingeckoHistoryClient({ fetchImpl, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms } })
    return { client, sleeps, urls, inits, stamps, fetchImpl }
  }

  it('429 then success ⇒ admitted-shaped history, one backoff of base (15 s), exactly 2 calls', async () => {
    const h = harness([ok({}, 429), ok(payload(Array(7).fill(5e6)))])
    const res = await h.client('ether-fi', 7)
    expect(res).toMatchObject({ ok: true })
    expect(h.fetchImpl).toHaveBeenCalledTimes(2)
    expect(h.sleeps).toContain(CG_HISTORY_BACKOFF_BASE_MS)
    expect(evaluateSingleSource(res, PIPELINE_CONFIG.singleSource).status).toBe('admitted')
  })

  it('ONE token per call, daily interval, keyless (no auth / api-key header)', async () => {
    const h = harness([ok(RECORDED)])
    await h.client('ether-fi', 7)
    expect(h.urls).toEqual(['https://api.coingecko.com/api/v3/coins/ether-fi/market_chart?vs_currency=usd&days=7&interval=daily'])
    const headerNames = Object.keys((h.inits[0].headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase())
    expect(headerNames).toEqual(['accept'])
  })

  it('exponential backoff 15 → 30 → 60 → 120 s, then gives up (fail-closed) after 5 attempts', async () => {
    const h = harness(Array.from({ length: 5 }, () => ok({}, 429)))
    const res = await h.client('ether-fi', 7)
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toMatch(/HTTP 429.*gave up after 5 attempts/)
    expect(h.fetchImpl).toHaveBeenCalledTimes(CG_HISTORY_MAX_RETRIES + 1)
    expect(h.sleeps.filter((s) => s >= CG_HISTORY_BACKOFF_BASE_MS)).toEqual([15_000, 30_000, 60_000, 120_000])
  })

  it('honours Retry-After when it exceeds the computed backoff', async () => {
    const h = harness([ok({}, 429, { 'retry-after': '90' }), ok(RECORDED)])
    await h.client('ether-fi', 7)
    expect(h.sleeps).toContain(90_000)
  })

  it('a non-retryable 4xx (e.g. 404) fails immediately with a single call', async () => {
    const h = harness([ok({}, 404)])
    const res = await h.client('gone-coin', 7)
    expect(res).toMatchObject({ ok: false })
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('network error then success is retried; a malformed 200 body is a failure, not a pass', async () => {
    const a = harness([new Error('ECONNRESET'), ok(RECORDED)])
    expect(await a.client('ether-fi', 7)).toMatchObject({ ok: true })
    const b = harness([ok({ nope: true })])
    expect(await b.client('ether-fi', 7)).toMatchObject({ ok: false, error: expect.stringContaining('malformed') })
  })

  it('spaces consecutive calls >= 6 s apart (10 calls/min ceiling)', async () => {
    const h = harness([ok(RECORDED), ok(RECORDED), ok(RECORDED)])
    for (const id of ['a', 'b', 'c']) await h.client(id, 7)
    const gaps = h.stamps.slice(1).map((s, i) => s - h.stamps[i])
    expect(gaps.every((g) => g >= CG_HISTORY_MIN_INTERVAL_MS)).toBe(true)
  })
})

describe('end to end through buildChainCatalog (fake CoinGecko, no network)', () => {
  const AL: Allowlist = { nativeEth: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', trustedListExempt: [], duplicateSymbolExempt: [] }
  const addrOf = (i: number) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`)
  const clean = async (tokens: Array<{ chainId: number; address: string; symbol: string }>): Promise<Verdict[]> =>
    tokens.map((t) => ({ chainId: t.chainId, address: t.address, symbol: t.symbol, inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: t.symbol, decimals: 18 }))

  afterEach(() => vi.unstubAllGlobals())

  it('7/7 admitted · 6/7 rejected · 429-then-success admitted · fetch error rejected+counted · two-source token on the unchanged path', async () => {
    const ids: Record<string, { i: number; sym: string; script: Array<Response | Error> }> = {
      'coin-full': { i: 1, sym: 'FULL', script: [ok(payload(Array(7).fill(5e6)))] },
      'coin-six': { i: 2, sym: 'SIXOF7', script: [ok(payload([5e6, 5e6, 5e6, 99_999, 5e6, 5e6, 5e6]))] },
      'coin-retry': { i: 3, sym: 'RETRY', script: [ok({}, 429), ok(payload(Array(7).fill(300_000)))] },
      'coin-boom': { i: 4, sym: 'BOOM', script: Array.from({ length: 5 }, () => ok({}, 500)) },
      'coin-two': { i: 5, sym: 'TWOSRC', script: [] }, // must NEVER be asked for history
    }
    const calls: string[] = []
    // coins/list payload carries the address in an UPPERCASED spelling on purpose: matching is lower-cased equality
    const coinsList = Object.entries(ids).map(([id, v]) => ({ id, platforms: { ethereum: addrOf(v.i).toUpperCase().replace('0X', '0x') } }))
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/coins/list')) return ok(coinsList)
      const m = /coins\/([^/]+)\/market_chart/.exec(u)
      if (m) {
        calls.push(m[1])
        const r = ids[m[1]].script.shift()
        if (!r) throw new Error(`unexpected call for ${m[1]}`)
        if (r instanceof Error) throw r
        return r
      }
      throw new Error(`unexpected url ${u}`)
    }))

    let t = 0
    const fetchVolumeHistory = makeVolumeHistoryFetcher(1, 7, makeCoingeckoHistoryClient({ now: () => t, sleep: async (ms) => { t += ms } }))
    const entry = (source: SourceEntry['source'], i: number, symbol: string): SourceEntry => ({ chainId: 1, address: addrOf(i), symbol, name: symbol, decimals: 18, source })
    const result = await buildChainCatalog(1, {
      fetchSources: [
        async (): Promise<SourceFetchResult> => ({ source: 'coingecko', entries: Object.values(ids).map((v) => entry('coingecko', v.i, v.sym)), market: new Map([[`1:${addrOf(5).toLowerCase()}`, { priceUsd: 1, priceConfidence: 0.99 }]]) }),
        async (): Promise<SourceFetchResult> => ({ source: 'uniswap', entries: [entry('uniswap', 5, 'TWOSRC')] }),
      ],
      fetchVolume: async (addrs) => ({ source: 'coingecko', entries: [], market: new Map(addrs.map((a) => [`1:${a.toLowerCase()}`, { volume24hUsd: 2_000_000, volumeSource: 'coingecko' as const }])) }),
      fetchVolumeHistory,
      collectVerdicts: clean,
      allowlist: AL,
      seeds: new Map(),
      cores: [],
      config: PIPELINE_CONFIG,
      categoryFor: () => 'Other',
      logoFor: () => '/l',
      log: () => {},
      builtAt: '2026-10-26',
    })

    expect(result.tokens.map((x) => x.symbol).sort()).toEqual(['FULL', 'RETRY', 'TWOSRC'])
    expect(result.tokens.find((x) => x.symbol === 'FULL')?.admission?.dailyVolumeUsd).toEqual(Array(7).fill(5e6))
    expect(result.tokens.find((x) => x.symbol === 'RETRY')?.admission?.dailyVolumeUsd).toEqual(Array(7).fill(300_000))
    expect(result.tokens.find((x) => x.symbol === 'TWOSRC')?.admission).toBeUndefined() // unchanged path
    expect(calls).not.toContain('coin-two') // two-source token: zero history calls
    expect(calls.filter((c) => c === 'coin-retry')).toHaveLength(2) // 429 then success
    expect(calls.filter((c) => c === 'coin-boom')).toHaveLength(CG_HISTORY_MAX_RETRIES + 1)

    const ss = result.report.singleSource
    expect(ss).toMatchObject({ candidates: 4, prefiltered: 0, evaluated: 4, admitted: 2, belowFloor: 1, fetchFailed: 1 })
    const rej = (sym: string) => result.report.rejections.find((r) => r.symbol === sym)
    expect(rej('SIXOF7')).toMatchObject({ reason: 'insufficient-sources', singleSource: 'below-floor' })
    expect(rej('BOOM')).toMatchObject({ reason: 'insufficient-sources', singleSource: 'fetch-failed' })
    expect(rej('BOOM')?.detail).toMatch(/history unavailable/)
  })

  it('the 24h pre-filter spends no history call on a token that is under the floor today (or has no volume)', async () => {
    const hist = vi.fn(async () => new Map())
    const e = (i: number, s: string): SourceEntry => ({ chainId: 1, address: addrOf(i), symbol: s, name: s, decimals: 18, source: 'coingecko' })
    const result = await buildChainCatalog(1, {
      fetchSources: [async () => ({ source: 'coingecko' as const, entries: [e(1, 'LOW'), e(2, 'NOVOL')] })],
      fetchVolume: async () => ({ source: 'coingecko' as const, entries: [], market: new Map([[`1:${addrOf(1).toLowerCase()}`, { volume24hUsd: 99_999, volumeSource: 'coingecko' as const }]]) }),
      fetchVolumeHistory: hist,
      collectVerdicts: clean,
      allowlist: AL, seeds: new Map(), cores: [], config: PIPELINE_CONFIG, categoryFor: () => 'Other', logoFor: () => '/l', log: () => {}, builtAt: '2026-10-26',
    })
    expect(hist).not.toHaveBeenCalled()
    expect(result.tokens).toHaveLength(0)
    expect(result.report.singleSource).toMatchObject({ candidates: 2, prefiltered: 2, evaluated: 0, admitted: 0 })
  })

  it('the 24h pre-filter volume fetch (/coins/markets) rides the same throttled client: 429 is retried, an exhausted batch is counted not silently lost', async () => {
    const a = addrOf(1)
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/coins/list')) return ok([{ id: 'coin-full', platforms: { ethereum: a.toUpperCase().replace('0X', '0x') } }])
      throw new Error(`unexpected url ${String(url)}`)
    }))
    const markets = (responses: Response[]) => {
      let t = 0
      const sleeps: number[] = []
      const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch
      return { sleeps, fetchImpl, client: makeCoingeckoJsonClient({ fetchImpl, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms } }) }
    }
    const good = markets([ok({}, 429), ok([{ id: 'coin-full', total_volume: 2_000_000 }])])
    const res = await makeVolumeFetcher(1, good.client)([a])
    expect(res.market?.get(`1:${a.toLowerCase()}`)).toEqual({ volume24hUsd: 2_000_000, volumeSource: 'coingecko' })
    expect(good.sleeps).toContain(CG_HISTORY_BACKOFF_BASE_MS)

    const dead = markets(Array.from({ length: CG_HISTORY_MAX_RETRIES + 1 }, () => ok({}, 429)))
    await expect(makeVolumeFetcher(1, dead.client)([a])).rejects.toThrow(/all 1 batch/)
  })
})
