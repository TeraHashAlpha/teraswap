// @vitest-environment jsdom
/**
 * [L-1, A75] The whole-app parity sweep (parity-sweep.test.tsx) renders v1's SwapBox alone against v2's SwapCard
 * alone — it never catches a v1 SIBLING of the embedded widget (page.tsx renders SwapHistory and the Share button
 * next to SwapBox, not inside it), so "Recent swaps" and Share were missing from v2 with 0 sweep failures. This file
 * is that missing coverage: it compares the SIBLING surfaces directly, and pins that the two surfaces the owner
 * ruled NOT to build (theme toggle, landing dot-nav — neither has visible text a sweep could catch; see the
 * content-map) are recorded, so a reviewer finds a ruling instead of silence.
 *
 * [S-1, A75b] Extended from Recent swaps to the rest of the page chrome — header, footer, the Help / Music fabs, the open Help
 * drawer, and the Share button's label + tweet text — each v1 surface rendered against its v2 counterpart (v1 text, link targets
 * and accessible names ⊆ v2, 0 missing). Wagmi / RainbowKit / next are mocked at the module edge; both trees are the REAL
 * components. Share runs the whole SwapBox mock rig (the one place the rig is needed). The one ruled Share difference: v1 prints
 * `saved 0.27%%` (fmtPct already ends in %, the template adds another - a v1 typo); v2 keeps one % (content-map "Share label %").
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, normalize, type AllowedRemoval } from './content-parity'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../swap/test-fixtures'

const noop = () => {}
const h = vi.hoisted(() => ({
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true, chain: { id: 1 } as { id: number } | undefined },
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  approval: {} as Record<string, unknown>,
  swap: {} as Record<string, unknown>,
  split: {} as Record<string, unknown>,
  log: [] as string[],
  toasts: [] as Record<string, unknown>[],
  dismissed: [] as string[],
}))

// One mock set for the whole file (vi.mock is file-wide): the union of what the chrome surfaces and the SwapBox / SwapCard rig read.
// `@/hooks/useSwapHistory` is deliberately NOT mocked - the Recent swaps half drives the real store.
vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: { value: 3n * 10n ** 18n, decimals: 18 } }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
  useBlockNumber: () => ({ data: 23_541_870n }),
  useEnsName: () => ({ data: undefined }),
  useEnsAvatar: () => ({ data: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))
vi.mock('wagmi/chains', () => ({ mainnet: { id: 1 } }))
vi.mock('@rainbow-me/rainbowkit', async () => {
  const actual = await vi.importActual<typeof import('@rainbow-me/rainbowkit')>('@rainbow-me/rainbowkit')
  return {
    darkTheme: actual.darkTheme,
    RainbowKitProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useConnectModal: () => ({ openConnectModal: () => {} }),
    ConnectButton: Object.assign(() => null, {
      Custom: ({ children }: { children: (p: unknown) => React.ReactNode }) => children({ account: undefined, chain: undefined, openConnectModal: vi.fn(), mounted: true }),
    }),
  }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/swap', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ mode: 'dark', setMode: vi.fn() }) }))
vi.mock('@/components/ChainSelector', () => ({ default: () => null }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useChainId')>('@/hooks/useChainId')
  return { ...actual, useQuoteChainId: () => 1, useActiveChainId: () => 1 }
})
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => ({ ...NO_ORACLE, chainlinkPrice: 2490 }) }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }) }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => h.split }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('@/components/ActiveApprovals', () => ({ default: () => null }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: () => {} }))
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol}</button> }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: () => {} }))
vi.mock('@/components/ToastProvider', () => ({
  useToast: () => ({
    toast: (t: Record<string, unknown>) => {
      h.toasts.push({ ...t })
      return `t${h.toasts.length}`
    },
    dismiss: (id: string) => void h.dismissed.push(id),
  }),
}))
vi.mock('../shell/toasts', () => ({
  useV2Toast: () => ({
    toast: (t: Record<string, unknown>) => {
      h.toasts.push({ ...t })
      return `t${h.toasts.length}`
    },
    dismiss: (id: string) => void h.dismissed.push(id),
    update: () => {},
  }),
}))
vi.mock('@/lib/sounds', () => {
  const rec = (n: string) => () => void h.log.push(n)
  return {
    playQuoteReceived: () => {}, playTouchMP3: rec('touch'), playSwapConfirmMP3: rec('confirm'), playCancelOrderMP3: rec('cancel'), startWaitingSound: rec('wait+'), stopWaitingSound: rec('wait-'),
    startBackgroundMusic: vi.fn(), stopBackgroundMusic: vi.fn(), toggleBackgroundMusic: vi.fn(() => true), isBackgroundMusicOn: () => true,
  }
})

import SwapBox from '@/components/SwapBox'
import { useSwapHistory, type SwapRecord } from '@/hooks/useSwapHistory'
import SwapHistory from '@/components/SwapHistory'
import V1Header from '@/components/Header'
import V1Footer from '@/components/Footer'
import V1HelpButton from '@/components/HelpButton'
import V1BackgroundMusic from '@/components/BackgroundMusic'
import V1HelpDrawer from '@/components/HelpDrawer'
import { RecentSwaps } from '../swap/RecentSwaps'
import { SwapCard } from '../swap/SwapCard'
import { Header as V2Header } from '../shell/Header'
import { Footer as V2Footer } from '../shell/Footer'
import { HelpFab, MusicToggle } from '../shell/Fabs'
import { HelpDrawer as V2HelpDrawer } from '../shell/HelpDrawer'

const READY = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, isReady: true, needsPermit2Education: false, approve: async () => {}, confirmPermit2Education: noop, cancelPermit2Education: noop }
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const splitHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn(), ...over,
})
const TX = '0x8c1f000000000000000000000000000000000000000000000000000000c44b0'

// v1 prints the expand arrow and the status glyph as plain text; v2 draws them `aria-hidden` beside the accessible
// "Recent swaps (N)" button and the "Explorer" link (round 7's own rule for every other decorative glyph — see the
// content-map / parity-sweep.test.tsx's `GLYPH` reason).
const GLYPH = 'decorative glyph, aria-hidden in v2; the control/link keeps its accessible name'
const GLYPH_ALLOW: AllowedRemoval[] = [['▲', GLYPH], ['▼', GLYPH], ['✓', GLYPH], ['✗', GLYPH], ['⏳', GLYPH]].map(([text, reason]) => ({ text, reason }))

const RECORDS: SwapRecord[] = [
  { id: 'r1', date: '2026-11-05', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '1', amountOut: '2487.6842', txHash: '0xabc', status: 'confirmed', chainId: 1 },
  { id: 'r2', date: '2026-11-04', tokenIn: 'USDC', tokenOut: 'ETH', amountIn: '100', amountOut: '0.04', txHash: '0xdef', status: 'failed', chainId: 8453 },
]

/** Accessible names (aria-label / title) of the controls under `root`, normalised: the fabs and the X link have no visible text. */
const names = (root: Element) =>
  Array.from(root.querySelectorAll('[aria-label],[title]'))
    .flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('title')])
    .filter((t): t is string => !!t)
    .map(normalize)

