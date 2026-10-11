// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { normalizeAddress } from './normalize-address'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FUTURE_SKEW_SEC, MAX_PRICE_AGE_SEC, QUORUM_TOLERANCE_BPS, SOURCE_TIMEOUT_MS,
  offchainQuorumPrice, quorumPriceUsd, resetQuorumQuoteCache, spreadBps,
} from './dca-price-quorum'

const TOKEN = '0xc3De830EA07524a0761646a6a4e4be0e114a3C83'
const NOW_SEC = 1791713979
const llamaKey = `base:${TOKEN.toLowerCase()}`
const llamaBody = (price: number, ts = NOW_SEC - 100) => ({ coins: { [llamaKey]: { price, timestamp: ts, confidence: 0.99, symbol: 'UNI' } } })
const geckoBody = (usd: number, ts = NOW_SEC - 30) => ({ [TOKEN.toLowerCase()]: { usd, last_updated_at: ts } })

/** Network mock: one handler per vendor. `null` = HTTP 500; 'throw' = network failure. */
function serve(llama: unknown, gecko: unknown) {
  const urls: string[] = []
  const answer = (v: unknown) => { if (v === 'throw') throw new TypeError('Failed to fetch'); return v === null ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => v } }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return answer(url.startsWith('https://coins.llama.fi/') ? llama : gecko)
  }))
  return urls
}

