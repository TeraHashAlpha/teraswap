/**
 * Unit tests for POST /api/swap — focused on the [P121] source allow-list
 * guard. Mocks every downstream dependency so the test only exercises
 * request validation. The invalid-source test also asserts the guard
 * short-circuits BEFORE rate-limit deduction and the upstream fetch.
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

// Selector validation always passes — keeps the test focused on the guard.
vi.mock('@/lib/swap-selectors', () => ({
  isKnownSwapSelector: () => true,
  getSelector: (data: string) => data.slice(0, 10),
}))

// Recipient validation always passes.
vi.mock('@/lib/calldata-recipient', () => ({
  validateCallDataRecipient: () => ({ valid: true, extracted: null, implicitRecipient: true }),
}))

// DefiLlama price guard is a no-op for these tests.
vi.mock('@/lib/defillama', () => ({
  validateSwapPrice: vi.fn().mockResolvedValue(null),
  fetchDefiLlamaPrice: vi.fn().mockResolvedValue(null),
  HIGH_VALUE_THRESHOLD_USD: 10_000,
}))

// ── Import after mocks ────────────────────────────────────

import { POST } from './route'

// ── Helpers ───────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

beforeEach(() => {
  mockCheckRateLimit.mockClear()
  mockFetchSwapFromSource.mockReset()
  mockIsSystemHalted.mockClear().mockResolvedValue(false)
})

// ── Tests ─────────────────────────────────────────────────

describe('POST /api/swap — source allow-list [P121]', () => {
  it('proceeds normally for a known source (1inch)', async () => {
    mockFetchSwapFromSource.mockResolvedValue({
      toAmount: '2950000000',
      tx: { to: '0x1111111254EEB25477B68fb85Ed929f73A960582', data: '0x12aa3caf' + '0'.repeat(200), value: '0' },
    })
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
