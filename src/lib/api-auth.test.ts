/**
 * [P177] Unit tests for src/lib/api-auth.ts.
 *
 * `verifyApiKey` is the authentication gate for every /v1/* public API
 * route. Misbehaviour either lets through revoked keys or rate-limit
 * abuse, or wrongly 401s legitimate paying users — both bad. This file
 * pins every branch of the auth state machine plus the SHA-256 digest
 * function used to look keys up.
 *
 * 11-M-03: the rejection message for "not found / revoked / expired"
 * must be uniform — distinct strings would let an attacker enumerate
 * which hashes exist and what state they're in. The success-path test
 * also asserts that the fire-and-forget usage bump fires (Supabase
 * `update` is called) but does not block the response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (hoisted before any imports of the module under test) ──

const mockGetSupabase = vi.fn()
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}))

const mockCheckRateLimit = vi.fn()
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

// ── Import after mocks ───────────────────────────────────

import { hashApiKey, verifyApiKey, type ApiKeyRow } from './api-auth'

// ── Helpers ──────────────────────────────────────────────

// Minimal NextRequest stand-in. We only ever read .headers.get(name), so a
// hand-rolled object satisfies the call surface without spinning up the
// real next/server constructor.
type ReqLike = { headers: { get: (name: string) => string | null } }
function mockRequest(apiKey?: string): ReqLike {
  return {
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === 'x-api-key') return apiKey ?? null
        return null
      },
    },
  }
}

interface MockClientControls {
  row: Partial<ApiKeyRow> | null
  error: { message: string } | null
  maybeSingleThrows: boolean
  updateSpy: ReturnType<typeof vi.fn>
}

// Build a chainable mock Supabase client. The lookup path is
//   .from(...).select(...).eq(...).maybeSingle()
// and the bumpUsage path is
//   .from(...).select(...).eq(...).single()
// followed by
//   .from(...).update(...).eq(...)
// Both are routed through the same builder so the test can assert that
// the success path triggers the update.
function makeSupabase(controls: MockClientControls) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => {
      if (controls.maybeSingleThrows) throw new Error('network exploded')
      return { data: controls.row, error: controls.error }
    }),
    single: vi.fn(async () => ({
      data: controls.row ? { total_requests: controls.row.total_requests ?? 0 } : null,
      error: null,
    })),
    update: controls.updateSpy,
  }
  return {
    from: vi.fn(() => builder),
  }
}

function validRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 'fixture-id',
    key_hash: 'h'.repeat(64),
    name: 'fixture',
    tier: 'free',
    rate_limit_per_min: 60,
    rate_limit_per_day: 10_000,
    is_active: true,
    created_at: new Date().toISOString(),
    expires_at: null,
    last_used_at: null,
    total_requests: 0,
    ...overrides,
  }
}

function allowedRateLimit() {
  return { allowed: true, remaining: 59, resetAt: Date.now() + 60_000 }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockReset()
  mockGetSupabase.mockReset()
})

// ─────────────────────────────────────────────────────────
// hashApiKey
// ─────────────────────────────────────────────────────────

describe('hashApiKey', () => {
  it('returns a 64-char lowercase hex string', () => {
    const out = hashApiKey('tsk_anything_at_all')
    expect(out).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic — same input yields the same hash', () => {
    expect(hashApiKey('tsk_abc')).toBe(hashApiKey('tsk_abc'))
  })

  it('different inputs yield different hashes', () => {
    expect(hashApiKey('tsk_a')).not.toBe(hashApiKey('tsk_b'))
  })

  it('matches the known SHA-256 digest of an empty string', () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hashApiKey('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

// ─────────────────────────────────────────────────────────
// verifyApiKey
// ─────────────────────────────────────────────────────────

describe('verifyApiKey', () => {
  describe('header validation', () => {
    it('401s when the X-API-Key header is missing', async () => {
      const result = await verifyApiKey(mockRequest() as never)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(401)
        expect(result.error).toMatch(/Missing X-API-Key/)
      }
      // Supabase must NOT be consulted when the header is absent.
      expect(mockGetSupabase).not.toHaveBeenCalled()
    })

    it('401s when the header is present but empty / whitespace', async () => {
      const result = await verifyApiKey(mockRequest('   ') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(401)
    })
  })

  describe('Supabase availability', () => {
    it('503s when getSupabase() returns null', async () => {
      mockGetSupabase.mockReturnValueOnce(null)
      const result = await verifyApiKey(mockRequest('tsk_abc') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(503)
        expect(result.error).toMatch(/unavailable/)
      }
    })

    it('503s when the Supabase lookup returns an error object', async () => {
      mockGetSupabase.mockReturnValueOnce(
        makeSupabase({
          row: null,
          error: { message: 'connection refused' },
          maybeSingleThrows: false,
          updateSpy: vi.fn(),
        }),
      )
      const result = await verifyApiKey(mockRequest('tsk_abc') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(503)
    })

    it('503s when the Supabase lookup throws', async () => {
      mockGetSupabase.mockReturnValueOnce(
        makeSupabase({
          row: null,
          error: null,
          maybeSingleThrows: true,
          updateSpy: vi.fn(),
        }),
      )
      const result = await verifyApiKey(mockRequest('tsk_abc') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(503)
    })
  })

  describe('key state — unified 401 rejection', () => {
    const UNIFIED = 'Invalid or inactive API key.'

    it('401s with the unified message when no key matches', async () => {
      mockGetSupabase.mockReturnValueOnce(
        makeSupabase({
          row: null,
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(),
        }),
      )
      const result = await verifyApiKey(mockRequest('tsk_unknown') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(401)
        expect(result.error).toBe(UNIFIED)
      }
    })

    it('401s with the unified message when the key is revoked', async () => {
      mockGetSupabase.mockReturnValueOnce(
        makeSupabase({
          row: validRow({ is_active: false }),
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(),
        }),
      )
      const result = await verifyApiKey(mockRequest('tsk_revoked') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(401)
        expect(result.error).toBe(UNIFIED)
      }
    })

    it('401s with the unified message when the key is expired', async () => {
      mockGetSupabase.mockReturnValueOnce(
        makeSupabase({
          row: validRow({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(),
        }),
      )
      const result = await verifyApiKey(mockRequest('tsk_expired') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(401)
        expect(result.error).toBe(UNIFIED)
      }
    })
  })

  describe('rate limiting', () => {
    it('429s with Retry-After when the per-minute window is exhausted', async () => {
      const resetAt = Date.now() + 30_000
      mockGetSupabase.mockReturnValueOnce(
        makeSupabase({
          row: validRow(),
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(),
        }),
      )
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt })

      const result = await verifyApiKey(mockRequest('tsk_abc') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(429)
        expect(result.rateLimitHeaders?.['Retry-After']).toBeDefined()
        expect(Number(result.rateLimitHeaders?.['Retry-After'])).toBeGreaterThan(0)
        // Day window should NOT have been consulted after a minute-window fail.
        expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
      }
    })

    it('429s when the per-day window is exhausted (after minute passes)', async () => {
      const resetAt = Date.now() + 600_000
      mockGetSupabase.mockReturnValueOnce(
        makeSupabase({
          row: validRow(),
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(),
        }),
      )
      mockCheckRateLimit
        .mockResolvedValueOnce(allowedRateLimit()) // minute window OK
        .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt }) // day window blocked

      const result = await verifyApiKey(mockRequest('tsk_abc') as never)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(429)
        expect(result.error).toMatch(/Daily/)
        expect(result.rateLimitHeaders?.['Retry-After']).toBeDefined()
      }
    })
  })

  describe('success path + tier mapping', () => {
    it("returns ok with the key id/name + minute-window rate-limit headers", async () => {
      const updateSpy = vi.fn(() => ({ eq: vi.fn(async () => ({})) }))
      const row = validRow({ tier: 'free', rate_limit_per_min: 60 })
      mockGetSupabase.mockReturnValue(
        makeSupabase({ row, error: null, maybeSingleThrows: false, updateSpy }),
      )
      mockCheckRateLimit.mockResolvedValue(allowedRateLimit())

      const result = await verifyApiKey(mockRequest('tsk_valid') as never)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.keyId).toBe(row.id)
        expect(result.keyName).toBe(row.name)
        expect(result.tier).toBe('free')
        expect(result.rateLimitHeaders['X-RateLimit-Limit']).toBe('60')
        expect(result.rateLimitHeaders['X-RateLimit-Remaining']).toBe('59')
      }

      // bumpUsage is fire-and-forget; flush the microtask queue so the
      // .single() + .update() chain runs before the assertion.
      await new Promise((r) => setImmediate(r))
      expect(updateSpy).toHaveBeenCalledTimes(1)
    })

    it("returns 'pro' tier when stored as 'pro'", async () => {
      mockGetSupabase.mockReturnValue(
        makeSupabase({
          row: validRow({ tier: 'pro' }),
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(() => ({ eq: vi.fn(async () => ({})) })),
        }),
      )
      mockCheckRateLimit.mockResolvedValue(allowedRateLimit())
      const result = await verifyApiKey(mockRequest('tsk_pro') as never)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.tier).toBe('pro')
    })

    it("returns 'enterprise' tier when stored as 'enterprise'", async () => {
      mockGetSupabase.mockReturnValue(
        makeSupabase({
          row: validRow({ tier: 'enterprise' }),
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(() => ({ eq: vi.fn(async () => ({})) })),
        }),
      )
      mockCheckRateLimit.mockResolvedValue(allowedRateLimit())
      const result = await verifyApiKey(mockRequest('tsk_ent') as never)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.tier).toBe('enterprise')
    })

    it("defaults to 'free' tier when the stored tier is unrecognised", async () => {
      mockGetSupabase.mockReturnValue(
        makeSupabase({
          row: validRow({ tier: 'mystery-tier' }),
          error: null,
          maybeSingleThrows: false,
          updateSpy: vi.fn(() => ({ eq: vi.fn(async () => ({})) })),
        }),
      )
      mockCheckRateLimit.mockResolvedValue(allowedRateLimit())
      const result = await verifyApiKey(mockRequest('tsk_weird') as never)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.tier).toBe('free')
    })
  })
})
