/**
 * Unit tests for src/lib/auth.ts — shared Bearer token verification.
 *
 * [N-04] Extracted from kill-switch, tick, and heartbeat/admin routes.
 * Tests cover: matching tokens, mismatched tokens, edge cases (null,
 * empty, missing Bearer prefix), and the constant-time comparison.
 *
 * [fix/codeql-auth-swap, CodeQL #1] The pre-hash is HMAC-SHA256 keyed with a
 * per-process random key. The recorder below wraps node:crypto with
 * pass-through spies so the tests can observe the key drawn at module load,
 * the key each MAC uses and the buffer lengths handed to timingSafeEqual —
 * every primitive still runs for real, so every verdict asserted is real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Instrumentation (hoisted before the module under test loads) ──

const recorder = vi.hoisted(() => ({
  randomKeys: [] as Buffer[],
  hmacKeys: [] as Buffer[],
  timingSafeEqualLengths: [] as Array<[number, number]>,
}))

function resetRecorder(): void {
  recorder.hmacKeys.length = 0
  recorder.timingSafeEqualLengths.length = 0
}

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: ((size: number) => {
      const key = actual.randomBytes(size)
      recorder.randomKeys.push(key)
      return key
    }) as typeof actual.randomBytes,
    createHmac: ((algorithm: string, key: Buffer) => {
      recorder.hmacKeys.push(key)
      return actual.createHmac(algorithm, key)
    }) as typeof actual.createHmac,
    timingSafeEqual: ((a: Buffer, b: Buffer) => {
      recorder.timingSafeEqualLengths.push([a.length, b.length])
      return actual.timingSafeEqual(a, b)
    }) as typeof actual.timingSafeEqual,
  }
})

import { createHmac } from 'node:crypto'
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

// ─────────────────────────────────────────────────────────
// [fix/codeql-auth-swap, CodeQL #1] HMAC-SHA256 with a per-process random key
// ─────────────────────────────────────────────────────────

describe('verifyBearerToken — HMAC-SHA256 keyed per process [CodeQL #1]', () => {
  beforeEach(() => resetRecorder())

  it('draws a 32-byte random comparison key at module load (in-memory only, no env var)', () => {
    expect(recorder.randomKeys.length).toBeGreaterThanOrEqual(1)
    expect(recorder.randomKeys[0].length).toBe(32)
  })

  it('MACs both sides with the same in-process key, then compares the two 32-byte MACs', () => {
    expect(verifyBearerToken('Bearer my-secret-123', 'my-secret-123')).toBe(true)
    expect(recorder.hmacKeys).toHaveLength(2)
    expect(recorder.hmacKeys[0].equals(recorder.hmacKeys[1])).toBe(true)
    expect(recorder.hmacKeys[0].equals(recorder.randomKeys[0])).toBe(true)
    expect(recorder.timingSafeEqualLengths).toEqual([[32, 32]])
  })

  it('length mismatch never short-circuits: both sides are MAC’d and timingSafeEqual still sees 32 vs 32 bytes', () => {
    expect(verifyBearerToken('Bearer short', 'much-longer-secret')).toBe(false)
    expect(recorder.hmacKeys).toHaveLength(2)
    expect(recorder.timingSafeEqualLengths).toEqual([[32, 32]])
  })

  it('a second module instance draws a different key, produces different MACs, and returns the same verdicts', async () => {
    const first = verifyBearerToken
    vi.resetModules()
    const second = (await import('./auth')).verifyBearerToken
    expect(second).not.toBe(first)

    expect(recorder.randomKeys).toHaveLength(2)
    const [keyA, keyB] = recorder.randomKeys
    expect(keyB.length).toBe(32)
    expect(keyA.equals(keyB)).toBe(false)

    // Same input, different per-process key → different MAC.
    const macA = createHmac('sha256', keyA).update('my-secret-123').digest()
    const macB = createHmac('sha256', keyB).update('my-secret-123').digest()
    expect(macA.equals(macB)).toBe(false)

    resetRecorder()
    expect(first('Bearer my-secret-123', 'my-secret-123')).toBe(true)
    expect(second('Bearer my-secret-123', 'my-secret-123')).toBe(true)
    expect(first('Bearer wrong-secret', 'my-secret-123')).toBe(false)
    expect(second('Bearer wrong-secret', 'my-secret-123')).toBe(false)
    // Each instance MACs with its own key: 2 calls × 2 sides per instance.
    expect(recorder.hmacKeys.filter(k => k.equals(keyA))).toHaveLength(4)
    expect(recorder.hmacKeys.filter(k => k.equals(keyB))).toHaveLength(4)
  })
})
