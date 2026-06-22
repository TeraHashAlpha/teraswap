import { describe, it, expect } from 'vitest'
import { quickFillRaw, perChunkRaw } from './dca-quick-fill'

const ONE = 10n ** 18n // 1 WETH in smallest units (18 decimals)

describe('quickFillRaw — DCA quick-fill % presets (BigInt, no float drift)', () => {
  it('25% of 1 WETH = 0.25 WETH (exact)', () => {
    expect(quickFillRaw(ONE, 25)).toBe(ONE / 4n)
  })

  it('50% of 1 WETH = 0.5 WETH (exact)', () => {
    expect(quickFillRaw(ONE, 50)).toBe(ONE / 2n)
  })

  it('100% returns the full balance unchanged — exact to the wei', () => {
    // 1.000000000000000001 WETH: a Number() round-trip drops the trailing +1 wei.
    const odd = ONE + 1n
    expect(quickFillRaw(odd, 100)).toBe(odd)
  })

  it('uses floor division (never rounds up) for odd splits', () => {
    expect(quickFillRaw(3n, 50)).toBe(1n) // floor(1.5) = 1
    expect(quickFillRaw(1n, 50)).toBe(0n) // floor(0.5) = 0
  })

  it('preserves wei-level precision a float path would lose', () => {
    const weird = 123456789012345679n // ~0.1234… WETH, odd
    expect(quickFillRaw(weird, 50)).toBe(weird / 2n)
    expect(quickFillRaw(weird, 100)).toBe(weird)
  })

  it('zero balance or non-positive percent → 0n (buttons stay disabled)', () => {
    expect(quickFillRaw(0n, 100)).toBe(0n)
    expect(quickFillRaw(ONE, 0)).toBe(0n)
    expect(quickFillRaw(ONE, -25)).toBe(0n)
  })
})

describe('perChunkRaw — per-buy floor split (mirrors contract / useOrderEngine)', () => {
  it('splits the total across N buys with floor division', () => {
    expect(perChunkRaw(100n, 7)).toBe(14n) // floor(100/7)
    expect(perChunkRaw(ONE, 4)).toBe(ONE / 4n)
  })

  it('surfaces a per-chunk under the 10,000 base-unit MIN floor', () => {
    // 50,000 base units over 7 buys ⇒ 7,142 < 10,000 floor
    expect(perChunkRaw(50_000n, 7)).toBe(7_142n)
    expect(perChunkRaw(50_000n, 7) < 10_000n).toBe(true)
  })

  it('parts ≤ 0 or non-positive total → 0n (guard)', () => {
    expect(perChunkRaw(ONE, 0)).toBe(0n)
    expect(perChunkRaw(0n, 7)).toBe(0n)
  })
})
