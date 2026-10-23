// @vitest-environment jsdom
/**
 * Landing claims render from product-claims slots: hero verification line + per-chain feed
 * count, Security stats at their final value on the FIRST render (what SSR emits — no count-up
 * from 0), and the C5–C7 copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
// @ts-expect-error — test-only global stub
globalThis.IntersectionObserver = IntersectionObserverStub

vi.mock('@/hooks/useQuote', () => ({
  useQuote: () => ({ meta: null, loading: true, error: null, countdown: 0, refetch: vi.fn(), refresh: vi.fn() }),
}))
let mockChainId = 1
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => mockChainId }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: vi.fn() }))
vi.mock('./LandingBelowFold', () => ({ default: () => null }))

import { renderToString } from 'react-dom/server'
import { render, screen } from '@/test-utils/render'
import LandingPage from './LandingPage'
import {
  VERIFICATION_SUMMARY,
  VERIFICATION_CHECK_COUNT,
  chainNameFor,
  chainlinkFeedCountFor,
  PRICE_DEVIATION_WARN_PCT,
  PRICE_DEVIATION_BLOCK_PCT,
  CHAINLINK_STALENESS_CLAIM,
  POST_EXECUTION_SHORTFALL_WARN_PCT,
  INTEGRATED_DEX_SOURCE_LABELS,
  formatChainList,
} from '@/config/product-claims'

beforeEach(() => {
  mockChainId = 1
})

describe('hero stats', () => {
  it('reads "<stages> stages · <checks> checks" from the verification list', () => {
    render(<LandingPage onLaunchApp={vi.fn()} />)
    expect(screen.getByText(VERIFICATION_SUMMARY)).toBeInTheDocument()
  })

  it('shows the ACTIVE chain\'s feed count and name', () => {
    for (const id of [1, 8453, 42161]) {
      mockChainId = id
      const { container, unmount } = render(<LandingPage onLaunchApp={vi.fn()} />)
      const text = container.textContent ?? ''
      expect(text.toLowerCase()).toContain(`chainlink oracles · ${chainNameFor(id)}`.toLowerCase())
      expect(text).toContain(String(chainlinkFeedCountFor(id)))
      unmount()
    }
  })
})

describe('below-the-fold claims', () => {
  // Real component here — the file-level mock above only covers LandingPage's dynamic import.
  async function loadBelowFold() {
    vi.doUnmock('./LandingBelowFold')
    vi.resetModules()
    return (await import('./LandingBelowFold')).default
  }

  it('Security stats render the final value on the first render (SSR), not 0', async () => {
    const BelowFold = await loadBelowFold()
    const html = renderToString(<BelowFold onLaunchApp={() => {}} />)
    expect(html).toContain(`>${VERIFICATION_CHECK_COUNT}<`)
    expect(html).toContain(`>${chainlinkFeedCountFor(1)}<`)
  })

  it('interpolates thresholds, staleness limit and the active chain in the Security list', async () => {
    mockChainId = 8453
    const BelowFold = await loadBelowFold()
    const { container } = render(<BelowFold onLaunchApp={() => {}} />)
    const text = container.textContent ?? ''
    expect(text).toContain(`${chainlinkFeedCountFor(8453)} token price feeds on ${chainNameFor(8453)}`)
    expect(text).toContain(`warns at ${PRICE_DEVIATION_WARN_PCT}+ deviation, blocks at ${PRICE_DEVIATION_BLOCK_PCT}`)
    expect(text).toContain(CHAINLINK_STALENESS_CLAIM)
    expect(text).toContain(`Shortfall above ${POST_EXECUTION_SHORTFALL_WARN_PCT}`)
    expect(text).not.toMatch(/every hour/i)
  })

  it('Features card lists exactly the integrated sources by display label', async () => {
    const BelowFold = await loadBelowFold()
    const { container } = render(<BelowFold onLaunchApp={() => {}} />)
    expect(container.textContent).toContain(formatChainList(INTEGRATED_DEX_SOURCE_LABELS))
    expect(container.textContent).not.toMatch(/OpenOcean|Balancer/)
  })

  it('C5-C7 copy: scoped MEV claim, permit-scoped gasless claim, OrderExecutor model, new tagline', async () => {
    const BelowFold = await loadBelowFold()
    const { container } = render(<BelowFold onLaunchApp={() => {}} />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/zero front-running|eliminate front-running|entirely|100%|ever\.|Ethereum Elite|CoW Protocol solvers compete to fill|CoW limit order is auto-submitted/i)
    expect(text).toContain('Exact-Amount Approvals')
    expect(text).not.toMatch(/gasless approvals|Permit2 technology|off-chain signing/i)
    expect(text).toContain('When a swap routes through CoW Protocol')
    expect(text).toContain('OrderExecutor')
    expect(text).toContain('-hour timelock')
    expect(text).toContain('Built for every EVM trader.')
    expect(text).not.toContain('Smart DCA Engine')
  })
})
