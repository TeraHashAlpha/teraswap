import { describe, it, expect } from 'vitest'
import type { CatalogRow } from './types'
import { diffCatalogs, formatDiffSummary } from './diff-report'

function row(p: Partial<CatalogRow>): CatalogRow {
  return {
    address: '0x0000000000000000000000000000000000000001',
    symbol: 'FOO',
    name: 'Foo',
    decimals: 18,
    category: 'Other',
    logoURI: '/tokens/foo.png',
    verified: true,
    sources: ['uniswap', 'coingecko'],
    volume24hUsd: null,
    volumeSource: null,
    volumeFetchedAt: null,
    ...p,
  }
}

describe('diffCatalogs', () => {
  it('reports no diff for identical catalogs', () => {
    const a = [row({ address: '0x1' as `0x${string}`, symbol: 'A' })]
    expect(diffCatalogs(a, a)).toEqual({ added: [], removed: [], changed: [] })
  })

  it('reports an added row', () => {
    const before = [row({ address: '0x1' as `0x${string}`, symbol: 'A' })]
    const after = [...before, row({ address: '0x2' as `0x${string}`, symbol: 'B' })]
    const diff = diffCatalogs(before, after)
    expect(diff.added.map((t) => t.symbol)).toEqual(['B'])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
  })

  it('reports a removed row', () => {
    const before = [row({ address: '0x1' as `0x${string}`, symbol: 'A' }), row({ address: '0x2' as `0x${string}`, symbol: 'B' })]
    const after = [before[0]]
    const diff = diffCatalogs(before, after)
    expect(diff.removed.map((t) => t.symbol)).toEqual(['B'])
    expect(diff.added).toEqual([])
  })

  it('reports a changed row (same address, different field)', () => {
    const before = [row({ address: '0x1' as `0x${string}`, symbol: 'A', verified: false })]
    const after = [row({ address: '0x1' as `0x${string}`, symbol: 'A', verified: true })]
    const diff = diffCatalogs(before, after)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0].before.verified).toBe(false)
    expect(diff.changed[0].after.verified).toBe(true)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
  })

  it('matches addresses case-insensitively for identity (not misfiled as added+removed)', () => {
    const before = [row({ address: '0xABCDEF0000000000000000000000000000000001' as `0x${string}` })]
    const after = [row({ address: '0xabcdef0000000000000000000000000000000001' as `0x${string}` })]
    const diff = diffCatalogs(before, after)
    // same logical token — a casing-only change surfaces as one "changed" row, never as an
    // unrelated add + remove pair (which would misreport it as delisted+relisted).
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toHaveLength(1)
  })

  it('formats a human-readable summary line', () => {
    const before: CatalogRow[] = []
    const after = [row({ address: '0x1' as `0x${string}`, symbol: 'A' })]
    const summary = formatDiffSummary(1, diffCatalogs(before, after))
    expect(summary).toContain('chain 1: +1 added, -0 removed, ~0 changed')
    expect(summary).toContain('+ A 0x1')
  })
})
