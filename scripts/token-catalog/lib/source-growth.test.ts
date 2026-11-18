/**
 * [fix/catalog-refresh-drops-untrusted] Growth breaker (rule A) — boundaries, first appearance, the owner's
 * accepted sizes, the rebuilt snapshot, the strict parser of accepted-source-sizes.json. No network.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogRow, SourceCounts } from './types'
import { ACCEPTED_SIZES_FILE, evaluateSourceGrowth, exceedsGrowth, parseAcceptedSizes, snapshotEntries } from './source-growth'

const held = (previous: SourceCounts | undefined, current: SourceCounts, accepted?: Partial<Record<'oneinch' | 'coingecko', number>>) =>
  evaluateSourceGrowth({ chainId: 1, previousCounts: previous, currentCounts: current, accepted })

describe('exceedsGrowth — "more than 50%", integer math', () => {
  it('exactly 50% growth is NOT held back; 50% plus one entry is', () => {
    expect(exceedsGrowth(100, 150)).toBe(false)
    expect(exceedsGrowth(100, 151)).toBe(true)
    // the real mainnet size: 1074 * 1.5 = 1611 exactly
    expect(exceedsGrowth(1074, 1611)).toBe(false)
    expect(exceedsGrowth(1074, 1612)).toBe(true)
  })
  it('an odd baseline: 7 → 10 is +42.9% (kept), 7 → 11 is +57% (held)', () => {
    expect(exceedsGrowth(7, 10)).toBe(false)
    expect(exceedsGrowth(7, 11)).toBe(true)
  })
  it('no change, shrinking and a dead (0) source are never "growth"', () => {
    expect(exceedsGrowth(100, 100)).toBe(false)
    expect(exceedsGrowth(100, 40)).toBe(false)
    expect(exceedsGrowth(100, 0)).toBe(false)
  })
})

describe('evaluateSourceGrowth', () => {
  it('the three real 1inch cases (2026-11-16 → 2026-11-18) are all held back', () => {
    const cases: Array<[number, number, number]> = [[1, 1074, 3203], [8453, 194, 337], [42161, 137, 5069]]
    for (const [chainId, previous, current] of cases) {
      const r = evaluateSourceGrowth({ chainId, previousCounts: { oneinch: previous, uniswap: 479 }, currentCounts: { oneinch: current, uniswap: 479 } })
      expect(r).toEqual([{ chainId, source: 'oneinch', previous, current, baseline: previous }])
    }
  })
  it('only the over-threshold source is held; the others carry on', () => {
    const r = held({ uniswap: 479, coingecko: 6115, oneinch: 1074 }, { uniswap: 500, coingecko: 5800, oneinch: 3203 })
    expect(r.map((h) => h.source)).toEqual(['oneinch'])
  })
  it('boundary through the whole function: exactly 50% used, +1 entry held', () => {
    expect(held({ oneinch: 200 }, { oneinch: 300 })).toEqual([])
    expect(held({ oneinch: 200 }, { oneinch: 301 }).map((h) => h.source)).toEqual(['oneinch'])
  })
  it('a source appearing for the first time (no previous size for it) is used, whatever its size', () => {
    expect(held({ uniswap: 479 }, { uniswap: 479, oneinch: 9999 })).toEqual([])
    expect(held({ uniswap: 479, oneinch: 0 }, { uniswap: 479, oneinch: 9999 })).toEqual([])
  })
  it('a chain with no previous snapshot at all is used', () => {
    expect(held(undefined, { oneinch: 9999, uniswap: 1 })).toEqual([])
    expect(held({}, { oneinch: 9999 })).toEqual([])
  })
  it('a source that is not fetched this run is not "grown" (the outage breaker owns that case)', () => {
    expect(held({ oneinch: 100 }, {})).toEqual([])
  })

  describe('the owner accepts a size (accepted-source-sizes.json)', () => {
    it('accepting the current size releases the source', () => {
      expect(held({ oneinch: 1074 }, { oneinch: 3203 }, { oneinch: 3203 })).toEqual([])
    })
    it('the baseline becomes the accepted size: +50% over IT is the next threshold', () => {
      expect(held({ oneinch: 1074 }, { oneinch: 4804 }, { oneinch: 3203 })).toEqual([]) // 3203 * 1.5 = 4804.5
      expect(held({ oneinch: 1074 }, { oneinch: 4805 }, { oneinch: 3203 }).map((h) => h.baseline)).toEqual([3203])
    })
    it('an accepted size SMALLER than the previous size changes nothing (baseline = max)', () => {
      expect(held({ oneinch: 1000 }, { oneinch: 1600 }, { oneinch: 10 }).map((h) => h.baseline)).toEqual([1000])
    })
    it('accepting one source does not release another', () => {
      const r = held({ oneinch: 100, coingecko: 100 }, { oneinch: 500, coingecko: 500 }, { oneinch: 500 })
      expect(r.map((h) => h.source)).toEqual(['coingecko'])
    })
  })
})

describe('snapshotEntries — the previous run\'s view of a source, from the previous catalog', () => {
  const row = (n: number, sources: CatalogRow['sources']): CatalogRow => ({
    address: `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`, symbol: `T${n}`, name: `Token ${n}`, decimals: 6 + n, category: 'Other',
    logoURI: `/api/token-logo?chainId=1&address=x${n}`, verified: true, sources, volume24hUsd: null, volumeSource: null, volumeFetchedAt: null,
  })
  it('keeps exactly the rows that list the source, as source entries (no catalog logo path)', () => {
    const rows = [row(1, ['uniswap', 'oneinch']), row(2, ['uniswap', 'coingecko']), row(3, ['oneinch', 'trustwallet']), row(4, [])]
    const e = snapshotEntries(1, 'oneinch', rows)
    expect(e.map((x) => x.symbol)).toEqual(['T1', 'T3'])
    expect(e[0]).toEqual({ chainId: 1, address: rows[0].address, symbol: 'T1', name: 'Token 1', decimals: 7, source: 'oneinch' })
    expect(e.every((x) => x.logoURI === undefined)).toBe(true)
  })
  it('an empty previous catalog gives an empty snapshot', () => {
    expect(snapshotEntries(1, 'oneinch', [])).toEqual([])
  })
})

describe('parseAcceptedSizes — strict', () => {
  it('reads this chain\'s lines and ignores $comment and other chains', () => {
    const raw = { $comment: 'x', '1:oneinch': 3203, '8453:oneinch': 337, '42161:oneinch': 5069 }
    expect(parseAcceptedSizes(raw, 1)).toEqual({ oneinch: 3203 })
    expect(parseAcceptedSizes(raw, 8453)).toEqual({ oneinch: 337 })
    expect(parseAcceptedSizes(raw, 137)).toEqual({})
  })
  it.each([
    ['unknown source', { '1:nope': 5 }],
    ['no chain id', { oneinch: 5 }],
    ['zero', { '1:oneinch': 0 }],
    ['negative', { '1:oneinch': -5 }],
    ['fraction', { '1:oneinch': 5.5 }],
    ['string', { '1:oneinch': '5' }],
    ['null', { '1:oneinch': null }],
  ])('a malformed line throws (%s) — never "nothing accepted" by accident', (_n, raw) => {
    expect(() => parseAcceptedSizes(raw, 1)).toThrow(/accepted-source-sizes/)
  })
  it.each([[null], [[]], ['x'], [5]])('a non-object file throws (%j)', (raw) => {
    expect(() => parseAcceptedSizes(raw, 1)).toThrow(/expected a JSON object/)
  })
  it('the committed file parses for every chain and accepts nothing yet', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', ACCEPTED_SIZES_FILE), 'utf8'))
    for (const c of [1, 8453, 42161]) expect(parseAcceptedSizes(raw, c)).toEqual({})
  })
})
