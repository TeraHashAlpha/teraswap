import { describe, expect, it } from 'vitest'
import config from '@/config/eur-usd-feed.json'
import { isEurRateFresh, parseEurRatePayload, resolveEurUsdFeed } from './eur-usd-feed'

describe('resolveEurUsdFeed', () => {
  it('the address is the config row (generated from the Chainlink directory), never typed in code', () => {
    const row = (config.chains as Record<string, { feed: string }>)['1']
    for (const chainId of [1, 8453, 42161]) {
      const f = resolveEurUsdFeed(chainId)
      expect(f?.feed, `chain ${chainId}`).toBe(row.feed)
      expect(f?.chainId, 'no EUR/USD row on L2s: the mainnet feed is read through the server').toBe(1)
    }
    expect(config.chains['1']).toMatchObject({ description: 'EUR / USD', decimals: 8, heartbeat: 86400, maxStaleness: 90000 })
  })
})

describe('payload', () => {
  it('parse rejects anything that is not a positive finite triple', () => {
    expect(parseEurRatePayload({ rate: 1.1, updatedAt: 1, maxStaleness: 2 })).toEqual({ rate: 1.1, updatedAt: 1, maxStaleness: 2 })
    for (const bad of [null, 1, {}, { rate: 0, updatedAt: 1, maxStaleness: 2 }, { rate: '1', updatedAt: 1, maxStaleness: 2 }, { rate: 1, updatedAt: NaN, maxStaleness: 2 }, { rate: 1, updatedAt: 1, maxStaleness: -1 }]) {
      expect(parseEurRatePayload(bad)).toBeNull()
    }
  })
  it('fresh ≤ maxStaleness old; older or from the future is not', () => {
    const now = 1_700_000_000_000
    const p = { rate: 1.1, updatedAt: now / 1000 - 1000, maxStaleness: 90000 }
    expect(isEurRateFresh(p, now)).toBe(true)
    expect(isEurRateFresh({ ...p, updatedAt: now / 1000 - 90001 }, now)).toBe(false)
    expect(isEurRateFresh({ ...p, updatedAt: now / 1000 + 3600 }, now)).toBe(false)
  })
})
