// @vitest-environment node
/**
 * [fix/log-routes-bounded-input, SEC-3] POST /api/log-quote keeps adapter-registry source names only and bounds every
 * other field (lib/log-quote-input.ts).
 *
 * - Property (seeded): random name arrays mixing registry names, invented names, near-misses, prototype keys, repeats and
 *   non-strings, 0 to 5,000 entries (and non-array values), through the real route. Every request answers 200
 *   { ok: true } as before; it writes at most one failure event per registry source, exactly the registry names queried
 *   and not responded; the stored arrays hold registry names only, each once.
 *   The body cap is raised to 10 MB in this file only, so 5,000-entry arrays reach the name filter: the filter is proven
 *   on its own, without help from the 10 KB cap (which has its own tests in lib/body-limit.sec8.test.ts).
 * - The swap screen's own request (built by the real logQuoteToSupabase) is stored field for field as sent.
 * - The size bounds of the owner's answer of 2026-11-17: past the bound or of the wrong type = absent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const inserts = vi.hoisted(() => [] as Array<{ table: string; row: Record<string, unknown> }>)
vi.mock('@/lib/supabase', () => {
  const client = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row })
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { getSupabase: () => client, getSupabaseLogger: () => client }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})
vi.mock('@/lib/body-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/body-limit')>('@/lib/body-limit')
  return {
    ...actual,
    bodySizeGuard: (req: Request, _max?: number, headers?: Record<string, string>) =>
      actual.bodySizeGuard(req, 10_000_000, headers),
  }
})

import { POST } from './route'
import { ADAPTER_SOURCE_NAMES } from '@/lib/adapters'
import { logQuoteToSupabase } from '@/lib/analytics'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/adapters'
import type { Token } from '@/lib/tokens'

const REGISTRY: readonly string[] = ADAPTER_SOURCE_NAMES
const QUOTE = {
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amountIn: '1000000000000000000',
}

const table = (name: string) => inserts.filter((i) => i.table === name)

function post(body: string) {
  return POST(new NextRequest('http://localhost/api/log-quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  }))
}

beforeEach(() => {
  inserts.length = 0
})

// ── seeded generator ─────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NEAR_MISSES = ['1INCH', ' velora', 'velora ', 'Cowswap', 'cow', 'uniswap', 'teraswap_order_engine', '0X', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty']

function makeEntry(rnd: () => number, previous: unknown[]): unknown {
  const r = rnd()
  if (r < 0.3) return REGISTRY[Math.floor(rnd() * REGISTRY.length)]
  if (r < 0.55) return `made-up-${Math.floor(rnd() * 1e6)}`
  if (r < 0.65) return NEAR_MISSES[Math.floor(rnd() * NEAR_MISSES.length)]
  if (r < 0.8 && previous.length > 0) return previous[Math.floor(rnd() * previous.length)]
  const odd: unknown[] = [Math.floor(rnd() * 100), null, true, false, {}, [REGISTRY[0]], { name: REGISTRY[1] }, 1.5]
  return odd[Math.floor(rnd() * odd.length)]
}

function makeNames(rnd: () => number): unknown {
  const shape = rnd()
  if (shape < 0.06) return REGISTRY[Math.floor(rnd() * REGISTRY.length)] // a bare string, not an array
  if (shape < 0.1) return { 0: REGISTRY[0], length: 1 }
  if (shape < 0.12) return null
  if (shape < 0.14) return 42
  const length = shape < 0.4 ? Math.floor(rnd() * 20) : Math.floor(rnd() * 5001)
  const out: unknown[] = []
  for (let i = 0; i < length; i++) out.push(makeEntry(rnd, out))
  return out
}

function makeAllQuotes(rnd: () => number): unknown {
  if (rnd() < 0.15) return rnd() < 0.5 ? null : ['velora', '1']
  const entries: Array<[string, unknown]> = []
  const n = Math.floor(rnd() * 40)
  for (let i = 0; i < n; i++) {
    const key = String(makeEntry(rnd, []))
    entries.push([key, rnd() < 0.8 ? String(Math.floor(rnd() * 1e12)) : 'x'.repeat(81)])
  }
  return Object.fromEntries(entries) // own keys, '__proto__' included as data
}

/** Registry names that occur in `value` when it is an array: the oracle, written without the code under test. */
function registryIn(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? REGISTRY.filter((n) => value.includes(n)) : [])
}

