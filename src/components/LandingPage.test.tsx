// @vitest-environment jsdom
/**
 * [feat/quote-before-wallet] LandingPage's SwapPreview — the hero's "live"
 * swap widget. Pins:
 *
 *   - It resolves quotes through the SAME `useQuote` hook SwapBox uses (no
 *     second fetch implementation to drift from it) — acceptance 4.
 *   - The static 0.5 ETH → 994.68 USDC mock is gone: the receive side now
 *     reflects whatever useQuote returns (loading / resolved / error).
 *   - "Compared N DEX sources" only renders once a quote has actually
 *     resolved — never while loading, never after a failed quote.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// jsdom has no IntersectionObserver — framer-motion's whileInView/useInView
// (AnimatedCounter, SplitText) need one to mount. Unrelated to this file's
// actual subject (SwapPreview's quote wiring); a minimal stub is enough.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
// @ts-expect-error — test-only global stub, not a spec-complete IntersectionObserver
globalThis.IntersectionObserver = IntersectionObserverStub

const useQuoteMock = vi.fn()
vi.mock('@/hooks/useQuote', () => ({ useQuote: (...a: unknown[]) => useQuoteMock(...a) }))

vi.mock('./LandingBelowFold', () => ({ default: () => null }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: vi.fn() }))

import { render, screen } from '@/test-utils/render'
import LandingPage from './LandingPage'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LandingPage — SwapPreview uses the real quote path [acceptance 4]', () => {
  it('calls the SAME useQuote hook SwapBox uses, for the 0.5 ETH default pair', () => {
    useQuoteMock.mockReturnValue({ meta: null, loading: true, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
    render(<LandingPage onLaunchApp={vi.fn()} />)
    expect(useQuoteMock).toHaveBeenCalled()
    const [tokenIn, tokenOut, amountIn] = useQuoteMock.mock.calls[0]
    expect(tokenIn?.symbol).toBe('ETH')
    expect(tokenOut?.symbol).toBe('USDC')
    expect(amountIn).toBe('0.5')
  })

  it('shows a loading state, never the old hardcoded 994.68, before a quote resolves', () => {
    useQuoteMock.mockReturnValue({ meta: null, loading: true, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
    render(<LandingPage onLaunchApp={vi.fn()} />)
    expect(screen.queryByText('994.68')).not.toBeInTheDocument()
  })

  it('renders the real resolved amount and the "Compared" line once a quote resolves', () => {
    useQuoteMock.mockReturnValue({
      meta: {
        best: { source: '1inch', toAmount: '1234560000', estimatedGas: 0, gasUsd: 0, routes: [] },
        all: [],
        fetchedAt: Date.now(),
      },
      loading: false,
      error: null,
      countdown: 15,
      refetch: vi.fn(),
      refresh: vi.fn(),
    })
    render(<LandingPage onLaunchApp={vi.fn()} />)
    expect(screen.getByText('1 234.5600')).toBeInTheDocument()
    expect(screen.getByText('Compared')).toBeInTheDocument()
  })

  it('never claims a comparison happened when the quote fails', () => {
    useQuoteMock.mockReturnValue({ meta: null, loading: false, error: 'No valid quotes', countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
    render(<LandingPage onLaunchApp={vi.fn()} />)
    expect(screen.queryByText('Compared')).not.toBeInTheDocument()
  })
})
