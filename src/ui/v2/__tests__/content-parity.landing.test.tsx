// @vitest-environment jsdom
/**
 * [ADR-025] Content-parity gate · landing (B2) — the first instance of the B10 gate, and the template for B3+.
 * v1 `LandingPage` + `LandingBelowFold` and the v2 landing are rendered against the SAME mocked claims; every visible
 * v1 text node (normalised) must exist in v2, and every v1 `href` must still be linked. v1's decorative motion is
 * switched off (prefers-reduced-motion) so its split-letter headlines render as plain text.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

// v1 reads matchMedia / IntersectionObserver at module load; both must exist before it is imported.
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion: reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
})

const h = vi.hoisted(() => ({ isConnected: false, chainId: 1, orderLive: new Set<string>(['dca']) }))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.isConnected, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBlockNumber: () => ({ data: 23_541_870n }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn() }) }))
// v1 loads its below-fold half through next/dynamic; here the two halves are rendered explicitly.
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars' }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId }))
vi.mock('@/hooks/useQuote', () => ({
  useQuote: () => ({ meta: { best: { toAmount: '1266342000' } }, loading: false, error: null }),
}))
vi.mock('@/lib/sounds', async () => ({ ...(await vi.importActual<typeof import('@/lib/sounds')>('@/lib/sounds')), playTouchMP3: vi.fn() }))
vi.mock('@/lib/chains', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains')>('@/lib/chains')
  return { ...actual, getChainTokenList: () => [{ symbol: 'ETH' }, { symbol: 'USDC' }], remapTokenToChain: (t: unknown) => t }
})
vi.mock('@/lib/tokens', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tokens')>('@/lib/tokens')
  return { ...actual, findToken: (s: string) => ({ symbol: s, decimals: s === 'USDC' ? 6 : 18, address: '0x0', name: s }) }
})
// The SAME mocked claims for both trees (distinct values, so a typed number cannot pass by coincidence).
vi.mock('@/config/product-claims', async () => {
  const actual = await vi.importActual<typeof import('@/config/product-claims')>('@/config/product-claims')
  return {
    ...actual,
    INTEGRATED_DEX_SOURCE_COUNT: 11,
    INTEGRATED_DEX_SOURCE_COUNT_WORDS: 'eleven',
    INTEGRATED_DEX_SOURCE_COUNT_WORDS_CAP: 'Eleven',
    VERIFICATION_CHECKS: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}` })),
    VERIFICATION_CHECK_COUNT: 13,
    VERIFICATION_STAGES: ['pre-trade', 'mid-trade', 'post-execution'] as const,
    PLATFORM_FEE_LABEL: '0.7%',
    chainlinkFeedCountFor: (id: number) => ({ 1: 31, 8453: 17, 42161: 5 })[id] ?? 0,
    isOrderTypeLive: (t: string) => h.orderLive.has(t),
    dcaFeatureTitle: () => 'DCA (Base)',
  }
})

import LandingPage from '@/components/LandingPage'
import LandingBelowFold from '@/components/LandingBelowFold'
import { LandingV2 } from '@/ui/v2/landing'
import { compareContent, normalize, visibleTextNodes, type AllowedRemoval } from './content-parity'

/**
 * Strings v1 shows that v2 deliberately does not — ONLY owner-removed ones, each with the decision that removed it.
 */
const ALLOW: readonly AllowedRemoval[] = [
  {
    // v1 Experience: "…cream-on-black interface with a dynamic animated particle environment that responds to your every move."
    // v2 has no particle network (photo backgrounds instead), so the clause would be untrue there.
    text: 'with a dynamic animated particle environment that responds to your every move',
    reason: 'owner, 26 Oct 2026 (asked in the feat/ui-v2-landing run): drop the clause, keep the rest of the sentence',
  },
]

const noop = () => {}

function renderBoth() {
  const v1 = render(
    <div data-v1="">
      <LandingPage onLaunchApp={noop} />
      <LandingBelowFold onLaunchApp={noop} />
    </div>,
  )
  const v1Root = v1.container.querySelector('[data-v1]')!
  const v2 = render(<LandingV2 onLaunchApp={noop} />)
  const v2Root = v2.container.querySelector('[data-ts-landing]')!
  return { v1Root, v2Root }
}

