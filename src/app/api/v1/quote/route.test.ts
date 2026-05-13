/**
 * Unit tests for GET /api/v1/quote [LP-09].
 *
 * Covers:
 *   - OPTIONS preflight (204 + full CORS)
 *   - System halt short-circuit (503 + Retry-After) — fires before auth
 *   - Auth: missing key → 401; invalid → 401; rate limited → 429 with
 *     X-RateLimit-* headers
 *   - Param validation: missing required, malformed address, invalid
 *     amount, slippage out of range, unsupported chainId
 *   - Happy path: 200 + response shape (best, quotes[], meta with
 *     timestamp/sourcesQueried/sourcesResponded/mevProtected)
 *   - mevProtected flag derived from best.source
 *   - CORS headers on every response (success + error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks (must be declared before the route import) ─────

const mockVerifyApiKey = vi.fn()
vi.mock('@/lib/api-auth', () => ({
  verifyApiKey: (...args: unknown[]) => mockVerifyApiKey(...args),
}))

const mockFetchMetaQuote = vi.fn()
vi.mock('@/lib/api', () => ({
  fetchMetaQuote: (...args: unknown[]) => mockFetchMetaQuote(...args),
}))

const mockIsSystemHalted = vi.fn()
vi.mock('@/lib/circuit-breaker', () => ({
  isSystemHalted: () => mockIsSystemHalted(),
}))

// ── Import route after mocks ─────────────────────────────

import { GET, OPTIONS } from './route'

// ── Fixtures ─────────────────────────────────────────────

const VALID_TOKEN_IN = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'  // WETH
const VALID_TOKEN_OUT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC

function makeRequest(params: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  const q = new URLSearchParams(params).toString()
  return new NextRequest(`http://localhost/api/v1/quote?${q}`, {
    method: 'GET',
    headers: { 'X-API-Key': 'tsk_test_default_key', ...headers },
  })
}

function authSuccess() {
  return {
    ok: true,
    keyId: 'fixture-key-id',
    keyName: 'test',
    tier: 'free' as const,
    rateLimitHeaders: {
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '9',
      'X-RateLimit-Reset': '1700000060',
    },
  }
}

function metaQuoteFixture(bestSource: string = '1inch') {
  return {
    best: {
      source: bestSource,
      toAmount: '2950420000',
      estimatedGas: 150000,
      gasUsd: 4.2,
      routes: ['WETH → USDC'],
    },
    all: [
      {
        source: bestSource,
        toAmount: '2950420000',
        estimatedGas: 150000,
        gasUsd: 4.2,
        routes: ['WETH → USDC'],
      },
      {
        source: '0x',
        toAmount: '2949000000',
        estimatedGas: 160000,
        gasUsd: 4.5,
        routes: ['WETH → USDC'],
      },
    ],
    fetchedAt: 1700000000_000,
  }
}

// ── Tests ────────────────────────────────────────────────

describe('OPTIONS /api/v1/quote', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 204 with full CORS preflight headers', async () => {
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toContain('X-API-Key')
  })
})

describe('GET /api/v1/quote — circuit breaker halt', () => {
  beforeEach(() => vi.clearAllMocks())

  it('short-circuits to 503 with Retry-After before touching auth', async () => {
    mockIsSystemHalted.mockResolvedValueOnce(true)
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1000000000000000000' }))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('300')
    expect(mockVerifyApiKey).not.toHaveBeenCalled()
    expect(mockFetchMetaQuote).not.toHaveBeenCalled()
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('GET /api/v1/quote — auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
  })

  it('401 on missing/invalid key', async () => {
    mockVerifyApiKey.mockResolvedValueOnce({ ok: false, status: 401, error: 'Missing X-API-Key header.' })
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/Missing X-API-Key/)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('429 with X-RateLimit-* + Retry-After when key is rate-limited', async () => {
    mockVerifyApiKey.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: 'Per-minute rate limit exceeded.',
      rateLimitHeaders: {
        'X-RateLimit-Limit': '10',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1700000060',
        'Retry-After': '15',
      },
    })
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.status).toBe(429)
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(res.headers.get('retry-after')).toBe('15')
  })

  it('503 surfaces from auth when Supabase is unreachable', async () => {
    mockVerifyApiKey.mockResolvedValueOnce({ ok: false, status: 503, error: 'Auth backend unavailable.' })
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.status).toBe(503)
  })
})

describe('GET /api/v1/quote — input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
    mockVerifyApiKey.mockResolvedValue(authSuccess())
  })

  it('400 when tokenIn is missing', async () => {
    const res = await GET(makeRequest({ tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Missing required params/)
  })

  it('400 when tokenIn is not a valid address', async () => {
    const res = await GET(makeRequest({ tokenIn: 'not-an-address', tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/valid 0x-prefixed 20-byte/)
  })

  it('400 when amount is non-numeric', async () => {
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: 'NaN' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/positive decimal-integer/)
  })

  it('400 when amount is zero', async () => {
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '0' }))
    expect(res.status).toBe(400)
  })

  it('400 when slippage is out of range', async () => {
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1', slippage: '60' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/slippage/)
  })

  it('400 when chainId is not 1', async () => {
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1', chainId: '137' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/chainId/)
  })

  it('accepts slippage=0', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce(metaQuoteFixture())
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1', slippage: '0' }))
    expect(res.status).toBe(200)
  })
})

describe('GET /api/v1/quote — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
    mockVerifyApiKey.mockResolvedValue(authSuccess())
  })

  it('returns 200 with best, quotes[], and meta block', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce(metaQuoteFixture('1inch'))
    const res = await GET(makeRequest({
      tokenIn: VALID_TOKEN_IN,
      tokenOut: VALID_TOKEN_OUT,
      amount: '1000000000000000000',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.best.source).toBe('1inch')
    expect(body.best.toAmount).toBe('2950420000')
    expect(body.quotes).toHaveLength(2)
    expect(body.meta.sourcesResponded).toBe(2)
    expect(body.meta.sourcesQueried).toBeGreaterThanOrEqual(2)
    expect(body.meta.timestamp).toMatch(/^2023-/) // ISO from fetchedAt 1700000000000
    expect(body.meta.mevProtected).toBe(false) // 1inch is not MEV-protected
    expect(body.meta.slippage).toBe(0.5) // default
    expect(body.meta.chainId).toBe(1)
  })

  it('mevProtected=true when best.source is cowswap', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce(metaQuoteFixture('cowswap'))
    const res = await GET(makeRequest({
      tokenIn: VALID_TOKEN_IN,
      tokenOut: VALID_TOKEN_OUT,
      amount: '1000000000000000000',
    }))
    const body = await res.json()
    expect(body.meta.mevProtected).toBe(true)
  })

  it('echoes the requested slippage in meta', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce(metaQuoteFixture())
    const res = await GET(makeRequest({
      tokenIn: VALID_TOKEN_IN,
      tokenOut: VALID_TOKEN_OUT,
      amount: '1',
      slippage: '1.25',
    }))
    const body = await res.json()
    expect(body.meta.slippage).toBe(1.25)
  })

  it('forwards X-RateLimit-* headers from auth on 200', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce(metaQuoteFixture())
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.headers.get('x-ratelimit-limit')).toBe('10')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9')
  })

  it('includes CORS Allow-Origin on success', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce(metaQuoteFixture())
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('passes crossQuoteWarning + crossQuoteDeviation through when present', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce({
      ...metaQuoteFixture(),
      crossQuoteDeviation: 0.07,
      crossQuoteWarning: true,
    })
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    const body = await res.json()
    expect(body.meta.crossQuoteWarning).toBe(true)
    expect(body.meta.crossQuoteDeviation).toBeCloseTo(0.07)
  })

  it('upstream "rate limit" error → 429 (global limiter overflow)', async () => {
    mockFetchMetaQuote.mockRejectedValueOnce(new Error('Rate limited — too many requests.'))
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.status).toBe(429)
  })

  it('upstream non-rate-limit error → 502', async () => {
    mockFetchMetaQuote.mockRejectedValueOnce(new Error('all adapters timed out'))
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    expect(res.status).toBe(502)
  })

  // [P97] Gasless overlay — always present on the response so consumers
  // don't have to branch on undefined.
  it('gasless.available=false when no CoW quote is in the response', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce(metaQuoteFixture('1inch'))
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    const body = await res.json()
    expect(body.gasless).toBeDefined()
    expect(body.gasless.available).toBe(false)
    expect(body.gasless.recommended).toBe(false)
    expect(body.gasless.gasSavingsUsd).toBe(0)
  })

  it('gasless.recommended=true when CoW is competitive against the best non-CoW route', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce({
      best: { source: '1inch', toAmount: '1000', estimatedGas: 150000, gasUsd: 5, routes: [] },
      all: [
        { source: '1inch', toAmount: '1000', estimatedGas: 150000, gasUsd: 5, routes: [] },
        { source: 'cowswap', toAmount: '997', estimatedGas: 0, gasUsd: 0, routes: [] },
      ],
      fetchedAt: 1700000000_000,
    })
    const res = await GET(makeRequest({ tokenIn: VALID_TOKEN_IN, tokenOut: VALID_TOKEN_OUT, amount: '1' }))
    const body = await res.json()
    expect(body.gasless.available).toBe(true)
    expect(body.gasless.recommended).toBe(true)
    expect(body.gasless.gasSavingsUsd).toBeGreaterThan(0)
    expect(body.gasless.reason.length).toBeGreaterThan(0)
  })
})
