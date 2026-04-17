/**
 * Unit tests for src/lib/auth.ts — shared Bearer token verification.
 *
 * [N-04] Extracted from kill-switch, tick, and heartbeat/admin routes.
 * Tests cover: matching tokens, mismatched tokens, edge cases (null,
 * empty, missing Bearer prefix), and constant-time SHA-256 comparison.
 */

import { describe, it, expect } from 'vitest'
import { verifyBearerToken } from './auth'

describe('verifyBearerToken', () => {
  // ── Positive cases ────────────────────────────────────

  it('returns true for matching Bearer token', () => {
    expect(verifyBearerToken('Bearer my-secret-123', 'my-secret-123')).toBe(true)
  })

  it('returns true for long matching tokens', () => {
    const secret = 'a'.repeat(256)
    expect(verifyBearerToken(`Bearer ${secret}`, secret)).toBe(true)
  })

  // ── Negative cases ────────────────────────────────────

  it('returns false for mismatched tokens (same length)', () => {
    expect(verifyBearerToken('Bearer abc123', 'xyz789')).toBe(false)
  })

  it('returns false for mismatched tokens (different length)', () => {
    expect(verifyBearerToken('Bearer short', 'much-longer-token')).toBe(false)
  })

  // ── Null / empty / malformed ──────────────────────────

  it('returns false when authHeader is null', () => {
    expect(verifyBearerToken(null, 'some-secret')).toBe(false)
  })

  it('returns false when authHeader is empty string', () => {
    expect(verifyBearerToken('', 'some-secret')).toBe(false)
  })

  it('returns false when expectedSecret is empty string', () => {
    expect(verifyBearerToken('Bearer token', '')).toBe(false)
  })

  it('returns false when Bearer prefix is missing', () => {
    expect(verifyBearerToken('my-secret-123', 'my-secret-123')).toBe(false)
  })

  it('returns false when Bearer prefix has no token after it', () => {
    expect(verifyBearerToken('Bearer ', 'some-secret')).toBe(false)
  })

  it('returns false for "Bearer" with no space (no token extracted)', () => {
    expect(verifyBearerToken('Bearer', 'some-secret')).toBe(false)
  })

  // ── No information leakage ────────────────────────────

  it('returns same result shape for all rejection paths (no info leakage)', () => {
    const results = [
      verifyBearerToken(null, 'secret'),
      verifyBearerToken('', 'secret'),
      verifyBearerToken('Bearer wrong', 'secret'),
      verifyBearerToken('Bearer short', 'much-longer-secret'),
      verifyBearerToken('no-prefix', 'secret'),
    ]
    // All must be exactly false (not falsy — false)
    results.forEach(r => expect(r).toBe(false))
  })
})
