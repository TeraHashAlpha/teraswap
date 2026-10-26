// @vitest-environment jsdom
/**
 * [feat/swap-price-tiers] useSwapPriceTier — the browser asks GET /api/swap-price-tier for the pair's tier
 * (D1: the server is the authority). Anything but a well-formed 2xx is UNKNOWN (null): the client then
 * shows nothing and lets /api/swap decide (a 409 reopens the consent dialog) — never a guessed tier.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSwapPriceTier } from './useSwapPriceTier'

const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
const ETHFI = '0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2'
const PRICED = {
  tier: 'priced',
  legs: {
    in: { tier: 'priced', sources: ['defillama', 'coingecko'], usd: 0.69, agreementBps: 2 },
    out: { tier: 'priced', sources: ['defillama', 'coingecko'], usd: 0.64, agreementBps: 3 },
  },
  agreementBps: 3,
}
const UNPRICED = { tier: 'unpriced', legs: { in: { tier: 'unpriced', sources: [] }, out: { tier: 'unpriced', sources: [] } } }

function stubFetch(body: unknown, status = 200) {
  return vi.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}
afterEach(() => vi.restoreAllMocks())

describe('useSwapPriceTier', () => {
  it('asks GET /api/swap-price-tier for the pair on the active chain and exposes the parsed answer', async () => {
    const f = stubFetch(PRICED)
    const { result } = renderHook(() => useSwapPriceTier(8453, AERO, ETHFI))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.data?.tier).toBe('priced'))
    expect(result.current.loading).toBe(false)
    expect(String(f.mock.calls[0][0])).toBe(
      `/api/swap-price-tier?chainId=8453&tokenIn=${encodeURIComponent(AERO)}&tokenOut=${encodeURIComponent(ETHFI)}`,
    )
    expect(result.current.data).toEqual(PRICED)
  })

  it('a missing leg asks nothing and is unknown (null)', () => {
    const f = stubFetch(PRICED)
    const { result } = renderHook(() => useSwapPriceTier(8453, AERO, undefined))
    expect(result.current).toEqual({ data: null, loading: false })
    expect(f).not.toHaveBeenCalled()
  })

  it('`enabled: false` asks nothing', () => {
    const f = stubFetch(PRICED)
    renderHook(() => useSwapPriceTier(8453, AERO, ETHFI, false))
    expect(f).not.toHaveBeenCalled()
  })

  it('a non-2xx, a network error or a malformed body is UNKNOWN (null) — the client never guesses a tier (D1)', async () => {
    const bads = [
      () => stubFetch({ error: 'x' }, 500),
      () => stubFetch({ tier: 'blocked', legs: {} }),
      () => vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('offline')),
    ]
    for (const bad of bads) {
      bad()
      const { result, unmount } = renderHook(() => useSwapPriceTier(8453, AERO, ETHFI))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.data).toBeNull()
      unmount()
      vi.restoreAllMocks()
    }
  })

  it('re-asks when the pair changes and drops the previous answer meanwhile', async () => {
    const f = stubFetch(PRICED)
    const { result, rerender } = renderHook(
      ({ c, a, b }: { c: number; a: string; b: string }) => useSwapPriceTier(c, a, b),
      { initialProps: { c: 8453, a: AERO, b: ETHFI } },
    )
    await waitFor(() => expect(result.current.data?.tier).toBe('priced'))
    f.mockImplementation(async () => new Response(JSON.stringify(UNPRICED), { status: 200 }))
    rerender({ c: 8453, a: ETHFI, b: AERO })
    expect(result.current.data).toBeNull()
    await waitFor(() => expect(result.current.data?.tier).toBe('unpriced'))
    expect(f).toHaveBeenCalledTimes(2)
    expect(String(f.mock.calls[1][0])).toContain(`tokenIn=${encodeURIComponent(ETHFI)}`)
  })
})
