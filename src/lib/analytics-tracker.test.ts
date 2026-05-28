// @vitest-environment jsdom
/**
 * [P201] analytics-tracker — legacy plaintext → encrypted v2 migration.
 *
 * Verifies the one-time migration added in P200: legacy `teraswap_analytics_events`
 * (plaintext JSON) is read on first hydration, re-encrypted under the `_v2` key,
 * and the legacy key removed. Supabase is stubbed off so the tracker stays on
 * the localStorage path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Keep the tracker on the localStorage path (no network insert/select).
vi.mock('./supabase', () => ({
  getSupabase: () => null,
  isSupabaseEnabled: () => false,
}))

import { ensureAnalyticsHydrated, getEventCount } from './analytics-tracker'
import { ANALYTICS_STORAGE_KEY, type TradeEvent } from './analytics-types'
import { initSecureStorage } from './secure-storage'

const ANALYTICS_V2 = `${ANALYTICS_STORAGE_KEY}_v2`
const WALLET = '0x1111111111111111111111111111111111111111'

function makeEvent(id: string): TradeEvent {
  return {
    id,
    type: 'swap',
    wallet: WALLET,
    timestamp: 1_700_000_000_000,
    hour: 12,
    tokenIn: 'WETH',
    tokenInAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: 'USDC',
    tokenOutAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '1',
    amountOut: '3000',
    volumeUsd: 3000,
    feeUsd: 3,
    source: '1inch',
    txHash: id,
    chainId: 1,
  } as unknown as TradeEvent
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('analytics-tracker — migration', () => {
  it('migrates plaintext analytics to encrypted v2 on first hydration', async () => {
    // Seed the legacy plaintext v1 key.
    localStorage.setItem(
      ANALYTICS_STORAGE_KEY,
      JSON.stringify([makeEvent('a'), makeEvent('b')]),
    )

    // A connected wallet is required for the wallet-derived encryption key.
    initSecureStorage(WALLET)
    await ensureAnalyticsHydrated()

    // Events are readable, the legacy key is gone, and v2 holds an encrypted
    // payload (not the original plaintext array).
    expect(getEventCount()).toBe(2)
    expect(localStorage.getItem(ANALYTICS_STORAGE_KEY)).toBeNull()
    const v2 = localStorage.getItem(ANALYTICS_V2)
    expect(v2).not.toBeNull()
    expect(v2).not.toContain('"id":"a"')
    const payload = JSON.parse(v2 as string)
    expect(payload.v).toBe(1)
    expect(typeof payload.ct).toBe('string')
  })
})
