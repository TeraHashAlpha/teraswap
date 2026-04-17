/**
 * Unit tests for POST /api/monitor/validate-execution — P45 API route.
 *
 * Tests cover: authentication (missing secret, wrong token, valid token),
 * input validation (all required fields, address format, decimals range),
 * successful validation pass-through, error handling, and response shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks ────────────────────────────────────────────────

const mockValidateExecution = vi.fn()

vi.mock('@/lib/post-execution-validator', () => ({
  validateExecution: (...args: unknown[]) => mockValidateExecution(...args),
}))

vi.mock('@/lib/auth', () => ({
  verifyBearerToken: (header: string | null, secret: string) => {
    if (!header || !secret) return false
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token === secret
  },
}))

// ── Helpers ──────────────────────────────────────────────

const TX_HASH = '0x' + 'a'.repeat(64)
const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TOKEN_OUT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const SECRET = 'test-validation-secret-123'

function makeRequest(body: unknown, token?: string): NextRequest {
  return new NextRequest('http://localhost/api/monitor/validate-execution', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function validBody() {
  return {
    txHash: TX_HASH,
    source: '1inch',
    recipient: RECIPIENT,
    tokenOut: TOKEN_OUT,
    tokenOutDecimals: 6,
    expectedMinOutput: '1000000',
  }
}

// ── Import route handler dynamically to respect env mock ──

async function getHandler() {
  // Dynamic import so each test can set env vars before import
  const mod = await import('./route')
  return mod.POST
}

// ── Tests ────────────────────────────────────────────────

describe('POST /api/monitor/validate-execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.EXECUTOR_VALIDATION_SECRET = SECRET
  })

  // ── Authentication ────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 when no auth header', async () => {
      const handler = await getHandler()
      const req = makeRequest(validBody())
      const res = await handler(req)
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
    })

    it('returns 401 when token is wrong', async () => {
      const handler = await getHandler()
      const req = makeRequest(validBody(), 'wrong-token')
      const res = await handler(req)
      expect(res.status).toBe(401)
    })

    it('returns 503 when secret not configured', async () => {
      delete process.env.EXECUTOR_VALIDATION_SECRET
      const handler = await getHandler()
      const req = makeRequest(validBody(), SECRET)
      const res = await handler(req)
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('not configured')
    })

    it('returns 200 with valid token', async () => {
      mockValidateExecution.mockResolvedValue({
        txHash: TX_HASH,
        source: '1inch',
        severity: 'ok',
        actualOutput: '1000000',
        expectedMinOutput: '1000000',
        shortfallPercent: 0,
        reason: 'Output meets expected minimum',
        tokenOut: TOKEN_OUT,
        tokenOutDecimals: 6,
        extractionMethod: 'transfer_logs',
        validatedAt: new Date().toISOString(),
      })

      const handler = await getHandler()
      const req = makeRequest(validBody(), SECRET)
      const res = await handler(req)
      expect(res.status).toBe(200)
    })
  })

  // ── Input validation ──────────────────────────────────

  describe('input validation', () => {
    it('rejects missing txHash', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), txHash: undefined }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('txHash')
    })

    it('rejects invalid txHash format', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), txHash: '0x123' }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
    })

    it('rejects invalid recipient address', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), recipient: 'not-an-address' }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('recipient')
    })

    it('rejects invalid tokenOut address', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), tokenOut: '0xZZZ' }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
    })

    it('rejects decimals out of range', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), tokenOutDecimals: 19 }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('tokenOutDecimals')
    })

    it('rejects non-numeric expectedMinOutput', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), expectedMinOutput: 'abc' }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
    })

    it('rejects empty source', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), source: '' }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
    })

    it('accepts valid preSwapBalance', async () => {
      mockValidateExecution.mockResolvedValue({
        txHash: TX_HASH,
        source: '1inch',
        severity: 'ok',
        actualOutput: '1000000',
        expectedMinOutput: '1000000',
        shortfallPercent: 0,
        reason: 'ok',
        tokenOut: TOKEN_OUT,
        tokenOutDecimals: 6,
        extractionMethod: 'balance_diff',
        validatedAt: new Date().toISOString(),
      })

      const handler = await getHandler()
      const body = { ...validBody(), preSwapBalance: '500000' }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(200)
    })

    it('rejects non-numeric preSwapBalance', async () => {
      const handler = await getHandler()
      const body = { ...validBody(), preSwapBalance: 'xyz' }
      const req = makeRequest(body, SECRET)
      const res = await handler(req)
      expect(res.status).toBe(400)
    })

    it('rejects invalid JSON body', async () => {
      const handler = await getHandler()
      const req = new NextRequest('http://localhost/api/monitor/validate-execution', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SECRET}`,
        },
        body: 'not json',
      })
      const res = await handler(req)
      expect(res.status).toBe(400)
    })
  })

  // ── Response shape ────────────────────────────────────

  describe('response shape', () => {
    it('returns full ExecutionValidation shape', async () => {
      const mockResult = {
        txHash: TX_HASH,
        source: '1inch',
        severity: 'warning',
        actualOutput: '990000',
        expectedMinOutput: '1000000',
        shortfallPercent: 0.01,
        reason: 'Output 0.99 is 1.00% below expected 1.0',
        tokenOut: TOKEN_OUT,
        tokenOutDecimals: 6,
        extractionMethod: 'transfer_logs',
        validatedAt: '2026-04-17T12:00:00.000Z',
      }
      mockValidateExecution.mockResolvedValue(mockResult)

      const handler = await getHandler()
      const req = makeRequest(validBody(), SECRET)
      const res = await handler(req)
      const data = await res.json()

      expect(data.txHash).toBe(TX_HASH)
      expect(data.source).toBe('1inch')
      expect(data.severity).toBe('warning')
      expect(data.actualOutput).toBe('990000')
      expect(data.expectedMinOutput).toBe('1000000')
      expect(data.shortfallPercent).toBe(0.01)
      expect(data.extractionMethod).toBe('transfer_logs')
      expect(data.validatedAt).toBeDefined()
    })

    it('includes Cache-Control: no-store header', async () => {
      mockValidateExecution.mockResolvedValue({
        txHash: TX_HASH, source: '1inch', severity: 'ok',
        actualOutput: '1000000', expectedMinOutput: '1000000',
        shortfallPercent: 0, reason: 'ok', tokenOut: TOKEN_OUT,
        tokenOutDecimals: 6, extractionMethod: 'transfer_logs',
        validatedAt: new Date().toISOString(),
      })

      const handler = await getHandler()
      const req = makeRequest(validBody(), SECRET)
      const res = await handler(req)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })
  })

  // ── Error handling ────────────────────────────────────

  describe('error handling', () => {
    it('returns 500 if validateExecution throws unexpectedly', async () => {
      mockValidateExecution.mockRejectedValue(new Error('unexpected crash'))

      const handler = await getHandler()
      const req = makeRequest(validBody(), SECRET)
      const res = await handler(req)
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Internal validation error')
    })
  })
})
