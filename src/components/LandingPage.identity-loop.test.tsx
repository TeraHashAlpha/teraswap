// @vitest-environment jsdom
/**
 * [fix/quote-identity-loop] Reproduces the production incident and pins the fix.
 *
 * PR #441 made SwapPreview's pair chain-aware via `resolvePreviewToken`, called
 * unmemoised in the component body. On any non-mainnet chain, `getChainTokenList`
 * rebuilds token objects via `.map()` on every call, so `remapTokenToChain` handed
 * `useQuote` a NEW token object identity every render. `useQuote`'s `doFetch` was
 * keyed on the token OBJECTS, so every render rebuilt `doFetch`, which tore down
 * and re-armed the polling effect — which calls `doFetch()` synchronously in its
 * body. Result in prod: an unbounded `/api/quote` fetch loop on Base/Arbitrum until
 * the per-IP rate limit 429'd everything, mainnet included.
 *
 * Unlike LandingPage.test.tsx (which mocks `useQuote` itself, so it can't observe
 * this), this file exercises the REAL `useQuote` + `useQuoteChainId` so the fetch
 * count is the real signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
// @ts-expect-error — test-only global stub, not a spec-complete IntersectionObserver
globalThis.IntersectionObserver = IntersectionObserverStub

vi.mock('./LandingBelowFold', () => ({ default: () => null }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: vi.fn() }))

// Mock wagmi's useAccount so useQuoteChainId falls through to the disconnected
// chain-selection store below — no real WagmiProvider needed (see useQuote.test.ts).
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({ address: undefined, chain: undefined, isConnected: false })),
}))

vi.mock('@/hooks/useEthGasCost', () => ({
  useEthGasCost: vi.fn(() => ({
    ethPrice: 2000,
    gasPriceGwei: 20,
    estimate: () => ({ eth: 0.001, usd: 2 }),
  })),
}))

vi.mock('@/hooks/useDebounce', () => ({
  useDebounce: <T,>(v: T) => v,
}))

vi.mock('@/lib/gasless-engine', () => ({
  analyzeGasless: vi.fn(() => ({
    available: true,
    recommended: false,
    gasSavingsUsd: 0,
    priceDifferencePercent: 0,
    bestNonCowSource: '1inch',
    reason: 'baseline',
  })),
}))

vi.mock('@/lib/analytics', () => ({
  logQuoteToSupabase: vi.fn(),
}))

// Base/Arbitrum FeeCollector activation is env-driven (NEXT_PUBLIC_BASE_FEE_COLLECTOR /
// NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR, read once at module load — see registry.ts), so it
// can't be flipped from a test without re-importing the whole chains module graph. Override
// just `isChainActive` so this test exercises the real identity-churn bug on chains that ARE
// active in production, without depending on env plumbing unrelated to this fix.
vi.mock('@/lib/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains')>()
  return { ...actual, isChainActive: (chainId: number) => chainId === 8453 || actual.isChainActive(chainId) }
})

import { render } from '@/test-utils/render'
import LandingPage from './LandingPage'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'

const VALID_RESPONSE = {
  best: { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
  all: [
    { source: '1inch', toAmount: '2950000000', estimatedGas: 150000, gasUsd: 5, routes: [] },
  ],
  fetchedAt: Date.now(),
}

function mockFetchSuccess() {
  return vi.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(VALID_RESPONSE), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  useDisconnectedChainSelection.getState().setChainId(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  useDisconnectedChainSelection.getState().setChainId(null)
})

describe('LandingPage — SwapPreview identity loop [fix/quote-identity-loop, acceptance 1]', () => {
  it('renders N times on chainId 8453 and fires EXACTLY ONE /api/quote fetch — fails against #441\'s unmemoised code', async () => {
    useDisconnectedChainSelection.getState().setChainId(8453)
    const fetchSpy = mockFetchSuccess()

    const { rerender } = render(<LandingPage onLaunchApp={vi.fn()} />)
    await flush()

    for (let i = 0; i < 9; i++) {
      rerender(<LandingPage onLaunchApp={vi.fn()} />)
    }
    await flush()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('renders N times on chainId 42161 (Arbitrum) and fires zero fetches (ETH leg has no catalog entry)', async () => {
    useDisconnectedChainSelection.getState().setChainId(42161)
    const fetchSpy = mockFetchSuccess()

    const { rerender } = render(<LandingPage onLaunchApp={vi.fn()} />)
    await flush()

    for (let i = 0; i < 9; i++) {
      rerender(<LandingPage onLaunchApp={vi.fn()} />)
    }
    await flush()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
