// @vitest-environment jsdom
/**
 * [CHORE-DCA-UX-FIXES] Bug 3b — the active-order poll must catch TERMINAL transitions.
 *
 * fetchActiveOrders feeds the in-app poll. It used to request only active/executing/partially_filled,
 * so when the keeper marked an order 'failed' (or 'executed'/'cancelled'/'expired') the poll never saw
 * the change — the order stayed "active" in the UI forever / silently vanished from where the user
 * expected it. It must also request the terminal statuses so a failed order surfaces as "Failed".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchActiveOrders } from './supabase'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ orders: [] }) })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('fetchActiveOrders — poll query', () => {
  it('requests terminal statuses too, so a keeper-failed order is caught by the poll', async () => {
    await fetchActiveOrders('0xABCdef0000000000000000000000000000000001')
    const url = String(fetchMock.mock.calls[0][0])
    // Still tracks live statuses…
    expect(url).toContain('active')
    expect(url).toContain('executing')
    expect(url).toContain('partially_filled')
    // …and now the terminal ones so transitions are detected (never stuck/vanished).
    expect(url).toContain('failed')
    expect(url).toContain('executed')
    expect(url).toContain('cancelled')
    expect(url).toContain('expired')
  })
})
