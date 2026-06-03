/**
 * [SPRINT-9O Part B] Tests for swap-selection fallback.
 *
 * When the BEST route fails the pre-swap FeeCollector simulation with a
 * conclusive revert (the mainnet Velora→Augustus "RouterNotWhitelisted" bug,
 * or any future on-chain revert), the swap flow must NOT dead-end the user on
 * the failing source — it walks the ranked alternatives and uses the first one
 * that works. These two pure helpers drive that:
 *   - orderFallbackSources: the ranked candidate list (best→worst, minus primary/CoW)
 *   - shouldFallbackToNextSource: which failures are worth trying another source for
 */
import { describe, it, expect } from 'vitest'
import { orderFallbackSources, shouldFallbackToNextSource } from './swap-fallback'

const q = (source: string, toAmount = '0') => ({ source, toAmount })

describe('orderFallbackSources', () => {
  it('returns the ranked alternatives after the primary (best→worst order preserved)', () => {
    const meta = { all: [q('velora'), q('uniswapv3'), q('kyberswap')] }
    expect(orderFallbackSources(meta, 'velora')).toEqual(['uniswapv3', 'kyberswap'])
  })

  it('excludes CoW by default (settled via a different signature flow, not the FeeCollector sim)', () => {
    const meta = { all: [q('velora'), q('cowswap'), q('uniswapv3')] }
    expect(orderFallbackSources(meta, 'velora')).toEqual(['uniswapv3'])
  })

  it('excludes the primary even when it is not ranked first (manual source pick)', () => {
    const meta = { all: [q('velora'), q('uniswapv3'), q('kyberswap')] }
    expect(orderFallbackSources(meta, 'uniswapv3')).toEqual(['velora', 'kyberswap'])
  })

  it('de-duplicates repeated sources', () => {
    const meta = { all: [q('velora'), q('uniswapv3'), q('uniswapv3'), q('kyberswap')] }
    expect(orderFallbackSources(meta, 'velora')).toEqual(['uniswapv3', 'kyberswap'])
  })

  it('honours a custom exclude list (still excludes the primary)', () => {
    const meta = { all: [q('velora'), q('odos'), q('uniswapv3')] }
    expect(orderFallbackSources(meta, 'velora', ['cowswap', 'odos'])).toEqual(['uniswapv3'])
  })

  it('returns [] when there are no alternatives', () => {
    expect(orderFallbackSources({ all: [q('velora')] }, 'velora')).toEqual([])
    expect(orderFallbackSources({ all: [] }, 'velora')).toEqual([])
  })
})

describe('shouldFallbackToNextSource', () => {
  it('falls back on a conclusive on-chain revert (the 9O Velora case)', () => {
    expect(shouldFallbackToNextSource(new Error('Router not whitelisted on the FeeCollector.'))).toBe(true)
    expect(shouldFallbackToNextSource(new Error('Transaction simulation failed — swap would revert on-chain.'))).toBe(true)
    expect(shouldFallbackToNextSource(new Error('execution reverted'))).toBe(true)
  })

  it('falls back on an unusable aggregator response (a safe source is used instead)', () => {
    expect(shouldFallbackToNextSource(new Error('Unrecognized swap function selector (0xabcd1234).'))).toBe(true)
    expect(shouldFallbackToNextSource(new Error('Swap recipient mismatch: calldata would send tokens to 0x1234...'))).toBe(true)
    expect(shouldFallbackToNextSource(new Error('Swap target address not whitelisted'))).toBe(true)
  })

  it('does NOT fall back when the user must take action (approval)', () => {
    expect(shouldFallbackToNextSource(new Error('Insufficient allowance for USDC. Please approve the FeeCollector first.'))).toBe(false)
  })

  it('does NOT fall back on a deliberate price-protection block', () => {
    expect(shouldFallbackToNextSource(new Error('Price guard: quote deviates 7% from the Chainlink reference.'))).toBe(false)
  })

  it('does NOT fall back when the user rejected the request', () => {
    expect(shouldFallbackToNextSource(new Error('User rejected the request'))).toBe(false)
  })

  it('defaults to falling back for unknown/transient errors (we have a working alternative)', () => {
    expect(shouldFallbackToNextSource(new Error('Velora price 504'))).toBe(true)
    expect(shouldFallbackToNextSource('a thrown string')).toBe(true)
    expect(shouldFallbackToNextSource(null)).toBe(true)
  })
})