const SEEDS = [1, 42, 20261117]
const CASES_PER_SEED = 60

describe('property (seeded): invented, repeated and non-string source names', () => {
  it.each(SEEDS)('seed %i: <= one failure event per registry source, registry names only, status as before', async (seed) => {
    const rnd = mulberry32(seed)
    let maxEvents = 0
    let maxEntries = 0
    for (let c = 0; c < CASES_PER_SEED; c++) {
      inserts.length = 0
      const sourcesQueried = makeNames(rnd)
      const sourcesResponded = makeNames(rnd)
      const bestSource = makeEntry(rnd, [])
      const body = JSON.stringify({
        ...QUOTE,
        tokenInSymbol: 'WETH',
        tokenOutSymbol: 'USDC',
        sourcesQueried,
        sourcesResponded,
        bestSource,
        allQuotes: makeAllQuotes(rnd),
        responseTimeMs: 120,
        wallet: rnd() < 0.5 ? '0x000000000000000000000000000000000000dEaD' : undefined,
      })
      if (Array.isArray(sourcesQueried)) maxEntries = Math.max(maxEntries, sourcesQueried.length)

      const res = await post(body)
      const where = `seed ${seed} case ${c}`
      expect(res.status, where).toBe(200)
      expect(await res.json(), where).toEqual({ ok: true })

      const events = table('security_events')
      const queried = registryIn(sourcesQueried)
      const responded = registryIn(sourcesResponded)
      const expectedFailed = [...queried].filter((n) => !responded.has(n)).sort()
      expect(events.length, where).toBeLessThanOrEqual(REGISTRY.length)
      expect(events.map((e) => e.row.source).sort(), where).toEqual(expectedFailed)
      maxEvents = Math.max(maxEvents, events.length)

      const [quote] = table('quotes')
      expect(table('quotes'), where).toHaveLength(1)
      const storedQ = quote.row.sources_queried as string[]
      const storedR = quote.row.sources_responded as string[]
      for (const stored of [storedQ, storedR]) {
        expect(stored.every((n) => REGISTRY.includes(n)), where).toBe(true)
        expect(new Set(stored).size, where).toBe(stored.length)
      }
      expect(new Set(storedQ), where).toEqual(queried)
      expect(new Set(storedR), where).toEqual(responded)
      expect(quote.row.best_source, where).toBe(REGISTRY.includes(bestSource as string) ? bestSource : null)
      const allQuotes = quote.row.all_quotes as Record<string, unknown> | null
      if (allQuotes) expect(Object.keys(allQuotes).every((k) => REGISTRY.includes(k)), where).toBe(true)
    }
    // The generator did reach the sizes the goal names, and the events were bounded by the registry, not by luck.
    expect(maxEntries).toBeGreaterThan(4000)
    expect(maxEvents).toBeLessThanOrEqual(REGISTRY.length)
  }, 60_000)
})

