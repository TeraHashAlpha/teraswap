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
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'

const useBlockNumberMock = vi.fn((_args?: unknown) => ({ data: 12345678n }))
// No wallet by default — the F1 tests below drive the disconnected ChainSelector store.
const useAccountMock = vi.fn((): { chain?: { id: number }; isConnected: boolean } => ({ chain: undefined, isConnected: false }))

vi.mock('wagmi', () => ({
  useBlockNumber: (args?: unknown) => useBlockNumberMock(args),
  useAccount: () => useAccountMock(),
}))

import Footer, { FOOTER_BLOCK_POLL_MS } from './Footer'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'

/**
 * [fix/functional-chain-ui F1] The footer block line read wagmi's default chain (mainnet) while
 * Base/Arbitrum was selected. It now requests the selected chain's block and names/links that chain.
 */
describe('Footer follows the selected chain', () => {
  const lastRequestedChainId = () =>
    (useBlockNumberMock.mock.calls.at(-1)?.[0] as { chainId?: number } | undefined)?.chainId

  beforeEach(() => {
    useBlockNumberMock.mockClear()
    useAccountMock.mockReturnValue({ chain: undefined, isConnected: false })
    useDisconnectedChainSelection.getState().setChainId(null)
  })

  afterEach(() => {
    cleanup()
  })

  it('selector Base, no wallet → requests chainId 8453 and links the Base explorer', () => {
    useDisconnectedChainSelection.getState().setChainId(8453)
    render(<Footer />)

    expect(lastRequestedChainId()).toBe(8453)
    const link = screen.getByRole('link', { name: /^Base · Block #/ })
    expect(link.getAttribute('href')).toBe('https://basescan.org/block/12345678')
  })

  it('switching the selector to 42161 re-requests on Arbitrum and updates name + explorer', () => {
    useDisconnectedChainSelection.getState().setChainId(8453)
    render(<Footer />)
    expect(lastRequestedChainId()).toBe(8453)

    act(() => useDisconnectedChainSelection.getState().setChainId(42161))

    expect(lastRequestedChainId()).toBe(42161)
    const link = screen.getByRole('link', { name: /^Arbitrum One · Block #/ })
    expect(link.getAttribute('href')).toBe('https://arbiscan.io/block/12345678')
    expect(screen.queryByRole('link', { name: /^Base · Block #/ })).toBeNull()
  })

  it('a connected wallet chain wins over the disconnected selector', () => {
    useAccountMock.mockReturnValue({ chain: { id: 42161 }, isConnected: true })
    useDisconnectedChainSelection.getState().setChainId(8453)
    render(<Footer />)

    expect(lastRequestedChainId()).toBe(42161)
    expect(screen.getByRole('link', { name: /^Arbitrum One · Block #/ }).getAttribute('href'))
      .toBe('https://arbiscan.io/block/12345678')
  })

  it('no wallet and no selection → mainnet block and Etherscan', () => {
    render(<Footer />)

    expect(lastRequestedChainId()).toBe(1)
    expect(screen.getByRole('link', { name: /^Ethereum · Block #/ }).getAttribute('href'))
      .toBe('https://etherscan.io/block/12345678')
  })
})

/**
 * [fix/fmtint-bigint] useBlockNumber returns a bigint. fmtInt scaled it as an 18-dp token
 * amount (5e-11 → round → "0"), so production showed "Base · Block #0". The tests above mocked
 * a bigint but only asserted the href (template-interpolated, never formatted) — this pins the text.
 */
describe('Footer renders the block number as a plain integer', () => {
  beforeEach(() => {
    useBlockNumberMock.mockReset()
    useBlockNumberMock.mockReturnValue({ data: 52656825n })
    useAccountMock.mockReturnValue({ chain: undefined, isConnected: false })
    useDisconnectedChainSelection.getState().setChainId(8453)
  })

  afterEach(() => {
    cleanup()
    useDisconnectedChainSelection.getState().setChainId(null)
    useBlockNumberMock.mockReset()
    useBlockNumberMock.mockImplementation(() => ({ data: 12345678n }))
  })

  it('52656825n → "Base · Block #52 656 825" (thin-space grouped), explorer href ends /block/52656825', () => {
    render(<Footer />)

    const link = screen.getByRole('link', { name: /^Base · Block #/ })
    expect(link.textContent).toBe('Base · Block #52\u2009656\u2009825')
    expect(link.getAttribute('href')).toMatch(/\/block\/52656825$/)
  })
})

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
