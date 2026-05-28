import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createRateLimiter,
  quoteLimiter,
  globalLimiter,
} from '../../src/lib/rate-limiter'

describe('rate-limiter — quoteLimiter / globalLimiter post-P187', () => {
  beforeEach(() => {
    quoteLimiter.reset()
    globalLimiter.reset()
  })

  it('quoteLimiter allows the first 6 requests in a 10s window', () => {
    for (let i = 0; i < 6; i++) {
      expect(quoteLimiter.allow('1inch')).toBe(true)
    }
    expect(quoteLimiter.allow('1inch')).toBe(false)
  })

  it('globalLimiter allows the first 120 requests in a 60s window', () => {
    for (let i = 0; i < 120; i++) {
      expect(globalLimiter.allow('meta_quote')).toBe(true)
    }
    expect(globalLimiter.allow('meta_quote')).toBe(false)
  })
})

describe('rate-limiter — createRateLimiter behaviour', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refills the window after windowMs has passed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'))
    const rl = createRateLimiter({ maxRequests: 2, windowMs: 1000 })
    expect(rl.allow('k')).toBe(true)
    expect(rl.allow('k')).toBe(true)
    expect(rl.allow('k')).toBe(false)
    vi.advanceTimersByTime(1001)
    expect(rl.allow('k')).toBe(true)
  })

  it('isolates counts across keys', () => {
    const rl = createRateLimiter({ maxRequests: 1, windowMs: 10_000 })
    expect(rl.allow('a')).toBe(true)
    expect(rl.allow('a')).toBe(false)
    expect(rl.allow('b')).toBe(true)
    expect(rl.allow('b')).toBe(false)
  })

  it('remaining() reports the unused budget for the current window', () => {
    const rl = createRateLimiter({ maxRequests: 3, windowMs: 10_000 })
    expect(rl.remaining('k')).toBe(3)
    rl.allow('k')
    expect(rl.remaining('k')).toBe(2)
    rl.allow('k')
    rl.allow('k')
    expect(rl.remaining('k')).toBe(0)
  })

  it('reset() clears every key', () => {
    const rl = createRateLimiter({ maxRequests: 1, windowMs: 10_000 })
    rl.allow('a')
    rl.allow('b')
    expect(rl.allow('a')).toBe(false)
    expect(rl.allow('b')).toBe(false)
    rl.reset()
    expect(rl.allow('a')).toBe(true)
    expect(rl.allow('b')).toBe(true)
  })
})