const CHROME_GLYPH = 'decorative glyph / separator, aria-hidden in v2; the control keeps its accessible name (round 7 item 11, content-map)'
const THEME = 'theme toggle: v2 is dark-only, no light mode (content-map: "Theme toggle", owner A75 L-1: NOT built)'
// NOT owner-ruled: found by this sweep (A75b S-1). v2's pack-03 wording is pinned by shell.test.tsx, v1's was never carried over. Recorded
// in the content-map as "flagged" so the owner confirms the rewording or asks for v1's copy back; deleting an entry here makes the sweep fail.
const FLAGGED = 'reworded in v2 (pack 03), no owner ruling on record - flagged in the content-map for confirmation'
const allow = (reason: string, ...texts: string[]): AllowedRemoval[] => texts.map((text) => ({ text, reason }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useSwapHistory.setState({ records: [] })
})

beforeEach(() => {
  h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.approval = { ...READY }
  h.swap = swapHook()
  h.split = splitHook()
  h.log = []
  h.toasts = []
  h.dismissed = []
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})

describe('sweep · Swap · shell surfaces (v1 page.tsx siblings of SwapBox, not just the card itself)', () => {
  it('Recent swaps: v1 (collapsed) text ⊆ v2, 0 missing', () => {
    useSwapHistory.setState({ records: RECORDS })
    const v1 = render(<SwapHistory />)
    const v2 = render(<RecentSwaps />)
    const r = compareContent(v1.container, v2.container, GLYPH_ALLOW)
    expect(r.missingText).toEqual([])
  })

  it('Recent swaps: expanded, v1 row text (amounts, status, Explorer links) ⊆ v2, 0 missing', () => {
    useSwapHistory.setState({ records: RECORDS })
    const v1 = render(<SwapHistory />)
    fireEvent.click(within(v1.container).getByText('Recent swaps (2)'))
    const v2 = render(<RecentSwaps />)
    fireEvent.click(within(v2.container).getByText('Recent swaps (2)'))
    const r = compareContent(v1.container, v2.container, GLYPH_ALLOW)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
  })
})

