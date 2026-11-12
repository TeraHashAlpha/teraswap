// @vitest-environment jsdom
/**
 * [fix/privacy-no-usage-tracking] The wallet activity tracker (orders / swaps / approvals / quotes keyed by wallet)
 * no longer stores or sends a per-tab session id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const beacon = vi.fn((_url: string, _blob: Blob) => true)

beforeEach(() => {
  beacon.mockClear()
  try { sessionStorage.clear() } catch { /* jsdom storage unavailable */ }
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true })
})

describe('trackWalletActivity', () => {
  it('sends the wallet event without a session id and stores none', async () => {
    vi.useFakeTimers()
    const { trackWalletActivity } = await import('./wallet-activity-tracker')
    trackWalletActivity('0xAbC0000000000000000000000000000000000001', { category: 'quote', action: 'quote_ok', source: '1inch' })
    await vi.advanceTimersByTimeAsync(6_000)
    vi.useRealTimers()

    expect(beacon).toHaveBeenCalledTimes(1)
    const [url, blob] = beacon.mock.calls[0]
    expect(url).toBe('/api/log-activity')
    const body = JSON.parse(await blob.text())
    expect(body.events).toHaveLength(1)
    expect(body.events[0].wallet).toBe('0xabc0000000000000000000000000000000000001')
    expect(body.events[0]).not.toHaveProperty('session_id')
    expect(sessionStorage.getItem('teraswap_session_id')).toBeNull()
  })
})
