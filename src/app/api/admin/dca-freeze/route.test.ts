/**
 * @vitest-environment node
 *
 * Unit tests for /api/admin/dca-freeze (admin freeze toggle).
 *
 * Mirrors the kill-switch route tests: auth (503 unset / 401 bad token),
 * valid freeze/unfreeze, and the GET read path. The dca-freeze lib is mocked
 * so these tests never touch Supabase — they assert the route wires the
 * Bearer gate to setDcaFreezeState/getDcaFreezeState correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mock the dca-freeze lib (Supabase-backed, tested separately) ──

const mockGetDcaFreezeState = vi.fn()
const mockSetDcaFreezeState = vi.fn()

vi.mock('@/lib/dca-freeze', () => ({
  getDcaFreezeState: (...args: unknown[]) => mockGetDcaFreezeState(...args),
  setDcaFreezeState: (...args: unknown[]) => mockSetDcaFreezeState(...args),
}))

// ── Import route after mocks ────────────────────────────

import { POST, GET } from './route'

// ── Helpers ─────────────────────────────────────────────

const originalEnv = { ...process.env }
const SECRET = 'test-freeze-secret-abc123'

function makePost(body: unknown, token?: string): NextRequest {
  return new NextRequest('https://teraswap.app/api/admin/dca-freeze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function makeGet(token?: string): NextRequest {
  return new NextRequest('https://teraswap.app/api/admin/dca-freeze', {
    method: 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

const FROZEN_STATE = {
  frozen: true,
  reason: 'unexplained outflow',
  updatedAt: '2026-06-17T00:00:00.000Z',
  updatedBy: 'admin',
}

const UNFROZEN_STATE = {
  frozen: false,
  reason: '',
  updatedAt: '2026-06-17T00:00:00.000Z',
  updatedBy: 'admin',
}

// ═══════════════════════════════════════════════════════════════

describe('/api/admin/dca-freeze', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv, DCA_FREEZE_SECRET: SECRET }
  })

  // ── Auth ──────────────────────────────────────────────

  describe('authentication', () => {
    it('POST returns 503 when DCA_FREEZE_SECRET is not configured', async () => {
      delete process.env.DCA_FREEZE_SECRET
      const res = await POST(makePost({ frozen: true }, SECRET))
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('dca-freeze not configured')
      expect(mockSetDcaFreezeState).not.toHaveBeenCalled()
    })

    it('GET returns 503 when DCA_FREEZE_SECRET is not configured', async () => {
      delete process.env.DCA_FREEZE_SECRET
      const res = await GET(makeGet(SECRET))
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('dca-freeze not configured')
      expect(mockGetDcaFreezeState).not.toHaveBeenCalled()
    })

    it('POST returns 401 when no Authorization header', async () => {
      const res = await POST(makePost({ frozen: true }))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
      expect(mockSetDcaFreezeState).not.toHaveBeenCalled()
    })

    it('POST returns 401 when token is wrong', async () => {
      const res = await POST(makePost({ frozen: true }, 'wrong-token-xyz'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
      expect(mockSetDcaFreezeState).not.toHaveBeenCalled()
    })

    it('GET returns 401 when token is wrong', async () => {
      const res = await GET(makeGet('wrong-token-xyz'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
      expect(mockGetDcaFreezeState).not.toHaveBeenCalled()
    })
  })

  // ── Freeze (POST) ─────────────────────────────────────

  describe('POST freeze', () => {
    it('freezes with reason → calls setDcaFreezeState(true, reason, "admin") and returns 200 + state', async () => {
      mockSetDcaFreezeState.mockResolvedValueOnce(FROZEN_STATE)
      const res = await POST(
        makePost({ frozen: true, reason: 'unexplained outflow' }, SECRET),
      )
      expect(res.status).toBe(200)
      expect(mockSetDcaFreezeState).toHaveBeenCalledWith(
        true,
        'unexplained outflow',
        'admin',
      )
      const body = await res.json()
      expect(body).toEqual(FROZEN_STATE)
    })

    it('unfreezes with {frozen:false} → calls setDcaFreezeState(false, "", "admin")', async () => {
      mockSetDcaFreezeState.mockResolvedValueOnce(UNFROZEN_STATE)
      const res = await POST(makePost({ frozen: false }, SECRET))
      expect(res.status).toBe(200)
      expect(mockSetDcaFreezeState).toHaveBeenCalledWith(false, '', 'admin')
      const body = await res.json()
      expect(body).toEqual(UNFROZEN_STATE)
    })

    it('[201-L-01] returns 503 (NOT 200) when the write fails to persist — fail-closed', async () => {
      // setDcaFreezeState throws when the backend is unconfigured or the upsert
      // fails; the admin must learn the freeze did NOT take.
      mockSetDcaFreezeState.mockRejectedValueOnce(
        new Error('Supabase unconfigured — freeze state NOT persisted'),
      )
      const res = await POST(makePost({ frozen: true, reason: 'outflow' }, SECRET))
      expect(res.status).toBe(503)
      expect((await res.json()).error).toMatch(/failed to set freeze state/i)
    })

    it('defaults reason to "" when omitted', async () => {
      mockSetDcaFreezeState.mockResolvedValueOnce(FROZEN_STATE)
      await POST(makePost({ frozen: true }, SECRET))
      expect(mockSetDcaFreezeState).toHaveBeenCalledWith(true, '', 'admin')
    })

    it('ignores a non-string reason (defaults to "")', async () => {
      mockSetDcaFreezeState.mockResolvedValueOnce(FROZEN_STATE)
      await POST(makePost({ frozen: true, reason: 42 }, SECRET))
      expect(mockSetDcaFreezeState).toHaveBeenCalledWith(true, '', 'admin')
    })

    it('returns 400 when frozen is missing', async () => {
      const res = await POST(makePost({ reason: 'oops' }, SECRET))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('frozen (boolean) is required')
      expect(mockSetDcaFreezeState).not.toHaveBeenCalled()
    })

    it('returns 400 when frozen is not a boolean', async () => {
      const res = await POST(makePost({ frozen: 'true' }, SECRET))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('frozen (boolean) is required')
      expect(mockSetDcaFreezeState).not.toHaveBeenCalled()
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await POST(makePost('not-json{{{', SECRET))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid JSON body')
      expect(mockSetDcaFreezeState).not.toHaveBeenCalled()
    })

    it('returns 503 when setDcaFreezeState throws', async () => {
      mockSetDcaFreezeState.mockRejectedValueOnce(new Error('write error: relation missing'))
      const res = await POST(makePost({ frozen: true }, SECRET))
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('failed to set freeze state')
    })
  })

  // ── Read (GET) ────────────────────────────────────────

  describe('GET current state', () => {
    it('returns the current state from getDcaFreezeState', async () => {
      mockGetDcaFreezeState.mockResolvedValueOnce(FROZEN_STATE)
      const res = await GET(makeGet(SECRET))
      expect(res.status).toBe(200)
      expect(mockGetDcaFreezeState).toHaveBeenCalledTimes(1)
      const body = await res.json()
      expect(body).toEqual(FROZEN_STATE)
    })

    it('returns the fail-open default when not frozen', async () => {
      const notFrozen = { frozen: false, reason: null, updatedAt: null, updatedBy: null }
      mockGetDcaFreezeState.mockResolvedValueOnce(notFrozen)
      const res = await GET(makeGet(SECRET))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(notFrozen)
    })
  })
})