describe('the swap screen request (lib/analytics.ts logQuoteToSupabase) is stored as sent', () => {
  it('stores every field of the real request unchanged and writes no failure event', async () => {
    let sent = ''
    const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body)
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fetchStub)
    const q = (source: string, toAmount: string) => ({ source, toAmount }) as unknown as NormalizedQuote
    const all = [q('kyberswap', '2501234567'), q('velora', '2500000000'), q('cowswap', '2499000000')]
    logQuoteToSupabase({
      tokenIn: { address: QUOTE.tokenIn, symbol: 'WETH' } as Token,
      tokenOut: { address: QUOTE.tokenOut, symbol: 'USDC' } as Token,
      amountIn: QUOTE.amountIn,
      meta: { best: all[0], all, fetchedAt: 1 } as MetaQuoteResult,
      responseTimeMs: 842,
      wallet: '0x000000000000000000000000000000000000dEaD',
    })
    vi.unstubAllGlobals()
    expect(fetchStub).toHaveBeenCalledWith('/api/log-quote', expect.anything())

    const res = await post(sent)
    expect(res.status).toBe(200)
    expect(table('quotes')).toHaveLength(1)
    expect(table('quotes')[0].row).toEqual({
      token_in: QUOTE.tokenIn.toLowerCase(),
      token_in_symbol: 'WETH',
      token_out: QUOTE.tokenOut.toLowerCase(),
      token_out_symbol: 'USDC',
      amount_in: QUOTE.amountIn,
      sources_queried: ['kyberswap', 'velora', 'cowswap'],
      sources_responded: ['kyberswap', 'velora', 'cowswap'],
      best_source: 'kyberswap',
      best_amount_out: '2501234567',
      all_quotes: { kyberswap: '2501234567', velora: '2500000000', cowswap: '2499000000' },
      response_time_ms: 842,
      wallet: '0x000000000000000000000000000000000000dead',
    })
    expect(table('security_events')).toHaveLength(0)
    expect(table('wallet_activity')).toHaveLength(1)
  })
})

describe('size bounds (owner answer 2026-11-17): past the bound or the wrong type = absent', () => {
  const send = (extra: Record<string, unknown>) => post(JSON.stringify({ ...QUOTE, ...extra }))

  it('keeps a 32-character symbol and drops a 33-character one (stored as the empty default)', async () => {
    await send({ tokenInSymbol: 'S'.repeat(32), tokenOutSymbol: 'S'.repeat(33) })
    const row = table('quotes')[0].row
    expect(row.token_in_symbol).toBe('S'.repeat(32))
    expect(row.token_out_symbol).toBe('')
  })

  it('answers 400 when a required field is past its bound or not a string, exactly as when it is missing', async () => {
    expect((await send({ tokenIn: '0x' + 'a'.repeat(62) })).status).toBe(200)
    expect((await send({ tokenIn: '0x' + 'a'.repeat(63) })).status).toBe(400)
    expect((await send({ tokenOut: 12345 })).status).toBe(400)
    expect((await send({ amountIn: '9'.repeat(80) })).status).toBe(200)
    expect((await send({ amountIn: '9'.repeat(81) })).status).toBe(400)
    expect((await send({ amountIn: undefined })).status).toBe(400)
  })

  it('drops an over-long wallet: no wallet stored, no wallet activity written', async () => {
    await send({ wallet: '0x' + 'b'.repeat(63) })
    expect(table('quotes')[0].row.wallet).toBeNull()
    expect(table('wallet_activity')).toHaveLength(0)
  })

  it('keeps allQuotes entries for registry names only, values up to 80 characters, never touching a prototype', async () => {
    const allQuotes = Object.fromEntries([
      ['velora', '123'],
      ['made-up', '1'],
      ['__proto__', '1'],
      ['kyberswap', 'x'.repeat(81)],
      ['1inch', 77],
    ])
    await send({ allQuotes })
    const stored = table('quotes')[0].row.all_quotes as Record<string, unknown>
    expect(stored).toEqual({ velora: '123', '1inch': 77 })
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype)
  })

  it('stores null for a non-object allQuotes, 0 for a non-numeric responseTimeMs, null for an invented bestSource', async () => {
    await send({ allQuotes: 'velora', responseTimeMs: '9'.repeat(5000), bestSource: 'made-up', bestAmountOut: 'y'.repeat(81) })
    const row = table('quotes')[0].row
    expect(row.all_quotes).toBeNull()
    expect(row.response_time_ms).toBe(0)
    expect(row.best_source).toBeNull()
    expect(row.best_amount_out).toBeNull()
  })

  it('bounds the text of a failure event: an over-long symbol falls back to the address', async () => {
    await send({ tokenInSymbol: 'Z'.repeat(5000), sourcesQueried: ['velora'], sourcesResponded: [] })
    const [event] = table('security_events')
    expect(event.row.source).toBe('velora')
    expect(event.row.token_in).toBe(QUOTE.tokenIn)
    expect(String(event.row.message).length).toBeLessThan(200)
  })
})
