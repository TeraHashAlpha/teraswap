/**
 * [P175] Unit tests for src/lib/validation.ts.
 *
 * Every API route + the client-side swap flow rely on these six pure
 * helpers (`isValidAddress`, `isValidTxHash`, `isValidAmount`, `cap`,
 * `isAllowedOrigin`, `safeCompare`). They went into production without
 * direct coverage; this file closes that gap.
 */

import { describe, it, expect } from 'vitest'
import {
  isValidAddress,
  isValidTxHash,
  isValidAmount,
  cap,
  isAllowedOrigin,
  safeCompare,
} from './validation'

describe('isValidAddress', () => {
  const VALID = '0x1234567890abcdef1234567890abcdef12345678'

  it('accepts a lowercase 0x + 40 hex chars address', () => {
    expect(isValidAddress(VALID)).toBe(true)
  })

  it('accepts an uppercase 0x + 40 hex chars address', () => {
    expect(isValidAddress(VALID.toUpperCase().replace('0X', '0x'))).toBe(true)
  })

  it('accepts mixed-case addresses (EIP-55 checksummed)', () => {
    expect(isValidAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidAddress('')).toBe(false)
  })

  it('rejects null / undefined / non-strings', () => {
    expect(isValidAddress(null)).toBe(false)
    expect(isValidAddress(undefined)).toBe(false)
    expect(isValidAddress(42)).toBe(false)
    expect(isValidAddress({})).toBe(false)
  })

  it('rejects the bare "0x" prefix', () => {
    expect(isValidAddress('0x')).toBe(false)
  })

  it('rejects 39 hex chars (one short)', () => {
    expect(isValidAddress('0x' + 'a'.repeat(39))).toBe(false)
  })

  it('rejects 41 hex chars (one long)', () => {
    expect(isValidAddress('0x' + 'a'.repeat(41))).toBe(false)
  })

  it('rejects non-hex characters in the body', () => {
    expect(isValidAddress('0x' + 'z'.repeat(40))).toBe(false)
  })

  it('rejects address missing the 0x prefix', () => {
    expect(isValidAddress('1234567890abcdef1234567890abcdef12345678')).toBe(false)
  })

  it('rejects uppercase 0X prefix (case-sensitive prefix)', () => {
    expect(isValidAddress('0X1234567890abcdef1234567890abcdef12345678')).toBe(false)
  })
})

describe('isValidTxHash', () => {
  const VALID = '0x' + '1234567890abcdef'.repeat(4)

  it('accepts 0x + 64 hex chars', () => {
    expect(isValidTxHash(VALID)).toBe(true)
  })

  it('accepts mixed-case hex hash', () => {
    expect(isValidTxHash('0x' + 'A1b2C3d4'.repeat(8))).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidTxHash('')).toBe(false)
  })

  it('rejects null / non-strings', () => {
    expect(isValidTxHash(null)).toBe(false)
    expect(isValidTxHash(undefined)).toBe(false)
    expect(isValidTxHash(123)).toBe(false)
  })

  it('rejects 63 hex chars', () => {
    expect(isValidTxHash('0x' + 'a'.repeat(63))).toBe(false)
  })

  it('rejects 65 hex chars', () => {
    expect(isValidTxHash('0x' + 'a'.repeat(65))).toBe(false)
  })

  it('rejects non-hex characters', () => {
    expect(isValidTxHash('0x' + 'z'.repeat(64))).toBe(false)
  })

  it('rejects missing 0x prefix', () => {
    expect(isValidTxHash('a'.repeat(64))).toBe(false)
  })
})

