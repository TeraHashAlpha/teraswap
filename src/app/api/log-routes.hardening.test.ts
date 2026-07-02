/**
 * [AUDIT-W6 / W6-M-02 + W6-L-01] log-* ingestion hardening.
 *
 * The four telemetry routes are unauthenticated by design (public
 * fire-and-forget), which made them an unbounded-Supabase-insert vector:
 * spam, analytics poisoning, DB cost. Each now:
 *   - enforces a shared per-IP rate limit (`log:<ip>`) BEFORE any insert → 429,
 *   - refuses oversized bodies via the shared body-size guard → 413.
 *
 * Success paths stay as before (log-swap's own route.test.ts pins its insert
 * shape; both files run in the api-hardening-guard CI job).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Supabase mock (both roles resolve to the same inert chain) ──────────────
const supabaseChain = {
  from: vi.fn().mockReturnThis(),
  insert: vi.fn(async () => ({ error: null })),
  update: vi.fn().mockReturnThis(),
  eq: vi.fn(async () => ({ error: null })),
}
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => supabaseChain,
  getSupabaseLogger: () => supabaseChain,
}))

// ── Side-effect stubs (log-swap / log-quote deps) ───────────────────────────
vi.mock('@/lib/chainlink', () => ({ computeTokenAmountUsd: vi.fn(async () => null) }))
vi.mock('@/lib/wallet-activity-server', () => ({ trackWalletAction: vi.fn() }))
vi.mock('@/lib/security-tracker', () => ({
  trackLargeTrade: vi.fn(),
  trackSwapFailed: vi.fn(),
  trackOracleDeviation: vi.fn(),
  trackOracleUnavailable: vi.fn(),
  trackQuoteFailure: vi.fn(),
}))

// ── KV rate limiter mock (constants stay real) ──────────────────────────────
const mockCheckRateLimit = vi.fn(async (..._args: unknown[]) => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return { ...actual, checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args) }
})

import { POST as postLogEvent } from './log-event/route'
import { POST as postLogActivity } from './log-activity/route'
import { POST as postLogQuote } from './log-quote/route'
import { POST as postLogSwap } from './log-swap/route'

const ROUTES: Array<[string, (req: NextRequest) => Promise<Response>]> = [
  ['log-event', postLogEvent as (req: NextRequest) => Promise<Response>],
  ['log-activity', postLogActivity as (req: NextRequest) => Promise<Response>],
  ['log-quote', postLogQuote],
  ['log-swap', postLogSwap],
]

function makeReq(name: string, body: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })
}

beforeEach(() => {
  mockCheckRateLimit.mockClear()
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 })
})

describe.each(ROUTES)('POST /api/%s — W6-M-02 + W6-L-01', (name, handler) => {
  it('returns 429 JSON when the shared per-IP log budget is exhausted', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    const res = await handler(makeReq(name, '{"events":[]}', { 'x-forwarded-for': '6.6.6.6' }))
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error).toMatch(/rate limit/i)
  })

  it('shares one per-IP budget across the log routes (key = log:<ip>)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    await handler(makeReq(name, '{}', { 'x-forwarded-for': '7.7.7.7' }))
    expect(mockCheckRateLimit).toHaveBeenCalledWith('log:7.7.7.7', expect.any(Number), expect.any(Number))
  })

  it('refuses an oversized body with 413 before any parsing', async () => {
    const res = await handler(makeReq(name, '{}', { 'content-length': '50000' }))
    expect(res.status).toBe(413)
  })

  it('does not block normal telemetry when the budget is available', async () => {
    const res = await handler(makeReq(name, '{"events":[]}'))
    expect(res.status).not.toBe(429)
    expect(res.status).not.toBe(413)
    expect(res.status).toBeLessThan(500)
  })
})
