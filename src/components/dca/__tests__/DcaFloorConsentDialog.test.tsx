// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import DcaFloorConsentDialog, { floorConsentCopy } from '../DcaFloorConsentDialog'
import { DCA_NO_PRICE_FILL_CAP_MAX_USD as MAX } from '@/lib/order-engine/dca-floor-tier'

const dollars = (t: string) => [...t.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]))
const mockFetch = vi.fn()
beforeEach(() => { mockFetch.mockReset(); vi.stubGlobal('fetch', mockFetch) })
const api = (j: Record<string, unknown>) => mockFetch.mockResolvedValue({ ok: true, json: async () => ({ maxUsd: MAX, effectiveUsd: MAX, ...j }) })
const body = () => screen.getByTestId('floor-consent-body').textContent ?? ''

// Owner-chosen copy (2026-10-11), pinned verbatim.
const OFFCHAIN = (lead: string, sym: string) =>
  `${lead} a Chainlink price feed registered in our contract, which lets the contract reject a bad fill on its own. ${sym} doesn't have one yet, so protection comes from our executor instead — it checks each buy against live market prices and holds the buy if they disagree. This is how most tokens work today.`
const UNPRICED = (lead: string, sym: string, cap: number) =>
  `${lead} a Chainlink price feed registered in our contract. ${sym} doesn't, and at the moment no market price source is answering for it, so the executor can't check the fill. To limit risk, each buy is capped at $${cap} and flagged. Buys resume normal protection when a price source comes back.`
const FALLBACK_LEAD = 'A small set of tokens on this network have'

