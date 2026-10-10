// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import DcaFloorConsentDialog, { floorConsentCopy } from '../DcaFloorConsentDialog'
import { DCA_NO_PRICE_FILL_CAP_MAX_USD as MAX } from '@/lib/order-engine/dca-floor-tier'

const dollars = (t: string) => [...t.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]))
const mockFetch = vi.fn()
beforeEach(() => { mockFetch.mockReset(); vi.stubGlobal('fetch', mockFetch) })

describe('DcaFloorConsentDialog cap copy [FEAT-DCA-FLOOR-TIERS]', () => {
  it('states the ceiling as "up to $MAX" when no effective cap is known or it equals MAX', () => {
    for (const eff of [undefined, null, MAX]) {
      expect(floorConsentCopy('unpriced', 'ETHFI', eff)).toBe(
        `No price source for ETHFI. Buys may execute at ANY price; each buy is capped at up to $${MAX} and flagged.`,
      )
    }
  })
  it('shows the effective value only when it is below MAX', () => {
    expect(floorConsentCopy('unpriced', 'X', 100)).toMatch(/capped at up to \$250 and flagged\. Currently \$100\.$/)
  })
  it('NEVER renders a number above MAX, whatever the API returned', () => {
    for (const eff of [MAX + 1, 1_000_000, Infinity, NaN, -3, 0]) {
      const nums = dollars(floorConsentCopy('unpriced', 'X', eff))
      expect(nums.length).toBeGreaterThan(0)
      for (const n of nums) expect(n).toBeLessThanOrEqual(MAX)
    }
  })
  it('component: an API answer above MAX is clamped in the rendered dialog; below MAX is shown', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ maxUsd: MAX, effectiveUsd: 99_999 }) })
    const { unmount } = render(<DcaFloorConsentDialog tier="unpriced" symbol="X" chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/dca-floor-cap?chainId=8453'))
    for (const n of dollars(screen.getByTestId('floor-consent-body').textContent!)) expect(n).toBeLessThanOrEqual(MAX)
    unmount()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ maxUsd: MAX, effectiveUsd: 40 }) })
    render(<DcaFloorConsentDialog tier="unpriced" symbol="X" chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('floor-consent-body').textContent).toMatch(/Currently \$40\./))
  })
  it('offchain-price copy is unchanged and does no cap fetch', () => {
    render(<DcaFloorConsentDialog tier="offchain-price" symbol="X" chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
