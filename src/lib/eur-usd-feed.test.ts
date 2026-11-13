import { describe, expect, it } from 'vitest'
import config from '@/config/eur-usd-feed.json'
import { isEurRateFresh, isFxClosedWindow, lastFxCloseMs, parseEurRatePayload, resolveEurUsdFeed } from './eur-usd-feed'

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

describe('market hours (owner decision: Friday 22:00 UTC to Sunday 22:00 UTC, grace to Monday 01:00 UTC)', () => {
  const at = (iso: string) => Date.parse(iso)
  const round = (iso: string) => ({ rate: 1.1, updatedAt: Date.parse(iso) / 1000, maxStaleness: 90000 })
  // 2026-11-13 is a Friday.
  it('the close and the window', () => {
    expect(new Date(lastFxCloseMs(at('2026-11-14T12:00:00Z'))).toISOString()).toBe('2026-11-13T22:00:00.000Z')
    expect(new Date(lastFxCloseMs(at('2026-11-13T21:59:00Z'))).toISOString()).toBe('2026-11-06T22:00:00.000Z') // Friday before the close: last week's
    expect(new Date(lastFxCloseMs(at('2026-11-13T22:00:00Z'))).toISOString()).toBe('2026-11-13T22:00:00.000Z')
    expect(isFxClosedWindow(at('2026-11-13T21:59:00Z'))).toBe(false)
    expect(isFxClosedWindow(at('2026-11-13T22:00:00Z'))).toBe(true)
    expect(isFxClosedWindow(at('2026-11-15T23:00:00Z'))).toBe(true) // Sunday after the reopen: still in the grace
    expect(isFxClosedWindow(at('2026-11-16T00:59:00Z'))).toBe(true)
    expect(isFxClosedWindow(at('2026-11-16T01:00:00Z'))).toBe(false)
    expect(isFxClosedWindow(at('2026-11-11T12:00:00Z'))).toBe(false) // Wednesday
  })
  it('SATURDAY with Friday\'s round → fresh (euros shown)', () => {
    expect(isEurRateFresh(round('2026-11-13T20:00:00Z'), at('2026-11-14T12:00:00Z'))).toBe(true)
    expect(isEurRateFresh(round('2026-11-13T21:59:00Z'), at('2026-11-15T10:00:00Z'))).toBe(true) // Sunday morning
  })
  it('the grace: Sunday evening and Monday before 01:00 UTC still accept Friday\'s round; from 01:00 UTC they do not', () => {
    expect(isEurRateFresh(round('2026-11-13T20:00:00Z'), at('2026-11-15T23:30:00Z'))).toBe(true)
    expect(isEurRateFresh(round('2026-11-13T20:00:00Z'), at('2026-11-16T00:59:00Z'))).toBe(true)
    expect(isEurRateFresh(round('2026-11-13T20:00:00Z'), at('2026-11-16T01:00:00Z'))).toBe(false)
    expect(isEurRateFresh(round('2026-11-13T20:00:00Z'), at('2026-11-16T09:00:00Z'))).toBe(false)
  })
  it('WEDNESDAY with a 30 h old round → stale (dollars, option disabled); 24 h old is still fine', () => {
    expect(isEurRateFresh(round('2026-11-10T06:00:00Z'), at('2026-11-11T12:00:00Z'))).toBe(false) // 30 h
    expect(isEurRateFresh(round('2026-11-10T12:30:00Z'), at('2026-11-11T12:00:00Z'))).toBe(true) // 23.5 h
  })
  it('Friday before the close: the 25 h ceiling still rules', () => {
    expect(isEurRateFresh(round('2026-11-12T10:00:00Z'), at('2026-11-13T21:00:00Z'))).toBe(false) // 35 h
  })
  it('a round that was already stale when the market closed stays stale all weekend', () => {
    expect(isEurRateFresh(round('2026-11-12T10:00:00Z'), at('2026-11-14T12:00:00Z'))).toBe(false) // 36 h old at the close
    expect(isEurRateFresh(round('2026-11-12T20:30:00Z'), at('2026-11-14T12:00:00Z'))).toBe(false) // 25.5 h at the close: past the 25 h ceiling
    expect(isEurRateFresh(round('2026-11-12T21:30:00Z'), at('2026-11-14T12:00:00Z'))).toBe(true) // 24.5 h at the close: within it
  })
  it('a round from the future is never trusted, weekend or not', () => {
    expect(isEurRateFresh(round('2026-11-14T13:00:00Z'), at('2026-11-14T12:00:00Z'))).toBe(false)
  })
})
