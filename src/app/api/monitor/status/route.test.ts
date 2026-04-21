/**
 * Unit tests for GET /api/monitor/status — public health endpoint.
 *
 * Covers: response shape, source sorting, p95 calculation, uptime %,
 * privacy (no internal fields leaked), KV failure → 503, edge caching header.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Simulated KV store ─────────────────────────────────

const kvStore = new Map<string, unknown>()
const kvSets = new Map<string, Set<string>>()

function getSet(key: string): Set<string> {
  if (!kvSets.has(key)) kvSets.set(key, new Set())
  return kvSets.get(key)!
}

const mockKvGet = vi.fn(async (key: string) => kvStore.get(key) ?? null)
const mockKvSmembers = vi.fn(async (key: string) => Array.from(getSet(key)))

const mockPipelineSet = vi.fn()
const mockPipelineSadd = vi.fn()
const mockPipelineExec = vi.fn(async () => [])

vi.mock('@/lib/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    pipeline: () => ({
      set: mockPipelineSet,
      sadd: mockPipelineSadd,
      exec: mockPipelineExec,
    }),
  },
}))

vi.mock('@/lib/alert-wrapper', () => ({
  emitTransitionAlert: vi.fn().mockResolvedValue(undefined),
}))

// ── Import route after mocks ───────────────────────────

import { GET } from './route'
import { beginTick } from '@/lib/source-state-machine'

// ── Helpers ────────────────────────────────────────────

function seedSource(
  id: string,
  state: 'active' | 'degraded' | 'disabled',
  opts?: { successCount?: number; failureCount?: number; latencyHistory?: number[]; lastCheckAt?: number },
): void {
  getSet('teraswap:source-state:index').add(id)
  kvStore.set(`teraswap:source-state:${id}`, {
    id,
    state,
    lastCheckAt: opts?.lastCheckAt ?? Date.now(),
    failureCount: opts?.failureCount ?? 0,
    successCount: opts?.successCount ?? 100,
    latencyHistory: opts?.latencyHistory ?? [800, 900, 1000, 1100, 1200],
    lastTransitionAt: Date.now(),
    ...(state === 'disabled' ? { disabledReason: 'test-reason', disabledAt: Date.now() } : {}),
  })
}

// ═══════════════════════════════════════════════════════

describe('GET /api/monitor/status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
  })

  // ── Response shape ──────────────────────────────────

  describe('response shape', () => {
    it('returns correct structure with sources', async () => {
      kvStore.set('teraswap:monitor:lastTick', new Date().toISOString())
      seedSource('1inch', 'active')
      seedSource('cowswap', 'degraded')

      const res = await GET()
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveProperty('healthy')
      expect(body).toHaveProperty('sources')
      expect(body).toHaveProperty('lastTick')
      expect(body).toHaveProperty('tickFresh')
      expect(Array.isArray(body.sources)).toBe(true)
      expect(body.sources.length).toBe(2)
    })

    it('each source has expected fields', async () => {
      seedSource('1inch', 'active')

      const res = await GET()
      const body = await res.json()
      const source = body.sources[0]

      expect(source).toHaveProperty('id')
      expect(source).toHaveProperty('status')
      expect(source).toHaveProperty('p95LatencyMs')
      expect(source).toHaveProperty('uptimePercent')
      expect(source).toHaveProperty('lastChecked')
    })

    it('returns empty sources array when no sources registered', async () => {
      const res = await GET()
      const body = await res.json()
      expect(body.sources).toEqual([])
      expect(body.healthy).toBe(false) // no tick = not fresh
    })
  })

  // ── Health calculation ──────────────────────────────

  describe('health calculation', () => {
    it('healthy=true when all active + tick fresh', async () => {
      kvStore.set('teraswap:monitor:lastTick', new Date().toISOString())
      seedSource('1inch', 'active')
      seedSource('0x', 'active')

      const res = await GET()
      const body = await res.json()
      expect(body.healthy).toBe(true)
      expect(body.tickFresh).toBe(true)
    })

    it('healthy=false when a source is degraded', async () => {
      kvStore.set('teraswap:monitor:lastTick', new Date().toISOString())
      seedSource('1inch', 'active')
      seedSource('cowswap', 'degraded')

      const res = await GET()
      const body = await res.json()
      expect(body.healthy).toBe(false)
    })

    it('healthy=false when tick is stale (>180s)', async () => {
      const staleTime = new Date(Date.now() - 200_000).toISOString()
      kvStore.set('teraswap:monitor:lastTick', staleTime)
      seedSource('1inch', 'active')

      const res = await GET()
      const body = await res.json()
      expect(body.healthy).toBe(false)
      expect(body.tickFresh).toBe(false)
    })

    it('tickFresh=false and lastTick=null when no tick recorded', async () => {
      seedSource('1inch', 'active')

      const res = await GET()
      const body = await res.json()
      expect(body.lastTick).toBeNull()
      expect(body.tickFresh).toBe(false)
    })
  })

  // ── P95 latency ────────────────────────────────────

  describe('p95 latency', () => {
    it('computes p95 from latency history', async () => {
      seedSource('1inch', 'active', {
        latencyHistory: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
      })

      const res = await GET()
      const body = await res.json()
      expect(body.sources[0].p95LatencyMs).toBe(1000) // ceil(10 * 0.95)-1 = idx 9
    })

    it('returns null when latency history is empty', async () => {
      seedSource('1inch', 'active', { latencyHistory: [] })

      const res = await GET()
      const body = await res.json()
      expect(body.sources[0].p95LatencyMs).toBeNull()
    })
  })

  // ── Uptime ─────────────────────────────────────────

  describe('uptime calculation', () => {
    it('computes uptime from success/failure counts', async () => {
      seedSource('1inch', 'active', { successCount: 95, failureCount: 5 })

      const res = await GET()
      const body = await res.json()
      expect(body.sources[0].uptimePercent).toBe(95.0)
    })

    it('returns null when insufficient data (<10 total checks)', async () => {
      seedSource('1inch', 'active', { successCount: 5, failureCount: 2 })

      const res = await GET()
      const body = await res.json()
      expect(body.sources[0].uptimePercent).toBeNull()
    })

    it('handles 100% uptime', async () => {
      seedSource('1inch', 'active', { successCount: 500, failureCount: 0 })

      const res = await GET()
      const body = await res.json()
      expect(body.sources[0].uptimePercent).toBe(100.0)
    })
  })

  // ── Sorting ────────────────────────────────────────

  describe('source sorting', () => {
    it('sorts: active first, then degraded, then disabled', async () => {
      seedSource('zz-disabled', 'disabled')
      seedSource('aa-active', 'active')
      seedSource('mm-degraded', 'degraded')

      const res = await GET()
      const body = await res.json()
      const ids = body.sources.map((s: { id: string }) => s.id)
      expect(ids).toEqual(['aa-active', 'mm-degraded', 'zz-disabled'])
    })

    it('sorts alphabetically within same state', async () => {
      seedSource('odos', 'active')
      seedSource('1inch', 'active')
      seedSource('balancer', 'active')

      const res = await GET()
      const body = await res.json()
      const ids = body.sources.map((s: { id: string }) => s.id)
      expect(ids).toEqual(['1inch', 'balancer', 'odos'])
    })
  })

  // ── Privacy ────────────────────────────────────────

  describe('data privacy', () => {
    it('does not expose internal fields', async () => {
      seedSource('cowswap', 'disabled')

      const res = await GET()
      const body = await res.json()
      const source = body.sources[0]

      // Must NOT have these internal fields
      expect(source).not.toHaveProperty('failureCount')
      expect(source).not.toHaveProperty('successCount')
      expect(source).not.toHaveProperty('latencyHistory')
      expect(source).not.toHaveProperty('disabledReason')
      expect(source).not.toHaveProperty('disabledAt')
      expect(source).not.toHaveProperty('lastTransitionAt')
    })
  })

  // ── Caching ────────────────────────────────────────

  describe('caching', () => {
    it('sets Cache-Control header for edge caching', async () => {
      const res = await GET()
      expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=30, stale-while-revalidate=30')
    })
  })

  // ── KV failure ─────────────────────────────────────

  describe('KV failure', () => {
    it('returns 503 when KV read fails', async () => {
      mockKvSmembers.mockRejectedValueOnce(new Error('Connection refused'))
      // Also mock kv.get to fail (for lastTick)
      mockKvGet.mockRejectedValueOnce(new Error('Connection refused'))

      const res = await GET()
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('Status data temporarily unavailable')
      expect(body.healthy).toBe(false)
    })
  })
})