describe('shell surfaces ruled NOT to build (theme toggle, landing dot-nav) and the v1 typo v2 does not copy: recorded, not silently dropped', () => {
  const contentMap = readFileSync(join(process.cwd(), 'docs/feedback/feat-ui-v2-mobile-parity.md'), 'utf8')

  it.each([
    ['Theme toggle', /\|\s*Theme toggle\s*\|.*NOT built/],
    ['landing dot-nav', /\|\s*Desktop dot-nav.*\|.*NOT built/],
    // [A75b] v1 prints `Share — saved 0.27%%` (SwapBox.tsx: fmtPct() already ends in %, the label template adds another).
    // v2 keeps ONE % and does not copy the typo; the content-map names it a v1 typo.
    ['Share label %', /\|\s*Share label `%%`.*\|.*v1 typo.*\|/],
  ])('%s has a ruled delta row in the content-map', (_label, pattern) => {
    expect(contentMap).toMatch(pattern)
  })
})

describe('sweep · shell surfaces · header', () => {
  it.each([['disconnected', false], ['connected', true]])('%s: v1 header text ⊆ v2, 0 missing, links kept', (_n, connected) => {
    h.account = { address: connected ? '0xd44d00000000000000000000000000000000962d' : undefined, isConnected: connected, chain: connected ? { id: 1 } : undefined }
    const v1 = render(<V1Header />)
    const v2 = render(<V2Header />)
    const r = compareContent(v1.container, v2.container, allow(THEME, '☽'))
    expect(r.v1Nodes).toBeGreaterThan(0) // the sweep saw v1's header, not an empty render
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
    const v2Names = new Set(names(v2.container))
    // `theme: dark` is the theme toggle's accessible name - the same ruled-out control as the ☽ above.
    expect(names(v1.container).filter((n) => !v2Names.has(n) && n !== 'theme: dark')).toEqual([])
  })
})

describe('sweep · shell surfaces · footer', () => {
  it('v1 footer text, link targets and accessible names ⊆ v2', () => {
    const v1 = render(<V1Footer />)
    const v2 = render(<V2Footer />)
    // v1 prints `Fee: 0.1%`; v2 prints `Fee 0.1%` - the colon is the only difference (flagged, not ruled).
    const r = compareContent(v1.container, v2.container, [...allow(CHROME_GLYPH, '|'), ...allow(FLAGGED, 'fee:')])
    expect(r.v1Nodes).toBeGreaterThan(5)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
    const v2Names = new Set(names(v2.container))
    expect(names(v1.container).filter((n) => !v2Names.has(n))).toEqual([])
  })
})

describe('sweep · shell surfaces · fabs', () => {
  it('v1 Help and Music fabs: every accessible name has a v2 counterpart', () => {
    const v1 = render(<><V1HelpButton /><V1BackgroundMusic /></>)
    const v1Names = names(v1.container)
    cleanup()
    const v2 = render(<><HelpFab /><MusicToggle /></>)
    const v2Names = names(v2.container)
    // v1 names the music control by its action ("Mute background music" while on); v2 words it "Turn music off" — same control, same state.
    const EQUIV: Record<string, string> = { 'mute background music': 'turn music off', 'unmute background music': 'turn music on' }
    expect(v1Names.map((n) => EQUIV[n] ?? n).filter((n) => !v2Names.includes(n))).toEqual([])
  })
})

