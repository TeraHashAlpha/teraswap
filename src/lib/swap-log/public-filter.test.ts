// @vitest-environment node
/**
 * [ADR-029, details D] The flag and the one function every public reader of `swaps` goes through.
 * The readers themselves are proved against main in src/app/api/swaps-readers.differential.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { publicSwaps, swapsPublicVerifiedOnly } from './public-filter'

const saved = process.env.SWAPS_PUBLIC_VERIFIED_ONLY
afterEach(() => {
  if (saved === undefined) delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
  else process.env.SWAPS_PUBLIC_VERIFIED_ONLY = saved
})

function query() {
  const q = { not: vi.fn(), marker: Symbol('query') }
  q.not.mockReturnValue({ filtered: q.marker })
  return q
}

describe('SWAPS_PUBLIC_VERIFIED_ONLY', () => {
  it('is off when unset: the default', () => {
    delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
    expect(swapsPublicVerifiedOnly()).toBe(false)
  })

  it.each(['', 'false', '0', '1', 'TRUE', 'True', 'yes', 'on', ' true', 'true ', 'true\n'])('is off for %j: only the exact value "true" turns it on', (value) => {
    process.env.SWAPS_PUBLIC_VERIFIED_ONLY = value
    expect(swapsPublicVerifiedOnly()).toBe(false)
  })

  it('is on for "true"', () => {
    process.env.SWAPS_PUBLIC_VERIFIED_ONLY = 'true'
    expect(swapsPublicVerifiedOnly()).toBe(true)
  })

  it('is read on every call, not once at start-up: turning it on needs no new build', () => {
    delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
    expect(swapsPublicVerifiedOnly()).toBe(false)
    process.env.SWAPS_PUBLIC_VERIFIED_ONLY = 'true'
    expect(swapsPublicVerifiedOnly()).toBe(true)
  })
})

describe('publicSwaps', () => {
  it('flag off: the SAME query object comes back and nothing was called on it', () => {
    delete process.env.SWAPS_PUBLIC_VERIFIED_ONLY
    const q = query()
    expect(publicSwaps(q)).toBe(q)
    expect(q.not).not.toHaveBeenCalled()
  })

  it('flag on: one filter, verified_at IS NOT NULL, and its result is what the reader continues with', () => {
    process.env.SWAPS_PUBLIC_VERIFIED_ONLY = 'true'
    const q = query()
    expect(publicSwaps(q)).toEqual({ filtered: q.marker })
    expect(q.not).toHaveBeenCalledTimes(1)
    expect(q.not).toHaveBeenCalledWith('verified_at', 'is', null)
  })
})