describe('isValidAmount', () => {
  it("accepts '1'", () => {
    expect(isValidAmount('1')).toBe(true)
  })

  it("accepts '0.5'", () => {
    expect(isValidAmount('0.5')).toBe(true)
  })

  it("accepts '1000000'", () => {
    expect(isValidAmount('1000000')).toBe(true)
  })

  it("accepts '0.000001'", () => {
    expect(isValidAmount('0.000001')).toBe(true)
  })

  it("rejects '0' (must be strictly positive)", () => {
    expect(isValidAmount('0')).toBe(false)
  })

  it("rejects negatives", () => {
    expect(isValidAmount('-1')).toBe(false)
    expect(isValidAmount('-0.5')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidAmount('')).toBe(false)
  })

  it("rejects non-numeric strings", () => {
    expect(isValidAmount('abc')).toBe(false)
    expect(isValidAmount('NaN')).toBe(false)
  })

  it("rejects 'Infinity'", () => {
    expect(isValidAmount('Infinity')).toBe(false)
  })

  it('rejects non-string types', () => {
    expect(isValidAmount(null)).toBe(false)
    expect(isValidAmount(undefined)).toBe(false)
    expect(isValidAmount(42)).toBe(false)
    expect(isValidAmount({})).toBe(false)
  })

  it("accepts whitespace-padded numerics (Number(' 1 ') === 1)", () => {
    // Documenting the actual behaviour: Number(' 1 ') === 1, so the current
    // function returns true here. If we ever want strict-numeric, tighten
    // the function — for now this test pins the existing contract.
    expect(isValidAmount(' 1 ')).toBe(true)
  })
})

describe('cap', () => {
  it('returns a string shorter than max unchanged', () => {
    expect(cap('hello', 500)).toBe('hello')
  })

  it('returns a string exactly at max unchanged', () => {
    const s = 'a'.repeat(10)
    expect(cap(s, 10)).toBe(s)
  })

  it('truncates a string longer than max to exactly max chars', () => {
    expect(cap('abcdef', 3)).toBe('abc')
  })

  it('uses the default max of 500 when no max is provided', () => {
    const s = 'b'.repeat(501)
    const result = cap(s)
    expect(result).toHaveLength(500)
    expect(result).toBe('b'.repeat(500))
  })

  it('returns empty string for non-string inputs', () => {
    expect(cap(null)).toBe('')
    expect(cap(undefined)).toBe('')
    expect(cap(42)).toBe('')
    expect(cap({})).toBe('')
    expect(cap([])).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(cap('')).toBe('')
  })
})

describe('isAllowedOrigin', () => {
  it('accepts the production origin', () => {
    expect(isAllowedOrigin('https://teraswap.app')).toBe(true)
  })

  it('accepts the www subdomain', () => {
    expect(isAllowedOrigin('https://www.teraswap.app')).toBe(true)
  })

  it('accepts any localhost dev port', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
  })

  it('accepts loopback 127.0.0.1 with a port', () => {
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true)
  })

  it('rejects null and empty string', () => {
    expect(isAllowedOrigin(null)).toBe(false)
    expect(isAllowedOrigin('')).toBe(false)
  })

  it('rejects unrelated origins', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false)
  })

  it('rejects look-alike subdomains', () => {
    expect(isAllowedOrigin('https://teraswap.app.evil.com')).toBe(false)
  })

  it('rejects localhost without a port (matcher requires the colon)', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(false)
  })

  it('rejects http:// against the production origin (must be https://)', () => {
    expect(isAllowedOrigin('http://teraswap.app')).toBe(false)
  })
})

describe('safeCompare', () => {
  it('returns true for two equal strings', () => {
    expect(safeCompare('hello', 'hello')).toBe(true)
  })

  it('returns false for two strings of the same length with different content', () => {
    expect(safeCompare('hello', 'world')).toBe(false)
  })

  it('returns false for different-length strings (short-circuit)', () => {
    expect(safeCompare('hello', 'hello!')).toBe(false)
  })

  it('returns false when either side is not a string', () => {
    // The signature is (string, string) but the runtime guard handles
    // unknown shapes; cast through unknown to exercise that path.
    expect(safeCompare(null as unknown as string, 'hello')).toBe(false)
    expect(safeCompare('hello', undefined as unknown as string)).toBe(false)
    expect(safeCompare(42 as unknown as string, 'hello')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(safeCompare('', '')).toBe(true)
  })

  it('handles unicode strings (compared byte-by-byte)', () => {
    expect(safeCompare('café', 'café')).toBe(true)
    expect(safeCompare('café', 'cafe')).toBe(false) // different byte lengths
  })
})