beforeEach(() => {
  resetQuorumQuoteCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_SEC * 1000)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('off-chain price quorum (the keeper reaches quorum <=> offchain-price)', () => {
  it('2 sources agreeing within tolerance -> priced (quorum)', async () => {
    const urls = serve(llamaBody(7.557), geckoBody(7.561))
    expect(await quorumPriceUsd(TOKEN, 'base')).toBe(7.557)
    expect(urls.sort()).toEqual([
      `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${TOKEN.toLowerCase()}&vs_currencies=usd&include_last_updated_at=true`,
      `https://coins.llama.fi/prices/current/${llamaKey}`,
    ])
  })
  it('exactly 1 source (the other down / empty / absent) -> null (the keeper\'s single)', async () => {
    for (const [l, g] of [['throw', 'throw'], [llamaBody(7.5), null], [llamaBody(7.5), 'throw'], [llamaBody(7.5), {}], [null, geckoBody(7.5)], ['throw', geckoBody(7.5)]] as const) {
      resetQuorumQuoteCache()
      serve(l, g)
      expect(await quorumPriceUsd(TOKEN, 'base')).toBeNull()
    }
  })
  it('2 sources disagreeing beyond tolerance -> null (the keeper\'s skip)', async () => {
    serve(llamaBody(7.5), geckoBody(7.5 * (1 + (QUORUM_TOLERANCE_BPS + 50) / 10_000)))
    expect(await quorumPriceUsd(TOKEN, 'base')).toBeNull()
  })
  it('the tolerance edge: exactly QUORUM_TOLERANCE_BPS agrees, one more bps does not', () => {
    const q = (price: number, source: 'defillama' | 'coingecko') => ({ price, source })
    expect(offchainQuorumPrice([q(100, 'defillama'), q(103, 'coingecko')])).toBe(100)
    expect(offchainQuorumPrice([q(100, 'defillama'), q(103.01, 'coingecko')])).toBeNull()
  })
  it('a source counts once: two quotes from the same vendor are not a quorum', () => {
    expect(offchainQuorumPrice([{ price: 1, source: 'defillama' }, { price: 1, source: 'defillama' }])).toBeNull()
  })
  it('a stale, undated or far-future quote is ABSENT (never stale-but-counted)', async () => {
    for (const ts of [NOW_SEC - MAX_PRICE_AGE_SEC - 1, 0, NOW_SEC + FUTURE_SKEW_SEC + 1]) {
      resetQuorumQuoteCache()
      serve(llamaBody(7.5, ts), geckoBody(7.5))
      expect(await quorumPriceUsd(TOKEN, 'base')).toBeNull()
    }
    resetQuorumQuoteCache()
    serve(llamaBody(7.5, NOW_SEC - MAX_PRICE_AGE_SEC), geckoBody(7.5, NOW_SEC + FUTURE_SKEW_SEC))
    expect(await quorumPriceUsd(TOKEN, 'base')).toBe(7.5)
  })
  it('an unmapped chain has no CoinGecko source -> never quorum', async () => {
    serve({ coins: { [`linea:${TOKEN.toLowerCase()}`]: { price: 1, timestamp: NOW_SEC } } }, geckoBody(1))
    expect(await quorumPriceUsd(TOKEN, 'linea')).toBeNull()
  })
  it('caches the two quotes briefly: a second ask makes no request', async () => {
    const urls = serve(llamaBody(7.5), geckoBody(7.5))
    await quorumPriceUsd(TOKEN, 'base'); await quorumPriceUsd(TOKEN, 'base')
    expect(urls).toHaveLength(2)
  })
  it('spreadBps matches the keeper (hi-lo)/lo*10000; unusable prices are infinite', () => {
    expect(spreadBps(100, 103)).toBeCloseTo(300, 9)
    expect(spreadBps(0, 1)).toBe(Number.POSITIVE_INFINITY)
  })
})

/**
 * PIN to the keeper (ADR-024), "regex + value" like the cap pin. The keeper quorum is on main
 * (#560: order-floor.js + price-sources.js), so both checks are unconditional:
 *  - frozen literals (the values as of 2026-10-11);
 *  - the working tree: regex on the keeper source text AND the imported value.
 * No skip conditions: a moved/renamed keeper file fails here (ENOENT) instead of silently skipping,
 * and any drift fails loudly.
 */
const KEEPER_DIR = resolve(__dirname, '../../../contracts/order-engine/executor')
const consts = (floor: string, sources: string) => ({
  tol: Number(floor.match(/export const QUORUM_TOLERANCE_BPS\s*=\s*(\d[\d_]*)/)?.[1]?.replace(/_/g, '')),
  age: Number(floor.match(/export const MAX_PRICE_AGE_SEC\s*=\s*(\d[\d_]*)/)?.[1]?.replace(/_/g, '')),
  skew: Number(sources.match(/export const FUTURE_SKEW_SEC\s*=\s*(\d[\d_]*)/)?.[1]?.replace(/_/g, '')),
  timeout: Number(sources.match(/export const SOURCE_TIMEOUT_MS\s*=\s*(\d[\d_]*)/)?.[1]?.replace(/_/g, '')),
})
const WEB = { tol: QUORUM_TOLERANCE_BPS, age: MAX_PRICE_AGE_SEC, skew: FUTURE_SKEW_SEC, timeout: SOURCE_TIMEOUT_MS }

describe('quorum constants are pinned to the keeper', () => {
  it('frozen values (ADR-024, 2026-10-11): 300 bps, 600 s, 300 s skew, 5 s timeout', () => {
    expect(WEB).toEqual({ tol: 300, age: 600, skew: 300, timeout: 5000 })
  })
  it('equal the keeper in this tree (regex on source text AND imported value)', async () => {
    const floor = readFileSync(resolve(KEEPER_DIR, 'order-floor.js'), 'utf8')
    const sources = readFileSync(resolve(KEEPER_DIR, 'price-sources.js'), 'utf8')
    expect(consts(floor, sources)).toEqual(WEB)
    const k = await import(/* @vite-ignore */ resolve(KEEPER_DIR, 'order-floor.js'))
    expect(k.QUORUM_TOLERANCE_BPS).toBe(QUORUM_TOLERANCE_BPS)
    expect(k.MAX_PRICE_AGE_SEC).toBe(MAX_PRICE_AGE_SEC)
  })
})

describe('request-forgery guard: only the two fixed price origins are ever fetched', () => {
  const ALLOWED = new Set(['https://coins.llama.fi', 'https://api.coingecko.com'])
  const JUNK = ['0x..%2F..%2Fevil', '0x../../evil', 'https://evil.example/x', `${TOKEN}/../x`, `${TOKEN}?x=1`, '//evil.example', '', '0x123', ` ${TOKEN}`]

  it('junk addresses never reach fetch (0 calls) and read as unpriced', async () => {
    const urls = serve(llamaBody(7.5), geckoBody(7.5))
    for (const bad of JUNK) expect(await quorumPriceUsd(bad, 'base'), bad).toBeNull()
    expect(urls).toHaveLength(0)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(0)
  })
  it('every URL actually fetched is on the allow-list, for a valid address on each chain', async () => {
    const urls = serve(llamaBody(7.5), geckoBody(7.5))
    for (const slug of ['ethereum', 'base', 'arbitrum']) { resetQuorumQuoteCache(); await quorumPriceUsd(TOKEN, slug) }
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(ALLOWED.has(new URL(u).origin), u).toBe(true)
  })
  it('a hostile slug cannot leave the origin (encoded or rejected, never a foreign host)', async () => {
    const urls = serve(llamaBody(7.5), geckoBody(7.5))
    for (const slug of ['../../evil', '@evil.example', 'x/../../y', '//evil.example']) { resetQuorumQuoteCache(); await quorumPriceUsd(TOKEN, slug) }
    for (const u of urls) expect(ALLOWED.has(new URL(u).origin), u).toBe(true)
  })
  it('normalizeAddress: exactly 0x + 40 hex -> lowercase; everything else null', () => {
    expect(normalizeAddress(TOKEN)).toBe(TOKEN.toLowerCase())
    for (const bad of [...JUNK, null, undefined, 5, `${TOKEN}\n`, TOKEN.slice(2)]) expect(normalizeAddress(bad), String(bad)).toBeNull()
  })
})