describe('DcaFloorConsentDialog copy [fix/dca-consent-copy-and-tier-check]', () => {
  it('heading and checkbox label are exact; buttons unchanged', () => {
    api({ registeredFeedCount: 7 })
    render(<DcaFloorConsentDialog tier="offchain-price" symbols={['AAVE']} chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByTestId('floor-consent-heading').textContent).toBe('How DCA buys are protected')
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('floor-consent-heading')
    expect(screen.getByTestId('floor-consent-checkbox').closest('label')!.textContent).toBe('Got it — continue')
    expect(screen.getByTestId('floor-consent-cancel').textContent).toBe('Cancel')
    expect(screen.getByTestId('floor-consent-confirm').textContent).toBe('Continue')
  })

  it('offchain-price: N comes from the API (registeredFeedCount), exact copy', async () => {
    api({ registeredFeedCount: 7 })
    render(<DcaFloorConsentDialog tier="offchain-price" symbols={['AAVE']} chainId={42161} onConfirm={() => {}} onCancel={() => {}} />)
    await waitFor(() => expect(body()).toBe(OFFCHAIN('7 tokens on this network have', 'AAVE')))
    expect(mockFetch).toHaveBeenCalledWith('/api/dca-floor-cap?chainId=42161')
  })

  it('unpriced: N from the API and the cap, exact copy', async () => {
    api({ registeredFeedCount: 12 })
    render(<DcaFloorConsentDialog tier="unpriced" symbols={['UNI']} chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
    await waitFor(() => expect(body()).toBe(UNPRICED('12 tokens on this network have', 'UNI', MAX)))
  })

  it('both legs without a feed read "A and B"', () => {
    expect(floorConsentCopy({ tier: 'offchain-price', symbols: ['ETH', 'AAVE'], registeredFeedCount: 3 })).toBe(OFFCHAIN('3 tokens on this network have', 'ETH and AAVE'))
    expect(floorConsentCopy({ tier: 'unpriced', symbols: ['ETH', 'AAVE'], registeredFeedCount: 3 })).toBe(UNPRICED('3 tokens on this network have', 'ETH and AAVE', MAX))
  })

  it('fallback: N missing / null / 0 / junk renders without a number — never "0 tokens"', () => {
    for (const n of [undefined, null, 0, -1, 2.5, NaN]) {
      for (const tier of ['offchain-price', 'unpriced'] as const) {
        const text = floorConsentCopy({ tier, symbols: ['AAVE'], registeredFeedCount: n })
        expect(text.startsWith(`${FALLBACK_LEAD} a Chainlink price feed`)).toBe(true)
        expect(text).not.toMatch(/\b0 tokens?\b/)
      }
    }
    expect(floorConsentCopy({ tier: 'offchain-price', symbols: ['AAVE'], registeredFeedCount: 0 })).toBe(OFFCHAIN(FALLBACK_LEAD, 'AAVE'))
  })

  it('fallback in the component: API failure, non-OK or no field → no number', async () => {
    for (const setup of [
      () => mockFetch.mockRejectedValue(new TypeError('Failed to fetch')),
      () => mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) }),
      () => api({ registeredFeedCount: null }),
      () => api({ registeredFeedCount: 0 }),
      () => mockFetch.mockResolvedValue({ ok: true, json: async () => ({ maxUsd: MAX, effectiveUsd: MAX }) }),
    ]) {
      mockFetch.mockReset(); setup()
      const { unmount } = render(<DcaFloorConsentDialog tier="offchain-price" symbols={['AAVE']} chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
      await waitFor(() => expect(mockFetch).toHaveBeenCalled())
      // Let the response settle and any state update land: the fallback is ALSO the initial render.
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      expect(body()).toBe(OFFCHAIN(FALLBACK_LEAD, 'AAVE'))
      expect(body()).not.toMatch(/\b0 tokens?\b/)
      unmount()
    }
  })

  it('a count of 1 is singular', () => {
    expect(floorConsentCopy({ tier: 'offchain-price', symbols: ['AAVE'], registeredFeedCount: 1 }).startsWith('1 token on this network has a Chainlink price feed')).toBe(true)
  })

  it('submit is blocked until the checkbox is ticked; Cancel always works', () => {
    api({ registeredFeedCount: 7 })
    const onConfirm = vi.fn(); const onCancel = vi.fn()
    render(<DcaFloorConsentDialog tier="unpriced" symbols={['UNI']} chainId={8453} onConfirm={onConfirm} onCancel={onCancel} />)
    const confirm = screen.getByTestId('floor-consent-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('floor-consent-checkbox'))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('floor-consent-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('DcaFloorConsentDialog cap [FEAT-DCA-FLOOR-TIERS]', () => {
  it('the cap is MAX when no effective cap is known or it equals MAX', () => {
    for (const eff of [undefined, null, MAX]) {
      expect(floorConsentCopy({ tier: 'unpriced', symbols: ['ETHFI'], effectiveCapUsd: eff, registeredFeedCount: 2 })).toBe(UNPRICED('2 tokens on this network have', 'ETHFI', MAX))
    }
  })
  it('an effective cap below MAX is the figure shown', () => {
    expect(floorConsentCopy({ tier: 'unpriced', symbols: ['X'], effectiveCapUsd: 100, registeredFeedCount: 2 })).toBe(UNPRICED('2 tokens on this network have', 'X', 100))
  })
  it('NEVER renders a number above MAX, whatever the API returned', () => {
    for (const eff of [MAX + 1, 1_000_000, Infinity, NaN, -3, 0]) {
      const nums = dollars(floorConsentCopy({ tier: 'unpriced', symbols: ['X'], effectiveCapUsd: eff }))
      expect(nums.length).toBeGreaterThan(0)
      for (const n of nums) expect(n).toBeLessThanOrEqual(MAX)
    }
  })
  it('component: an API answer above MAX is clamped in the rendered dialog; below MAX is shown', async () => {
    api({ effectiveUsd: 99_999, registeredFeedCount: 2 })
    const { unmount } = render(<DcaFloorConsentDialog tier="unpriced" symbols={['X']} chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
    await waitFor(() => expect(body()).toMatch(/^2 tokens/))
    for (const n of dollars(body())) expect(n).toBeLessThanOrEqual(MAX)
    unmount()
    api({ effectiveUsd: 40, registeredFeedCount: 2 })
    render(<DcaFloorConsentDialog tier="unpriced" symbols={['X']} chainId={8453} onConfirm={() => {}} onCancel={() => {}} />)
    await waitFor(() => expect(body()).toMatch(/capped at \$40 and flagged\./))
  })
})
