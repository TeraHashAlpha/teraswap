import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  quoteCacheKey,
  getQuote,
  setQuote,
  clearQuoteCache,
  quoteCacheSize,
  QUOTE_CACHE_TTL_MS,
  QUOTE_CACHE_MAX_ENTRIES,
} from '../../src/lib/quote-cache'
import type { MetaQuoteResult, NormalizedQuote } from '../../src/lib/adapters'

const stubQuote = (toAmount: string): NormalizedQuote => ({
  source: '1inch',
  toAmount,
  estimatedGas: 0,
  gasUsd: 0,
  routes: [],
})

const stubResult = (toAmount: string): MetaQuoteResult => {
  const q = stubQuote(toAmount)
  return { best: q, all: [q], fetchedAt: Date.now() }
}

const baseKey = {
  src: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  dst: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  amount: '1000000000000000000',
  srcDecimals: 18,
  dstDecimals: 6,
}

describe('quote-cache', () => {
  beforeEach(() => {
    clearQuoteCache()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearQuoteCache()
  })

  it('returns a cached entry on hit', () => {
    const key = quoteCacheKey(baseKey)
    const result = stubResult('1000')
    setQuote(key, result)
    expect(getQuote(key)).toBe(result)
  })

  it('returns undefined on miss', () => {
    const key = quoteCacheKey(baseKey)
    expect(getQuote(key)).toBeUndefined()
  })

  it('returns undefined after the TTL expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'))
    const key = quoteCacheKey(baseKey)
    setQuote(key, stubResult('1000'))
    expect(getQuote(key)).toBeDefined()
    vi.advanceTimersByTime(QUOTE_CACHE_TTL_MS + 1)
    expect(getQuote(key)).toBeUndefined()
  })

  it('still returns the entry within the TTL window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'))
    const key = quoteCacheKey(baseKey)
    setQuote(key, stubResult('1000'))
    vi.advanceTimersByTime(QUOTE_CACHE_TTL_MS - 1)
    expect(getQuote(key)).toBeDefined()
  })

  it('produces a stable key format with sorted excludeSources', () => {
    const a = quoteCacheKey({ ...baseKey, excludeSources: ['CoW', '0x'] })
    const b = quoteCacheKey({ ...baseKey, excludeSources: ['0x', 'CoW'] })
    const c = quoteCacheKey({ ...baseKey, excludeSources: ['0X', 'cow'] })
    expect(a).toBe(b)
    expect(a).toBe(c)
    expect(a.endsWith('|0x,cow')).toBe(true)
  })

  it('treats different keys independently', () => {
    const k1 = quoteCacheKey(baseKey)
    const k2 = quoteCacheKey({ ...baseKey, amount: '2000000000000000000' })
    setQuote(k1, stubResult('1000'))
    setQuote(k2, stubResult('2000'))
    expect(getQuote(k1)?.best.toAmount).toBe('1000')
    expect(getQuote(k2)?.best.toAmount).toBe('2000')
  })

  it('clearQuoteCache drops every entry', () => {
    setQuote(quoteCacheKey(baseKey), stubResult('1000'))
    setQuote(quoteCacheKey({ ...baseKey, amount: '2' }), stubResult('2000'))
    expect(quoteCacheSize()).toBe(2)
    clearQuoteCache()
    expect(quoteCacheSize()).toBe(0)
  })

  it('evicts the oldest entry once MAX_ENTRIES is exceeded', () => {
    for (let i = 0; i < QUOTE_CACHE_MAX_ENTRIES; i++) {
      setQuote(quoteCacheKey({ ...baseKey, amount: String(i) }), stubResult(String(i)))
    }
    expect(quoteCacheSize()).toBe(QUOTE_CACHE_MAX_ENTRIES)
    // First inserted key should still be present.
    const firstKey = quoteCacheKey({ ...baseKey, amount: '0' })
    expect(getQuote(firstKey)).toBeDefined()
    // One more insertion should evict the oldest.
    setQuote(quoteCacheKey({ ...baseKey, amount: 'overflow' }), stubResult('x'))
    expect(quoteCacheSize()).toBe(QUOTE_CACHE_MAX_ENTRIES)
    expect(getQuote(firstKey)).toBeUndefined()
  })
})
