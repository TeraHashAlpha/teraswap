// @vitest-environment jsdom
/**
 * [FIX-FOOTER-BLOCKNUMBER-POLL] Footer.tsx's decorative block-number display called
 * useBlockNumber({ watch: true }) with no pollingInterval, silently inheriting wagmi/viem's
 * ~4s default — 3 eth_blockNumber calls per ~12s mainnet block, tripling Alchemy CU spend for
 * a number nobody needs live to the second. This pins an explicit, block-time-safe interval.
 *
 * [fix/footer-poll-hidden-tab] wagmi's `watch:` option is a viem watchBlockNumber
 * subscription that polls for the life of the tab regardless of visibility — a forgotten
 * background tab keeps billing eth_blockNumber calls forever. Replaced with TanStack
 * Query's own `refetchInterval` + `refetchIntervalInBackground: false`, which pauses while
 * `document.visibilityState !== 'visible'`. These tests pin both the call shape (no bare
 * `watch:`) and the real pause/resume mechanism react-query drives from that shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'

const useBlockNumberMock = vi.fn((_args?: unknown) => ({ data: 12345678n }))

vi.mock('wagmi', () => ({
  useBlockNumber: (args?: unknown) => useBlockNumberMock(args),
}))

import Footer, { FOOTER_BLOCK_POLL_MS } from './Footer'

describe('Footer block-number polling', () => {
  it('uses a query-based refetchInterval, not a bare watch subscription', () => {
    render(<Footer />)

    expect(useBlockNumberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          refetchInterval: expect.any(Number),
          refetchIntervalInBackground: false,
        }),
      })
    )

    const call = useBlockNumberMock.mock.calls[0][0] as {
      query: { refetchInterval: number; refetchIntervalInBackground: boolean }
      watch?: unknown
    }
    expect(call.query.refetchInterval).toBeGreaterThanOrEqual(12_000)
    expect(call.query.refetchIntervalInBackground).toBe(false)
    expect(call.watch).toBeUndefined()
  })

  it('pins the configured footer poll interval so a future regression is caught', () => {
    expect(FOOTER_BLOCK_POLL_MS).toBe(12_000)
  })
})

describe('refetchIntervalInBackground: false pauses polling while the tab is hidden', () => {
  // Exercises the real react-query mechanism that Footer.tsx's { refetchInterval,
  // refetchIntervalInBackground: false } shape delegates to (wagmi's useBlockNumber
  // spreads `query` straight into TanStack's useQuery) — react-query's own
  // focusManager reads document.visibilityState and skips the interval's fetch
  // while hidden, so this is the mechanism actually protecting the RPC budget.
  let visibilityState: DocumentVisibilityState = 'visible'

  beforeEach(() => {
    vi.useFakeTimers()
    visibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function Probe({ onFetch }: { onFetch: () => void }) {
    useQuery({
      queryKey: ['footer-block-probe'],
      queryFn: async () => {
        onFetch()
        return 1n
      },
      refetchInterval: FOOTER_BLOCK_POLL_MS,
      refetchIntervalInBackground: false,
    })
    return null
  }

  it('does not refetch across several intervals while hidden, and resumes when visible', async () => {
    const queryClient = new QueryClient()
    const onFetch = vi.fn()

    render(
      <QueryClientProvider client={queryClient}>
        <Probe onFetch={onFetch} />
      </QueryClientProvider>
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(onFetch).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.advanceTimersByTimeAsync(FOOTER_BLOCK_POLL_MS * 3)
    expect(onFetch).toHaveBeenCalledTimes(1)

    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.advanceTimersByTimeAsync(FOOTER_BLOCK_POLL_MS)
    expect(onFetch.mock.calls.length).toBeGreaterThan(1)
  })
})
