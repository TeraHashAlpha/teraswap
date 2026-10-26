/**
 * [chore/copy-leftovers] The tier notice (QuoteBreakdown, driven by GET /api/swap-price-tier) is the single
 * source of truth for "this price is not independently verified". The blue SwapBox "No oracle available …
 * aggregator quotes only" notice duplicated it (two notices on production, 2026-10-26) and must not return.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })
}

describe('no legacy blue oracle notice', () => {
  it('no component renders "No oracle available" or "aggregator quotes only"', () => {
    const hits = sources(join(__dirname)).filter((p) => /No oracle available|aggregator quotes only/.test(readFileSync(p, 'utf8')))
    expect(hits).toEqual([])
  })
})