afterEach(cleanup)
beforeAll(() => {
  h.isConnected = false
  h.chainId = 1
})

describe('content parity · landing: v1 LandingPage + LandingBelowFold ⊆ v2 landing', () => {
  it('every visible v1 text node exists in v2 (allow-list: owner-removed strings only)', () => {
    const { v1Root, v2Root } = renderBoth()
    const r = compareContent(v1Root, v2Root, ALLOW)
    expect(r.v1Nodes).toBeGreaterThan(100) // the walk really covered the page
    expect(r.missingText).toEqual([])
    expect(r.staleAllow).toEqual([])
  })

  it('every v1 href is still linked in v2', () => {
    const { v1Root, v2Root } = renderBoth()
    const r = compareContent(v1Root, v2Root, ALLOW)
    expect(r.v1Hrefs).toBeGreaterThanOrEqual(2) // #performance, /docs
    expect(r.missingHrefs).toEqual([])
  })

  it('holds on another selected chain (the chain-aware strings move together)', () => {
    h.chainId = 8453
    const { v1Root, v2Root } = renderBoth()
    const r = compareContent(v1Root, v2Root, ALLOW)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    h.chainId = 1
  })

  it('holds when Limit / SL·TP go live (the roadmap empties; their feature cards stay)', () => {
    h.orderLive = new Set(['dca', 'limit', 'stopLoss'])
    const { v1Root, v2Root } = renderBoth()
    const r = compareContent(v1Root, v2Root, ALLOW)
    // v1's "Roadmap" heading disappears with its section; the strings that remain must all still be in v2.
    expect(r.missingText).toEqual([])
    h.orderLive = new Set(['dca'])
  })
})

describe('the gate itself (so a green run means something)', () => {
  it('flags a v1 string that v2 lacks, and a v1 href that v2 dropped', () => {
    const v1 = document.createElement('div')
    v1.innerHTML = '<p>Keep this</p><p>Lose this</p><a href="/docs">d</a><a href="/gone">g</a>'
    const v2 = document.createElement('div')
    v2.innerHTML = '<p>Keep this</p><a href="/docs">d</a>'
    const r = compareContent(v1, v2)
    expect(r.missingText).toEqual(['lose this', 'g'])
    expect(r.missingHrefs).toEqual(['/gone'])
  })

  it('an allow-listed substring may be absent from v2 — but only that substring', () => {
    const v1 = document.createElement('div')
    v1.innerHTML = '<p>All wrapped in an interface with particles that react. Because clarity.</p>'
    const v2 = document.createElement('div')
    v2.innerHTML = '<p>All wrapped in an interface. Because clarity.</p>'
    const allow = [{ text: ' with particles that react', reason: 'test' }]
    expect(compareContent(v1, v2, allow)).toMatchObject({ missingText: [], staleAllow: [] })
    v2.innerHTML = '<p>All wrapped in a different interface. Because clarity.</p>'
    expect(compareContent(v1, v2, allow).missingText).toHaveLength(1)
  })

  it('a stale allow-list entry fails: one that matches nothing in v1, or whose text v2 still shows', () => {
    const v1 = document.createElement('div')
    v1.innerHTML = '<p>Alpha beta</p>'
    const v2 = document.createElement('div')
    v2.innerHTML = '<p>Alpha beta</p>'
    expect(compareContent(v1, v2, [{ text: 'gamma', reason: 'x' }]).staleAllow).toHaveLength(1)
    expect(compareContent(v1, v2, [{ text: 'beta', reason: 'x' }]).staleAllow).toHaveLength(1)
  })

  it('normalisation: NBSP / thin space / runs of whitespace / case compare equal; aria-hidden decoration is not content', () => {
    expect(normalize('1 266.3420  USDC\n')).toBe('1 266.3420 usdc')
    const el = document.createElement('div')
    el.innerHTML = '<span>Visible</span><span aria-hidden="true">→</span>'
    expect(visibleTextNodes(el)).toEqual(['visible'])
  })
})
