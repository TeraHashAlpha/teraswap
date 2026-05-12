/**
 * Unit tests for src/lib/utils.ts — [10-L-01] safeBigInt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { safeBigInt, _setSafeBigIntWarn } from './utils'

describe('safeBigInt — accepted inputs', () => {
  beforeEach(() => _setSafeBigIntWarn(false))
  afterEach(() => _setSafeBigIntWarn(true))

  it('returns BigInt for a decimal integer string', () => {
    expect(safeBigInt('123')).toBe(123n)
  })

  it('returns BigInt for a 256-bit-range integer string', () => {
    expect(safeBigInt('12345678901234567890')).toBe(12345678901234567890n)
  })

  it('returns BigInt for the uint256 maximum', () => {
    const maxU256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    expect(safeBigInt(maxU256)).toBe(BigInt(maxU256))
  })

  it('returns BigInt for "0"', () => {
    expect(safeBigInt('0')).toBe(0n)
  })

  it('returns BigInt for a negative integer string', () => {
    expect(safeBigInt('-42')).toBe(-42n)
  })

  it('returns BigInt for a finite integer number', () => {
    expect(safeBigInt(42)).toBe(42n)
  })

  it('returns BigInt for the number 0', () => {
    expect(safeBigInt(0)).toBe(0n)
  })

  it('passes through an existing bigint unchanged', () => {
    expect(safeBigInt(999n)).toBe(999n)
  })
})

describe('safeBigInt — rejected inputs return null without throwing', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('null → null', () => {
    expect(safeBigInt(null)).toBeNull()
    // Null/undefined are not warn-worthy (common "not loaded yet" sentinels).
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('undefined → null', () => {
    expect(safeBigInt(undefined)).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('empty string → null', () => {
    expect(safeBigInt('')).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('"NaN" → null with warning', () => {
    expect(safeBigInt('NaN')).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/non-numeric-string/)
  })

  it('non-numeric string → null with warning', () => {
    expect(safeBigInt('not-a-number')).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('decimal-with-fraction string → null', () => {
    expect(safeBigInt('1.5')).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('scientific notation string → null', () => {
    expect(safeBigInt('1e18')).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('hex string → null (decimal only)', () => {
    expect(safeBigInt('0x123')).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('whitespace-padded string → null', () => {
    expect(safeBigInt('  123')).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('NaN → null with warning', () => {
    expect(safeBigInt(NaN)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/non-integer-number/)
  })

  it('Infinity → null with warning', () => {
    expect(safeBigInt(Infinity)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('-Infinity → null with warning', () => {
    expect(safeBigInt(-Infinity)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('floating-point number → null with warning', () => {
    expect(safeBigInt(1.5)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('boolean → null with warning', () => {
    expect(safeBigInt(true)).toBeNull()
    expect(safeBigInt(false)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('object → null with warning', () => {
    expect(safeBigInt({})).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('array → null with warning', () => {
    expect(safeBigInt([])).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('never throws for any input', () => {
    // Sanity: a sweep over odd inputs should land at null, never throw.
    const inputs: unknown[] = [
      Symbol('s'), () => 1, new Date(), /regex/, new Map(), new Set(), null, undefined,
      '', 'NaN', 'abc', '1.0', '1e1', '0x0', '  ', '-', '+', '0x',
    ]
    for (const i of inputs) {
      expect(() => safeBigInt(i)).not.toThrow()
      expect(safeBigInt(i)).toBeNull()
    }
  })
})
