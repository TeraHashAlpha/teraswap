/**
 * [CHORE-API-HARDENING-2 / P3b] quoteCacheKey / quantizeAmount — `amount` used to
 * enter the cache key VERBATIM, so an attacker incrementing it by 1 wei each
 * request always missed the 3s cache, forcing fetchMetaQuote to fan out to all
 * ~11 enabled upstream adapters (several billed) per request. Quantizing the
 * amount to a few significant figures buckets near-identical amounts into the
 * same cache entry while staying precise enough not to conflate genuinely
 * different trade sizes.
 */
import { describe, it, expect } from 'vitest'
import { quoteCacheKey, quantizeAmount } from './quote-cache'

const BASE = { src: '0xAAA', dst: '0xBBB', srcDecimals: 18, dstDecimals: 18 }

describe('quantizeAmount — bucket to significant figures', () => {
  it('leaves a short amount (<= sig figs) unchanged — already coarse enough', () => {
    expect(quantizeAmount('1234')).toBe('1234')
    expect(quantizeAmount('7')).toBe('7')
  })

  it('ADVERSARIAL: an 18-decimal amount incremented by +1 wei lands in the SAME bucket', () => {
    const a = quantizeAmount('1000000000000000000') // 1e18
    const b = quantizeAmount('1000000000000000001') // 1e18 + 1 wei
    expect(a).toBe(b)
  })

  it('rounds DOWN to the bucket floor (top 4 significant figures, rest zeroed)', () => {
    expect(quantizeAmount('123456789012345678')).toBe('123400000000000000')
  })

  it('two amounts far enough apart land in DIFFERENT buckets (still amount-sensitive)', () => {
    const a = quantizeAmount('1000000000000000000') // 1e18
    const b = quantizeAmount('2000000000000000000') // 2e18
    expect(a).not.toBe(b)
  })

  it('passes a non-digit-string amount through unchanged (defensive; not this fn\'s job to validate)', () => {
    expect(quantizeAmount('not-a-number')).toBe('not-a-number')
    expect(quantizeAmount('')).toBe('')
    expect(quantizeAmount('12.5')).toBe('12.5')
  })

  it('never throws on a huge or oddly-shaped input', () => {
    expect(() => quantizeAmount('9'.repeat(80))).not.toThrow()
  })
})

describe('quoteCacheKey — quantizes the amount so near-identical requests share a bucket', () => {
  it('a +1 wei difference on an 18-decimal amount produces the SAME cache key', () => {
    const keyA = quoteCacheKey({ ...BASE, amount: '1000000000000000000' })
    const keyB = quoteCacheKey({ ...BASE, amount: '1000000000000000001' })
    expect(keyA).toBe(keyB)
  })

  it('a genuinely different trade size still produces a DIFFERENT cache key', () => {
    const keyA = quoteCacheKey({ ...BASE, amount: '1000000000000000000' })
    const keyB = quoteCacheKey({ ...BASE, amount: '5000000000000000000' })
    expect(keyA).not.toBe(keyB)
  })

  it('a small (short) amount is unaffected by quantization — exact key as before', () => {
    const key = quoteCacheKey({ ...BASE, amount: '500' })
    expect(key).toContain('|500|')
  })
})
