/**
 * Unit tests for POST /api/admin/api-keys — [11-L-05] hard caps on
 * admin-configurable per-key rate limits.
 *
 * Pins: requests with absurdly large rateLimitPerMin / rateLimitPerDay
 * silently fall back to the tier default and surface a warning, instead
 * of minting an effectively unlimited key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Supabase mock — captures insert payload and returns a fake row ──

const insertCalls: Array<Record<string, unknown>> = []

const supabaseChain = {
  from: vi.fn().mockReturnThis(),
  insert: vi.fn((payload: Record<string, unknown>) => {
    insertCalls.push(payload)
    return supabaseChain
  }),
  select: vi.fn().mockReturnThis(),
  single: vi.fn(async () => ({
    data: {
      id: '00000000-0000-0000-0000-000000000001',
      name: insertCalls[insertCalls.length - 1]?.name,
      tier: insertCalls[insertCalls.length - 1]?.tier,
      rate_limit_per_min: insertCalls[insertCalls.length - 1]?.rate_limit_per_min,
      rate_limit_per_day: insertCalls[insertCalls.length - 1]?.rate_limit_per_day,
      is_active: true,
      created_at: new Date().toISOString(),
      expires_at: null,
    },
    error: null,
  })),
}

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => supabaseChain,
}))

vi.mock('@/lib/auth', () => ({
  verifyBearerToken: () => true,
}))

vi.mock('@/lib/api-auth', () => ({
  hashApiKey: (k: string) => `hash:${k}`,
}))

// ── Import after mocks ─────────────────────────────────────

import { POST } from './route'

function postKey(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://teraswap.app/api/admin/api-keys', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/api-keys — rate limit caps [11-L-05]', () => {
  beforeEach(() => {
    insertCalls.length = 0
    process.env.ADMIN_API_KEYS_SECRET = 'test-secret'
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('caps rateLimitPerMin: 50000 → falls back to tier default + warning', async () => {
    const res = await POST(postKey({ name: 'over-cap-min', tier: 'free', rateLimitPerMin: 50_000 }))
    expect(res.status).toBe(201)
    const json = await res.json()

    // Stored value is the tier default, NOT 50000.
    expect(json.rateLimitPerMin).not.toBe(50_000)
    expect(insertCalls[0].rate_limit_per_min).not.toBe(50_000)

    // Warning is present.
    expect(json.warnings).toBeDefined()
    expect(json.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('rateLimitPerMin capped at 10000')]),
    )
  })

  it('caps rateLimitPerDay: 2000000 → falls back to tier default + warning', async () => {
    const res = await POST(postKey({ name: 'over-cap-day', tier: 'free', rateLimitPerDay: 2_000_000 }))
    expect(res.status).toBe(201)
    const json = await res.json()

    expect(json.rateLimitPerDay).not.toBe(2_000_000)
    expect(insertCalls[0].rate_limit_per_day).not.toBe(2_000_000)
    expect(json.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('rateLimitPerDay capped at 1000000')]),
    )
  })

  it('accepts rateLimitPerMin: 100 as-is (no warning)', async () => {
    const res = await POST(postKey({ name: 'under-cap', tier: 'free', rateLimitPerMin: 100 }))
    expect(res.status).toBe(201)
    const json = await res.json()

    expect(json.rateLimitPerMin).toBe(100)
    expect(insertCalls[0].rate_limit_per_min).toBe(100)
    expect(json.warnings).toBeUndefined()
  })

  it('accepts rateLimitPerMin at the cap boundary (10000) as-is', async () => {
    const res = await POST(postKey({ name: 'at-cap', tier: 'free', rateLimitPerMin: 10_000 }))
    expect(res.status).toBe(201)
    const json = await res.json()

    expect(json.rateLimitPerMin).toBe(10_000)
    expect(json.warnings).toBeUndefined()
  })

  it('rejects unlimited-style abuse (999999999) → falls back + warning', async () => {
    const res = await POST(postKey({ name: 'abuse', tier: 'free', rateLimitPerMin: 999_999_999 }))
    expect(res.status).toBe(201)
    const json = await res.json()

    // Must NOT have persisted the unlimited value.
    expect(json.rateLimitPerMin).not.toBe(999_999_999)
    expect(insertCalls[0].rate_limit_per_min).not.toBe(999_999_999)
    expect(json.warnings?.length ?? 0).toBeGreaterThan(0)
  })

  it('combines warnings for over-cap min AND day', async () => {
    const res = await POST(postKey({
      name: 'over-both',
      tier: 'free',
      rateLimitPerMin: 100_000,
      rateLimitPerDay: 10_000_000,
    }))
    expect(res.status).toBe(201)
    const json = await res.json()

    expect(json.warnings).toHaveLength(2)
  })
})
