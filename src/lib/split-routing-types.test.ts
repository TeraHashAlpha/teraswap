/**
 * [fix/quote-rate-limit-normal-use] The two rules the batched split analysis shares between server and browser.
 */
import { describe, it, expect } from 'vitest'
import { fetchSplitQuotes } from './split-router'
import { SPLIT_MAX_AGE_MS, isSplitQuoteStale, splitSubAmounts } from './split-routing-types'
import { QUOTE_REFRESH_MS } from './constants'

describe('splitSubAmounts', () => {
  it('is exactly what the router asks a quote for, for large, odd and tiny totals', async () => {
    for (const total of ['1000000000000000000', '3333300000000000001', '123456789', '100', '7', '2', '1']) {
      const asked: string[] = []
      await fetchSplitQuotes(async (amount) => { asked.push(amount); return [] }, total, [])
      expect(splitSubAmounts(BigInt(total)).sort(), total).toEqual([...new Set(asked)].sort())
    }
  })

  it('a full-size total has the 11 sub-amounts one analysis is charged for', () => {
    expect(splitSubAmounts(10n ** 18n)).toHaveLength(11)
  })
})

describe('isSplitQuoteStale', () => {
  it('allows one poll interval and no more; no timestamp is stale', () => {
    expect(SPLIT_MAX_AGE_MS).toBe(QUOTE_REFRESH_MS)
    expect(isSplitQuoteStale({ fetchedAt: 100_000 }, 100_000 + 15_000)).toBe(false)
    expect(isSplitQuoteStale({ fetchedAt: 100_000 }, 100_000 + 15_001)).toBe(true)
    expect(isSplitQuoteStale({} as { fetchedAt: number }, 100_000)).toBe(true)
    expect(isSplitQuoteStale(null, 100_000)).toBe(true)
  })
})