describe('sweep · shell surfaces · help drawer', () => {
  it('open: v1 drawer text, links and accessible names ⊆ v2 (same help-content module, X and e-mail links)', () => {
    const v1 = render(<V1HelpDrawer open onClose={() => {}} />)
    const v1Root = v1.baseElement.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<V2HelpDrawer open onClose={() => {}} />)
    // v1's two "need more help" links read `𝕏 Follow on X` / `✉ Contact support`; v2 words them `@TeraHash on X` / `Email support` (same targets).
    const r = compareContent(v1Root, v2.baseElement, [...allow(CHROME_GLYPH, '▾', '▸', '𝕏', '✉'), ...allow(FLAGGED, 'follow on x', 'contact support')])
    expect(r.v1Nodes).toBeGreaterThan(10)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
    const v2Names = new Set(names(v2.baseElement))
    expect(names(v1Root).filter((n) => !v2Names.has(n))).toEqual([])
  })
})

const typeAmount = (c: HTMLElement) => fireEvent.change(c.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: '1' } })

/** Mount a tree, settle a swap, press Share: returns the button's visible label and the tweet text it opens. */
function share(tree: 'v1' | 'v2', meta: unknown) {
  h.quote = { ...h.quote, meta }
  h.swap = swapHook()
  h.split = splitHook()
  h.approval = { ...READY }
  const open = vi.fn()
  vi.stubGlobal('open', open)
  const ui = () => (tree === 'v1' ? <SwapBox /> : <SwapCard />)
  const r = render(ui())
  typeAmount(r.container)
  h.swap = swapHook({ status: 'swapping' })
  r.rerender(ui())
  h.swap = swapHook({ status: 'success', txHash: TX })
  r.rerender(ui())
  const btn = screen.queryByRole('button', { name: /^share/i })
  const label = btn?.textContent?.trim() ?? null
  if (btn) fireEvent.click(btn)
  const url = open.mock.calls[0]?.[0] as string | undefined
  const text = url ? decodeURIComponent(url.split('?text=')[1]) : null
  cleanup()
  return { label, text }
}

describe('sweep · Swap · Share (v1 SwapBox.tsx button + tweet text)', () => {
  const PERCENT_TYPO: AllowedRemoval[] = [{ text: '%%', reason: 'v1 typo: fmtPct() already ends in %, the label template adds another; v2 keeps ONE % (content-map: "Share label %")' }]

  it('a comparison across sources with a saving: label and tweet text are v1\'s, bar the doubled %', () => {
    const v1 = share('v1', taggedFixture(fixtureMeta(), '1'))
    const v2 = share('v2', taggedFixture(fixtureMeta(), '1'))
    expect(v1.label).toMatch(/^Share — saved \d[\d.,]*%%$/) // the v1 typo is real today; if v1 fixes it, the allow-list entry goes stale and fails
    expect(v2.label).toMatch(/^Share — saved \d[\d.,]*%$/)
    const page = (x: { label: string | null; text: string | null }) => {
      const d = document.createElement('div')
      for (const t of [x.label, x.text]) d.appendChild(document.createElement('p')).textContent = t
      return d
    }
    const r = compareContent(page(v1), page(v2), PERCENT_TYPO)
    expect(r.v1Nodes).toBe(2)
    expect(r.missingText).toEqual([])
    expect(r.staleAllow).toEqual([])
    expect(v2.text).toBe(v1.text) // byte-identical tweet
  })

  it('a tie / no saving: "Share swap" and the plain tweet', () => {
    const m = fixtureMeta()
    const tie = taggedFixture({ ...m, all: [m.best, m.best] }, '1')
    const v1 = share('v1', tie)
    const v2 = share('v2', tie)
    expect(v1.label).toBe('Share swap')
    expect(v2.label).toBe(v1.label)
    expect(v2.text).toBe(v1.text)
  })
})
