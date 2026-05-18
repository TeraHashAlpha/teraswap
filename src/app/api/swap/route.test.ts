/**
 * Unit tests for POST /api/swap — full validation branch coverage.
 *
 * [P121] (Sprint 17) covered the source allow-list guard.
 * [P127] (Sprint 19B) closes 17-I-02 by adding tests for the remaining
 * validation branches: V1 circuit breaker, V2 content-length, V3 missing
 * fields, V5 rate limit, V6 address format, V7 slippage, V8 swap selector,
 * V9 recipient mismatch, V11/V11b price guard, V12 upstream fetch error,
 * plus a happy-path with oracle data attachment.
 *
 * Every mock has a safe default; individual tests use `mockResolvedValueOnce`
 * / `mockReturnValueOnce` to override per-test without leaking state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks ─────────────────────────────────────────────────

const mockIsSystemHalted = vi.fn().mockResolvedValue(false)
vi.mock('@/lib/circuit-breaker', () => ({
  isSystemHalted: () => mockIsSystemHalted(),
}))

const mockCheckRateLimit = vi.fn().mockResolvedValue({
  allowed: true,
  remaining: 99,
  resetAt: Date.now() + 60_000,
})
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  SWAP_RATE_LIMIT: { limit: 100, windowMs: 60_000 },
}))

const mockFetchSwapFromSource = vi.fn()
vi.mock('@/lib/api', () => ({
  fetchSwapFromSource: (...args: unknown[]) => mockFetchSwapFromSource(...args),
}))

const mockIsKnownSwapSelector = vi.fn().mockReturnValue(true)
vi.mock('@/lib/swap-selectors', () => ({
  isKnownSwapSelector: (...args: unknown[]) => mockIsKnownSwapSelector(...args),
  getSelector: (data: string) => data.slice(0, 10),
}))

const mockValidateCallDataRecipient = vi.fn().mockReturnValue({
  valid: true,
  extracted: null,
  implicitRecipient: true,
})
vi.mock('@/lib/calldata-recipient', () => ({
  validateCallDataRecipient: (...args: unknown[]) => mockValidateCallDataRecipient(...args),
}))

const mockValidateSwapPrice = vi.fn().mockResolvedValue(null)
const mockFetchDefiLlamaPrice = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/defillama', () => ({
  validateSwapPrice: (...args: unknown[]) => mockValidateSwapPrice(...args),
  fetchDefiLlamaPrice: (...args: unknown[]) => mockFetchDefiLlamaPrice(...args),
  HIGH_VALUE_THRESHOLD_USD: 10_000,
}))

// ── Import after mocks ────────────────────────────────────

import { POST } from './route'

// ── Helpers ───────────────────────────────────────────────

function makeRequest(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
}

const VALID_BASE = {
  src: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  dst: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  amount: '1000000000000000000',
  from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  slippage: 0.5,
}

const VALID_SWAP_RESULT = {
  toAmount: '2950000000',
  tx: {
    to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
    data: '0x12aa3caf' + '0'.repeat(200),
    value: '0',
  },
}

beforeEach(() => {
  mockCheckRateLimit.mockClear()
  mockFetchSwapFromSource.mockReset()
  mockIsSystemHalted.mockClear().mockResolvedValue(false)
  mockIsKnownSwapSelector.mockClear().mockReturnValue(true)
  mockValidateCallDataRecipient.mockClear().mockReturnValue({
    valid: true,
    extracted: null,
    implicitRecipient: true,
  })
  mockValidateSwapPrice.mockClear().mockResolvedValue(null)
  mockFetchDefiLlamaPrice.mockClear().mockResolvedValue(null)
})

// ── Tests ─────────────────────────────────────────────────

describe('POST /api/swap — source allow-list [P121]', () => {
  it('proceeds normally for a known source (1inch)', async () => {
    mockFetchSwapFromSource.mockResolvedValue(VALID_SWAP_RESULT)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(200)
    expect(mockFetchSwapFromSource).toHaveBeenCalledTimes(1)
    expect(mockFetchSwapFromSource.mock.calls[0][0]).toBe('1inch')
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown source with 400 INVALID_SOURCE and skips rate-limit + upstream fetch', async () => {
    const res = await POST(makeRequest({ source: 'evil-router', ...VALID_BASE }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_SOURCE')
    expect(body.error).toContain('Unknown aggregator source')
    // Guard fired BEFORE rate-limit deduction (don't burn budget on invalid input)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    // Guard fired BEFORE upstream call
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V1 circuit breaker halt [P127]', () => {
  it('returns 503 with halted:true and Retry-After header when system halted', async () => {
    mockIsSystemHalted.mockResolvedValueOnce(true)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.halted).toBe(true)
    expect(res.headers.get('Retry-After')).toBe('300')
    // Early exit: no downstream call
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V2 request body too large [P127]', () => {
  it('returns 413 when Content-Length exceeds 10KB limit', async () => {
    const res = await POST(
      makeRequest(
        { source: '1inch', ...VALID_BASE },
        { 'content-length': '99999' },
      ),
    )
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toContain('too large')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V3 missing required fields [P127]', () => {
  it('returns 400 when source field is missing', async () => {
    const { src, dst, amount, from, slippage } = VALID_BASE
    const res = await POST(makeRequest({ src, dst, amount, from, slippage }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing required fields')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V5 rate limit exceeded [P127]', () => {
  it('returns 429 with rate limit headers when limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toContain('Rate limit')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V6 invalid address format [P127]', () => {
  it('returns 400 when src address is malformed', async () => {
    const res = await POST(
      makeRequest({ ...VALID_BASE, source: '1inch', src: 'not-an-address' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V7 slippage out of range [P127]', () => {
  it('returns 400 when slippage exceeds 15%', async () => {
    const res = await POST(
      makeRequest({ ...VALID_BASE, source: '1inch', slippage: 50 }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Slippage must be between')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })

  it('returns 400 when slippage is NaN', async () => {
    const res = await POST(
      makeRequest({ ...VALID_BASE, source: '1inch', slippage: 'abc' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Slippage must be between')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V8 unknown swap selector [P127]', () => {
  it('returns 400 with selector in response when function selector is unknown', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce({
      toAmount: '2950000000',
      tx: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdeadbeef' + '0'.repeat(200),
        value: '0',
      },
    })
    mockIsKnownSwapSelector.mockReturnValueOnce(false)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Unknown swap function selector')
    expect(typeof body.selector).toBe('string')
    expect(body.selector.startsWith('0x')).toBe(true)
  })
})

describe('POST /api/swap — V9 calldata recipient mismatch [P127]', () => {
  it('returns 400 when recipient does not match requesting wallet', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockValidateCallDataRecipient.mockReturnValueOnce({
      valid: false,
      extracted: '0xAttAckEr000000000000000000000000DeAdBeEf',
      implicitRecipient: false,
      reason: 'Recipient mismatch',
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('recipient does not match')
  })
})

describe('POST /api/swap — V11 price guard: oracle deviation blocked [P127]', () => {
  it('returns 422 with priceGuard flag when price deviation exceeds threshold', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockValidateSwapPrice.mockResolvedValueOnce({
      valid: false,
      reason: 'Price deviation exceeds threshold',
      deviation: -0.125, // -12.5% (route multiplies by 100 for display)
      blocked: true,
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.priceGuard).toBe(true)
    expect(body.blocked).toBe(true)
  })
})

describe('POST /api/swap — V11b price guard: high-value oracle unavailable [P127]', () => {
  it('returns 422 priceGuard when high-value swap and oracle throws', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    // 1 WETH @ $50,000 = $50,000 estimatedValueUsd > $10,000 threshold.
    // Route reads tokenInPrice.price, so the mock returns { price } shape.
    mockFetchDefiLlamaPrice.mockResolvedValueOnce({ price: 50_000 })
    // Oracle throws → catch branch fires → high-value path returns 422.
    mockValidateSwapPrice.mockRejectedValueOnce(new Error('Oracle unreachable'))
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.priceGuard).toBe(true)
    expect(body.blocked).toBe(true)
  })
})

describe('POST /api/swap — V12 upstream fetch error [P127]', () => {
  it('returns 502 when fetchSwapFromSource throws', async () => {
    mockFetchSwapFromSource.mockRejectedValueOnce(new Error('1inch API timeout'))
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('1inch API timeout')
  })
})

describe('POST /api/swap — happy path with oracle attached [P127]', () => {
  it('returns 200 with oracle data attached when validation succeeds', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockValidateSwapPrice.mockResolvedValueOnce({
      valid: true,
      deviation: -0.012,
      oraclePriceIn: 3500,
      oraclePriceOut: 1.0,
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.oracleDeviation).toBeDefined()
    expect(body.oraclePriceIn).toBeDefined()
  })
})
