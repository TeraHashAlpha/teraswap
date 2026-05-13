/**
 * Unit tests for src/lib/split-router.ts — [11-L-01] safeBigInt sweep.
 *
 * Pins the malformed-input behaviour the auditor flagged: bare `BigInt()`
 * used to throw SyntaxError on `undefined` / `"NaN"` / non-numeric strings
 * coming back from a third-party quote source. The whole split-routing
 * engine should now degrade gracefully (empty/inferior route) instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fetchSplitQuotes, findBestSplit } from './split-router'
import { _setSafeBigIntWarn } from './utils'
import type { NormalizedQuote } from './adapters'

function quote(source: string, toAmount: string): NormalizedQuote {
  return {
    source: source as NormalizedQuote['source'],
    toAmount,
    estimatedGas: 200_000,
    gasUsd: 1,
    routes: [source],
  }
}

describe('split-router — safeBigInt fallback (11-L-01)', () => {
  beforeEach(() => _setSafeBigIntWarn(false))
  afterEach(() => _setSafeBigIntWarn(true))

  it('fetchSplitQuotes returns empty map when totalAmount is malformed', async () => {
    const result = await fetchSplitQuotes(async () => [], 'NaN', [])
    expect(result.size).toBe(0)
  })

  it('fetchSplitQuotes returns empty map when totalAmount is empty', async () => {
    const result = await fetchSplitQuotes(async () => [], '', [])
    expect(result.size).toBe(0)
  })

  it('fetchSplitQuotes returns empty map when totalAmount is undefined-cast', async () => {
    // Cast undefined to satisfy the string signature — simulates a stale cache value.
    const result = await fetchSplitQuotes(async () => [], undefined as unknown as string, [])
    expect(result.size).toBe(0)
  })

  it('findBestSplit does not throw on malformed bestSingle.toAmount', () => {
    const malformed = quote('1inch', 'NaN')
    expect(() => findBestSplit(new Map(), '1000', malformed)).not.toThrow()
  })

  it('findBestSplit returns a defined route on malformed input (graceful degradation)', () => {
    const malformed = quote('1inch', 'not_a_number')
    const route = findBestSplit(new Map(), '1000', malformed)
    expect(route).toBeDefined()
    expect(route.isSplit).toBe(false)
  })
})
