/**
 * Unit tests for POST /api/admin/kill-switch.
 *
 * Covers: auth (401/503), invalid sourceId (404), valid kill (200),
 * idempotent re-kill (200), rate limit (429), POST only (405 via Next.js),
 * audit trail writes, reason formatting, constant-time token comparison.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Simulated KV store ─────────────────────────────────

const kvStore = new Map<string, unknown>()
const kvSets = new Map<string, Set<string>>()

function getSet(key: string): Set<string> {
  if (!kvSets.has(key)) kvSets.set(key, new Set())
  return kvSets.get(key)!
}

const mockKvGet = vi.fn(async (key: string) => kvStore.get(key) ?? null)
const mockKvSet = vi.fn(async (key: string, value: unknown) => { kvStore.set(key, value) })
const mockKvSmembers = vi.fn(async (key: string) => Array.from(getSet(key)))

const mockPipelineSet = vi.fn((key: string, value: unknown) => { kvStore.set(key, value) })
const mockPipelineSadd = vi.fn((key: string, member: string) => { getSet(key).add(member) })
const mockPipelineExec = vi.fn(async () => [])
const mockPipelineDel = vi.fn()

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    set: (...args: unknown[]) => mockKvSet(...(args as [string, unknown])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    pipeline: () => ({
      set: (...args: unknown[]) => { mockPipelineSet(...(args as [string, unknown])); return { sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel } },
      sadd: (...args: unknown[]) => { mockPipelineSadd(...(args as [string, string])); return { set: mockPipelineSet, exec: mockPipelineExec, del: mockPipelineDel } },
      del: (...args: unknown[]) => { mockPipelineDel(...args); return { set: mockPipelineSet, sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel } },
      exec: mockPipelineExec,
    }),
  },
}))

// ── Mock alert-wrapper (fire-and-forget, tested separately) ──

vi.mock('@/lib/alert-wrapper', () => ({
  emitTransitionAlert: vi.fn().mockResolvedValue(undefined),
}))

// ── Import route after mocks ───────────────────────────

import { POST, _internal } from './route'
import { beginTick } from '@/lib/source-state-machine'

// ── Helpers ─────────────────────────────────────────────

const originalEnv = { ...process.env }

function makeRequest(
  body: Record<string, unknown>,
  token?: string,
  headers?: Record<string, string>,
): NextRequest {
  const req = new NextRequest('https://teraswap.app/api/admin/kill-switch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return req
}

function seedSource(sourceId: string, state: string = 'active'): void {
  getSet('teraswap:source-state:index').add(sourceId)
  kvStore.set(`teraswap:source-state:${sourceId}`, {
    id: sourceId,
    state,
    lastCheckAt: Date.now(),
    failureCount: 0,
    successCount: 0,
    latencyHistory: [],
    lastTransitionAt: Date.now(),
  })
}

// ═══════════════════════════════════════════════════════════════

describe('POST /api/admin/kill-switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    _internal.rateLimitMap.clear()
    beginTick() // Clear source-state-machine tick cache between tests
    process.env = { ...originalEnv, KILL_SWITCH_SECRET: 'test-secret-abc123' }
  })

  // ── Auth ──────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 503 when KILL_SWITCH_SECRET is not configured', async () => {
      delete process.env.KILL_SWITCH_SECRET
      const req = makeRequest({ sourceId: 'cowswap' }, 'some-token')
      const res = await POST(req)
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('kill-switch not configured')
    })

    it('returns 401 when no Authorization header', async () => {
      const req = makeRequest({ sourceId: 'cowswap' })
      const res = await POST(req)
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
    })

    it('returns 401 when token is wrong', async () => {
      const req = makeRequest({ sourceId: 'cowswap' }, 'wrong-token-xyz')
      const res = await POST(req)
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
    })

    it('returns same error shape for missing vs wrong token (no info leakage)', async () => {
      const noToken = makeRequest({ sourceId: 'cowswap' })
      const wrongToken = makeRequest({ sourceId: 'cowswap' }, 'wrong')

      const res1 = await POST(noToken)
      const res2 = await POST(wrongToken)

      expect(res1.status).toBe(401)
      expect(res2.status).toBe(401)

      const body1 = await res1.json()
      const body2 = await res2.json()
      expect(body1).toEqual(body2)
      expect(body1).toEqual({ error: 'unauthorized' })
    })
  })

  // ── Token comparison ──────────────────────────────────

  describe('constant-time comparison', () => {
    it('verifyToken returns true for matching tokens', () => {
      expect(_internal.verifyToken('abc123', 'abc123')).toBe(true)
    })

    it('verifyToken returns false for non-matching tokens', () => {
      expect(_internal.verifyToken('abc123', 'xyz789')).toBe(false)
    })

    it('verifyToken returns false for different-length tokens', () => {
      expect(_internal.verifyToken('short', 'much-longer-token')).toBe(false)
    })
  })

  // ── Validation ────────────────────────────────────────

  describe('request validation', () => {
    it('returns 400 when sourceId is missing', async () => {
      const req = makeRequest({}, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('sourceId is required')
    })

    it('returns 400 when sourceId is not a string', async () => {
      const req = makeRequest({ sourceId: 42 }, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('sourceId is required')
    })

    it('returns 404 when sourceId is not in source index', async () => {
      const req = makeRequest({ sourceId: 'nonexistent' }, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('source not found')
    })

    it('returns 400 for invalid JSON body', async () => {
      const req = new NextRequest('https://teraswap.app/api/admin/kill-switch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-secret-abc123',
        },
        body: 'not-json{{{',
      })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid JSON body')
    })
  })

  // ── Successful kill ───────────────────────────────────

  describe('successful kill-switch', () => {
    it('returns 200 and disables source with custom reason', async () => {
      seedSource('cowswap', 'active')
      const req = makeRequest(
        { sourceId: 'cowswap', reason: 'Confirmed frontend exploit' },
        'test-secret-abc123',
      )
      const res = await POST(req)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.sourceId).toBe('cowswap')
      expect(body.state).toBe('disabled')
      expect(body.reason).toBe('kill-switch-triggered: Confirmed frontend exploit')
      expect(body.timestamp).toBeDefined()
    })

    it('returns 200 with bare kill-switch-triggered when no reason given', async () => {
      seedSource('1inch', 'degraded')
      const req = makeRequest({ sourceId: '1inch' }, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.reason).toBe('kill-switch-triggered')
    })

    it('is idempotent — re-killing already disabled source returns 200', async () => {
      seedSource('cowswap', 'active')

      // First kill
      const req1 = makeRequest(
        { sourceId: 'cowswap', reason: 'exploit' },
        'test-secret-abc123',
      )
      const res1 = await POST(req1)
      expect(res1.status).toBe(200)

      // Second kill — same source, already disabled
      const req2 = makeRequest(
        { sourceId: 'cowswap', reason: 'exploit — confirmed again' },
        'test-secret-abc123',
      )
      const res2 = await POST(req2)
      expect(res2.status).toBe(200)
      const body2 = await res2.json()
      expect(body2.success).toBe(true)
      expect(body2.state).toBe('disabled')
    })

    it('works on degraded source', async () => {
      seedSource('velora', 'degraded')
      const req = makeRequest({ sourceId: 'velora' }, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.state).toBe('disabled')
    })
  })

  // ── Audit trail ───────────────────────────────────────

  describe('audit trail', () => {
    it('writes audit entry to KV on successful kill', async () => {
      seedSource('cowswap', 'active')
      const req = makeRequest(
        { sourceId: 'cowswap', reason: 'DNS hijack confirmed' },
        'test-secret-abc123',
      )
      await POST(req)

      // Check audit entry was written via pipeline
      const auditEntries = Array.from(kvStore.entries())
        .filter(([key]) => key.startsWith('teraswap:audit:kill-switch:') && key !== 'teraswap:audit:kill-switch:index')

      expect(auditEntries.length).toBeGreaterThanOrEqual(1)
      const [, entry] = auditEntries[0]
      const audit = entry as Record<string, unknown>
      expect(audit.sourceId).toBe('cowswap')
      expect(audit.reason).toBe('kill-switch-triggered: DNS hijack confirmed')
      expect(audit.triggeredBy).toBe('api')
      expect(audit.previousState).toBe('active')
      expect(audit.timestamp).toBeDefined()
    })

    it('writes audit entry even on idempotent re-kill', async () => {
      seedSource('cowswap', 'active')

      // First kill
      await POST(makeRequest({ sourceId: 'cowswap', reason: 'first' }, 'test-secret-abc123'))

      // Count audit entries
      const countBefore = Array.from(kvStore.keys())
        .filter(k => k.startsWith('teraswap:audit:kill-switch:2')).length

      // Second kill (idempotent)
      await POST(makeRequest({ sourceId: 'cowswap', reason: 'second' }, 'test-secret-abc123'))

      const countAfter = Array.from(kvStore.keys())
        .filter(k => k.startsWith('teraswap:audit:kill-switch:2')).length

      expect(countAfter).toBeGreaterThan(countBefore)
    })

    it('adds audit key to index set', async () => {
      seedSource('cowswap', 'active')
      await POST(makeRequest({ sourceId: 'cowswap' }, 'test-secret-abc123'))

      const indexSet = getSet('teraswap:audit:kill-switch:index')
      expect(indexSet.size).toBeGreaterThanOrEqual(1)
      const keys = Array.from(indexSet)
      expect(keys[0]).toMatch(/^teraswap:audit:kill-switch:\d{4}/)
    })
  })

  // ── Rate limiting ─────────────────────────────────────

  describe('rate limiting', () => {
    it('returns 429 after exceeding 10 requests per minute', async () => {
      seedSource('cowswap', 'active')

      // Exhaust the rate limit (10 requests allowed)
      for (let i = 0; i < _internal.RATE_LIMIT_MAX; i++) {
        const req = makeRequest({ sourceId: 'cowswap' }, 'test-secret-abc123')
        const res = await POST(req)
        // First 10 should succeed (200) since source exists and auth is valid
        expect(res.status).toBe(200)
      }

      // 11th request → rate limited
      const req = makeRequest({ sourceId: 'cowswap' }, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(429)
      const body = await res.json()
      expect(body.error).toBe('rate limited')
    })

    it('rate limit applies before auth check (prevents brute force)', async () => {
      // Exhaust rate limit with wrong tokens
      for (let i = 0; i < _internal.RATE_LIMIT_MAX; i++) {
        const req = makeRequest({ sourceId: 'cowswap' }, 'wrong-token')
        await POST(req)
      }

      // 11th request with CORRECT token → still rate limited
      const req = makeRequest({ sourceId: 'cowswap' }, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(429)
    })
  })

  // ── Reason formatting ─────────────────────────────────

  describe('reason formatting', () => {
    it('prefixes custom reason with kill-switch-triggered:', async () => {
      seedSource('cowswap', 'active')
      const req = makeRequest(
        { sourceId: 'cowswap', reason: 'CoW DNS hijack 2026-04-14' },
        'test-secret-abc123',
      )
      const res = await POST(req)
      const body = await res.json()
      expect(body.reason).toBe('kill-switch-triggered: CoW DNS hijack 2026-04-14')
    })

    it('uses bare kill-switch-triggered when reason is empty string', async () => {
      seedSource('cowswap', 'active')
      const req = makeRequest({ sourceId: 'cowswap', reason: '' }, 'test-secret-abc123')
      const res = await POST(req)
      const body = await res.json()
      expect(body.reason).toBe('kill-switch-triggered')
    })

    it('uses bare kill-switch-triggered when reason is omitted', async () => {
      seedSource('cowswap', 'active')
      const req = makeRequest({ sourceId: 'cowswap' }, 'test-secret-abc123')
      const res = await POST(req)
      const body = await res.json()
      expect(body.reason).toBe('kill-switch-triggered')
    })
  })

  // ── KV failure handling ───────────────────────────────

  describe('KV failure handling', () => {
    it('returns 503 when KV smembers fails', async () => {
      mockKvSmembers.mockRejectedValueOnce(new Error('Connection refused'))

      const req = makeRequest({ sourceId: 'cowswap' }, 'test-secret-abc123')
      const res = await POST(req)
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('KV unavailable')
    })
  })
})
