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

// [fix/landing-preview-chain-aware] SwapPreview reads its chain from the SAME hook
// useQuote uses internally (useQuoteChainId) — mock it directly so a test can drive
// the widget's chain without standing up a real WagmiProvider.
let mockChainId = 1
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => mockChainId }))

vi.mock('./LandingBelowFold', () => ({ default: () => null }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: vi.fn() }))

import { render, screen } from '@/test-utils/render'
import LandingPage from './LandingPage'
import { findToken } from '@/lib/tokens'
import { getChainTokenList } from '@/lib/chains'

beforeEach(() => {
  vi.clearAllMocks()
  mockChainId = 1
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

// [fix/landing-preview-chain-aware] SwapPreview resolved its pair with a bare
// findToken('ETH')/findToken('USDC') — always the MAINNET entry, regardless of which
// chain useQuote itself resolves from (useQuoteChainId, ChainSelector-driven for a
// disconnected visitor). On Base/Arbitrum that sent a mainnet address to a different
// chain's liquidity sources, which reject it — the live "Unavailable" bug. These tests
// pin the fix: the pair now follows the SAME chain the quote uses.
describe('LandingPage — SwapPreview follows the widget\'s chain [fix/landing-preview-chain-aware]', () => {
  beforeEach(() => {
    useQuoteMock.mockReturnValue({ meta: null, loading: true, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() })
  })

  it('[acceptance 1] requests the correct per-chain address for both legs, on mainnet and Base', () => {
    for (const chainId of [1, 8453]) {
      mockChainId = chainId
      useQuoteMock.mockClear()
      render(<LandingPage onLaunchApp={vi.fn()} />)

      const expectedEth = getChainTokenList(chainId).find((t) => t.symbol.toLowerCase() === 'eth')
      const expectedUsdc = getChainTokenList(chainId).find((t) => t.symbol.toLowerCase() === 'usdc')
      expect(useQuoteMock).toHaveBeenCalled()
      const [tokenIn, tokenOut] = useQuoteMock.mock.calls[0]
      expect(tokenIn?.address.toLowerCase()).toBe(expectedEth?.address.toLowerCase())
      expect(tokenOut?.address.toLowerCase()).toBe(expectedUsdc?.address.toLowerCase())
    }
  })

  it('[acceptance 2] the resolved USDC leg on Base is the BASE address, not a bare findToken(\'USDC\') mainnet result', () => {
    mockChainId = 8453
    render(<LandingPage onLaunchApp={vi.fn()} />)

    const bareMainnetUsdc = findToken('USDC')
    const [, tokenOut] = useQuoteMock.mock.calls[0]
    expect(tokenOut?.address.toLowerCase()).not.toBe(bareMainnetUsdc?.address.toLowerCase())

    const baseUsdc = getChainTokenList(8453).find((t) => t.symbol.toLowerCase() === 'usdc')
    expect(tokenOut?.address.toLowerCase()).toBe(baseUsdc?.address.toLowerCase())
  })

  it('[acceptance 3] Arbitrum — ETH has no catalog entry (fall-through): renders the honest unavailable state and fires no quote', () => {
    mockChainId = 42161
    render(<LandingPage onLaunchApp={vi.fn()} />)

    // Confirms the premise: Arbitrum's catalog genuinely has no 'ETH' entry today.
    expect(getChainTokenList(42161).some((t) => t.symbol.toLowerCase() === 'eth')).toBe(false)

    // The ETH leg falls through (no Arbitrum catalog entry) and must not be quoted with
    // the mainnet address — tokenIn is null. USDC does resolve on Arbitrum, but with no
    // honest ETH leg the pair as a whole is unavailable: `enabled` is false, so useQuote
    // fires no request regardless of the USDC leg resolving on its own.
    const [tokenIn, , , enabled] = useQuoteMock.mock.calls[0]
    expect(tokenIn).toBeNull()
    expect(enabled).toBe(false)
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Compared')).not.toBeInTheDocument()
  })
})
