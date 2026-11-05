// @vitest-environment jsdom
/**
 * [ADR-025 / B10] WHOLE-APP PARITY SWEEP — the last gate before the full v2 Auditor and the production flag.
 *
 * ONE file renders every v2 tab next to v1's component for SHARED fixtures and asserts, per tab and per chain where the tab is live:
 *   v1 visible text ⊆ v2 visible text, and v1 links ⊆ v2 links (0 missing; allow-list = owner-removed strings only, each with its reason,
 *   and a stale entry fails). The per-tab suites keep the deep, per-state assertions; this file is the cross-check that no tab was
 *   forgotten and that the chain-aware strings move together on Ethereum (1), Base (8453) and Arbitrum One (42161).
 *
 *   Swap · Portfolio · DCA · Orders · History · Analytics · landing  → compared, chains 1 / 8453 / 42161 (DCA: the card on its DCA chains,
 *   the network gate against v1's ComingSoonPanel everywhere else).
 *   Limit · SL/TP → NOT comparable: v2 has no pane for them (owner decision, feat/ui-v2-mobile-parity: they stay "Soon" until one exists);
 *   the sweep proves the tabs are inert even where v1's `isLimitLive` says live, and `OPEN_DELTAS` carries the gap into FEEDBACK.
 *
 * Wallet, RPC and API are mocked; nothing here signs, sends or reaches the network.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType, ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, normalize, type AllowedRemoval, type ParityResult } from './content-parity'

// ── environment v1's landing reads at module load ──────────────────────────────────────────────────────────────────────────
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

type Mode = 'swap' | 'portfolio' | 'dca' | 'orders' | 'history' | 'analytics' | 'landing'
const noop = () => {}
const WALLET = '0xd44d00000000000000000000000000000000962d'

/** The ONE mock state: the per-tab suites each hoist their own; here a tab sets `mode` and its slice before it renders. */
const h = vi.hoisted(() => ({
  mode: 'swap' as Mode,
  chainId: 1,
  /** chains whose FeeCollector is "not deployed" (v1's P223 coming-soon state); default none = prod, where 1/8453/42161 are all active */
  inactive: new Set<number>(),
  /** v1's `isLimitLive` answer for Base (the flag + v3 executor + canonical router the unit env lacks) */
  limitLive: false,
  account: { address: undefined as string | undefined, isConnected: false, chain: undefined as { id: number } | undefined },
  push: vi.fn(),
  switchChain: vi.fn(),
  openConnectModal: vi.fn(),
  balance: undefined as { value: bigint; decimals: number; symbol?: string; formatted?: string } | undefined,
  // swap
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  oracle: { chainlinkPrice: 2490, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as Record<string, unknown>,
  tier: { data: null as unknown, loading: false },
  // orders
  round: [1n, 245_000_000_000n, 0n, 0n, 1n] as readonly bigint[] | undefined,
  // history
  headers: null as Record<string, string> | null,
  // analytics
  analytics: { dashboard: null as unknown, loading: false },
  personal: { data: null as unknown, isLoading: false, error: null as string | null },
}))

// ── wagmi / rainbowkit / next: the union of what every tab's own suite mocks ──────────────────────────────────────────────
vi.mock('wagmi', async () => {
  const actual = await vi.importActual<typeof import('wagmi')>('wagmi')
  return {
    ...actual,
    useAccount: () => h.account,
    useBalance: () => ({ data: h.balance }),
    useChains: () => [{ id: h.chainId, name: 'chain' }],
    useChainId: () => h.chainId,
    useSwitchChain: () => ({ switchChain: h.switchChain, switchChainAsync: vi.fn(), isPending: false }),
    useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, error: null, reset: vi.fn() }),
    useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
    useReadContract: () => ({ data: h.round }),
    useBlockNumber: () => ({ data: 23_541_870n }),
  }
})
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: () => (h.mode === 'analytics' ? null : <button data-testid="rk-connect">Connect</button>),
  useConnectModal: () => ({ openConnectModal: h.openConnectModal }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: h.push }) }))
// v1's landing loads its below-fold half through next/dynamic and the test renders the two halves explicitly; every other tab keeps the real one.
vi.mock('next/dynamic', async () => {
  const actual = await vi.importActual<{ default: (...a: unknown[]) => ComponentType<Record<string, unknown>> }>('next/dynamic')
  return {
    default: (...a: unknown[]) => {
      const Real = actual.default(...a)
      return function Dynamic(p: Record<string, unknown>) {
        return h.mode === 'landing' ? null : <Real {...p} />
      }
    },
  }
})
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))

// ── hooks the tabs share ───────────────────────────────────────────────────────────────────────────────────────────────────
vi.mock('@/hooks/useChainId', async () => ({ ...(await vi.importActual<typeof import('@/hooks/useChainId')>('@/hooks/useChainId')), useQuoteChainId: () => h.chainId, useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => (h.mode === 'landing' ? { meta: { best: { toAmount: '1266342000' } }, loading: false, error: null } : h.quote) }))
vi.mock('@/hooks/useChainlinkPrice', async () => {
  const { h: dca } = await import('../dca/dca-harness')
  const { getCanonicalUsdc } = await import('@/lib/chains/tokens')
  return { useChainlinkPrice: (a?: string) => (h.mode !== 'dca' ? h.oracle : a && a.toLowerCase() === getCanonicalUsdc(h.chainId)?.address.toLowerCase() ? dca.oracleOut : dca.oracle) }
})
vi.mock('@/hooks/useDepegCheck', async () => {
  const { h: dca } = await import('../dca/dca-harness')
  return { useDepegCheck: () => (h.mode === 'dca' ? dca.depeg : { mode: 'ok', divergence: 0, symbol: '', message: '' }) }
})
vi.mock('@/hooks/useTokenBalances', async () => {
  const { h: dca } = await import('../dca/dca-harness')
  return { useTokenBalances: () => ({ balances: dca.balances, isLoading: false, isError: false }) }
})
vi.mock('@/hooks/useTokenBalance', async () => {
  const { h: dca } = await import('../dca/dca-harness')
  return { useTokenBalance: () => dca.direct }
})
vi.mock('@/hooks/useTokenImport', () => ({ useTokenImport: () => ({ importToken: vi.fn() }) }))
vi.mock('@/hooks/useOrderEngine', async () => {
  const { engineMock } = await import('../dca/dca-harness')
  const { useFakeOrderEngine } = await import('../dca/dca-engine-fake')
  const fakeEngine = useFakeOrderEngine // not named use*: the mode is constant for a whole render, so the hook order never changes
  return { useOrderEngine: () => (h.mode === 'orders' ? fakeEngine() : engineMock()) }
})
vi.mock('@/hooks/useOrderExecutions', async () => {
  const { useOrderExecutionsFixture } = await import('../dca/positions-fixtures')
  return { useOrderExecutions: useOrderExecutionsFixture }
})
vi.mock('@/hooks/useOrderApproval', async () => {
  const { h: dca } = await import('../dca/dca-harness')
  return { useOrderApproval: (...a: unknown[]) => (dca.approvalArgs.push(a), dca.approval) }
})
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: () => {} }))
vi.mock('@/hooks/useAnalytics', () => ({ useAnalytics: () => h.analytics }))
vi.mock('@/hooks/usePersonalAnalytics', () => ({ usePersonalAnalytics: () => h.personal }))
// swap-only hooks
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({
  useApproval: () => ({ plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, approve: () => {}, isReady: true, needsPermit2Education: false, confirmPermit2Education: () => {}, cancelPermit2Education: () => {} }),
}))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => h.tier }))
vi.mock('@/hooks/useSwap', () => ({
  useSwap: () => ({ status: 'idle', txHash: undefined, errorMessage: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null, simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: () => {}, confirmSwap: () => {}, confirmCowOrder: () => {}, reset: () => {} }),
}))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({
  useSplitSwap: () => ({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: () => {}, confirmPlan: () => {}, reset: () => {} }),
}))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
// shared with Portfolio's Active Approvals panel: stubbed for Swap only, the real ones everywhere else
vi.mock('@/hooks/useActiveApprovals', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useActiveApprovals')>('@/hooks/useActiveApprovals')
  return { ...actual, useActiveApprovals: (...a: Parameters<typeof actual.useActiveApprovals>) => (h.mode === 'swap' ? ({ addApproval: () => {} } as unknown as ReturnType<typeof actual.useActiveApprovals>) : actual.useActiveApprovals(...a)) }
})
vi.mock('@/components/ActiveApprovals', async () => {
  const actual = await vi.importActual<{ default: ComponentType<Record<string, unknown>> }>('@/components/ActiveApprovals')
  return { default: (p: Record<string, unknown>) => (h.mode === 'swap' ? null : <actual.default {...p} />) }
})
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: () => {} }))
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ toast: () => 'toast-id', dismiss: () => {} }) }))
vi.mock('../shell/toasts', async () => ({ ...(await vi.importActual<typeof import('../shell/toasts')>('../shell/toasts')), useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol ?? 'Select'}</button> }))
vi.mock('../modals/TokenSheet', () => ({ TokenSheet: () => null }))
vi.mock('@/components/dca/pair-floor-info', async () => {
  const { h: dca } = await import('../dca/dca-harness')
  const actual = await vi.importActual<typeof import('@/components/dca/pair-floor-info')>('@/components/dca/pair-floor-info')
  return { ...actual, fetchPairFloorInfo: async () => dca.floor }
})
vi.mock('@/lib/order-engine', async () => {
  const { h: dca } = await import('../dca/dca-harness')
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return { ...actual, isLimitLive: (c: number) => h.limitLive && c === 8453, getOrderExecutorV3: (c: number) => (dca.v3Chains.includes(c) ? '0x3333333333333333333333333333333333333333' : null) }
})
vi.mock('@/lib/order-engine/check-route', () => ({ checkRoute: async () => ({ routable: true }) }))
vi.mock('@/lib/order-engine/read-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine/read-auth')>('@/lib/order-engine/read-auth')
  return { ...actual, ordersReadHeaders: () => h.headers }
})
vi.mock('@/lib/defillama-client', () => ({ fetchDefiLlamaPriceViaApi: async () => null }))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: () => {} }))
vi.mock('@/lib/analytics', async () => ({ ...(await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')), updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: () => {} }))
vi.mock('@/lib/sounds', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sounds')>('@/lib/sounds')
  const silent = Object.fromEntries(['playQuoteReceived', 'playTouchMP3', 'playClick', 'playSwapConfirmMP3', 'playCancelOrderMP3', 'startWaitingSound', 'stopWaitingSound'].map((n) => [n, () => {}]))
  return { ...actual, ...silent }
})
// the landing's own stand-ins (as its per-tab suite): a two-token list so the preview card is deterministic; the other tabs keep the real catalogue
vi.mock('@/lib/chains', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains')>('@/lib/chains')
  return {
    ...actual,
    getChainTokenList: (...a: Parameters<typeof actual.getChainTokenList>) => (h.mode === 'landing' ? ([{ symbol: 'ETH' }, { symbol: 'USDC' }] as unknown as ReturnType<typeof actual.getChainTokenList>) : actual.getChainTokenList(...a)),
    isChainActive: (id: number) => !h.inactive.has(id),
    remapTokenToChain: (...a: Parameters<typeof actual.remapTokenToChain>) => (h.mode === 'landing' ? a[0] : actual.remapTokenToChain(...a)),
  }
})
vi.mock('@/lib/tokens', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tokens')>('@/lib/tokens')
  return { ...actual, findToken: (...a: Parameters<typeof actual.findToken>) => (h.mode === 'landing' ? ({ symbol: a[0], decimals: a[0] === 'USDC' ? 6 : 18, address: '0x0', name: a[0] } as unknown as ReturnType<typeof actual.findToken>) : actual.findToken(...a)) }
})

// v1 and v2 components (after the mocks)
import SwapBox from '@/components/SwapBox'
import V1PortfolioTab from '@/components/PortfolioTab'
import DCAPanel from '@/components/DCAPanel'
import ComingSoonPanel from '@/components/ComingSoonPanel'
import OrderDashboard from '@/components/OrderDashboard'
import WalletHistory from '@/components/WalletHistory'
import AnalyticsDashboard from '@/components/AnalyticsDashboard'
import PersonalDashboard from '@/components/PersonalDashboard'
import PublicProtocolStats from '@/components/PublicProtocolStats'
import LandingPage from '@/components/LandingPage'
import LandingBelowFold from '@/components/LandingBelowFold'
import type { PublicStatsPayload } from '@/lib/public-stats-display'
import { findChainToken, getCanonicalUsdc } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { getChainTokenList } from '@/lib/chains'
import { isLimitLive } from '@/lib/order-engine'
import type { SwapRecord } from '../history/history-model'
import { SwapCard } from '../swap/SwapCard'
import { PortfolioTab as V2PortfolioTab } from '../portfolio/PortfolioTab'
import { DcaCard } from '../dca/DcaCard'
import { DcaNetworkGate } from '../shell/DcaNetworkGate'
import { TabBar } from '../shell/TabBar'
import { OrdersTab } from '../orders/OrdersTab'
import { HistoryTab } from '../history/HistoryTab'
import { AnalyticsTab } from '../analytics/AnalyticsTab'
import { LandingV2 } from '../landing'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../swap/test-fixtures'
import { expectedTotalText, portfolioFetch } from '../portfolio/portfolio-harness'
import { h as dca, resetHarness as resetDca } from '../dca/dca-harness'
import { fake, resetFake } from '../dca/dca-engine-fake'
import { ALL_ORDERS, FILLS, NOW as ORDERS_NOW, ORDER_META, PRICES } from '../dca/positions-fixtures'
import { DASHBOARD, NOW as ANALYTICS_NOW, PERSONAL, STATS } from '../analytics/analytics-fixtures'
import { allowFor as ordersGlyphs, remapV1 } from '../orders/orders-remap'

const CHAINS = [1, 8453, 42161] as const
const DCA_CHAINS_LIVE = [8453, 42161] as const

/** The one decorative-glyph rule every tab shares: v1 prints the glyph as text, v2 draws it aria-hidden beside a control that keeps its name. */
const GLYPH = 'decorative glyph, aria-hidden in v2; the control keeps its accessible name'
const glyphs = (list: readonly string[], why: string): AllowedRemoval[] => list.map((text) => ({ text, reason: `${why}: ${GLYPH}` }))

/**
 * The consolidated content-map deltas — every v1 string/surface v2 intentionally does not carry, ONE table for the whole app. The
 * per-tab ALLOW lists below are the source; `OPEN_DELTAS` are surfaces with no v2 counterpart at all. FEEDBACK prints this table.
 */
export const OPEN_DELTAS = [
  { item: 'Limit order panel (LimitOrderPanel)', tab: 'Limit', why: 'v2 has no pane; AppShell mounts the skeleton TabPane', decision: 'owner, feat/ui-v2-mobile-parity: keep "Soon" in v2 until a pane exists' },
  { item: 'Take-Profit / SL panel (ConditionalOrderPanel)', tab: 'SL/TP', why: 'v2 has no pane; AppShell mounts the skeleton TabPane', decision: 'owner, feat/ui-v2-mobile-parity: keep "Soon" in v2 until a pane exists' },
  { item: '"Coming Soon on <chain>" banner (2 strings)', tab: 'Swap', why: 'only when a chain has no FeeCollector (P223); v2 disables the CTA but prints no banner. Unreachable on 1/8453/42161 where all three are deployed', decision: 'owner, feat/ui-v2-mobile-parity (asked in-session): record, do not add — pinned below to exactly its two strings' },
] as const
/** The tabs that have NO v2 pane at all (a subset of the deltas above). */
const NO_PANE_TABS = ['limit', 'sltp'] as const

/** v1 SwapBox's P223 banner on a chain with no FeeCollector; v2 has no counterpart (unreachable on 1/8453/42161 in prod, where all three are deployed). */
const SWAP_INACTIVE_BANNER = ['🚀 Coming Soon on', "Swaps aren't live on this network yet — switch to Ethereum to trade. You can still browse tokens here."]

function expectClean(label: string, r: ParityResult, minNodes = 1) {
  console.log(`[sweep] ${label}: v1 text nodes ${r.v1Nodes}, v1 links ${r.v1Hrefs}, missing text ${r.missingText.length}, missing hrefs ${r.missingHrefs.length}, stale allow ${r.staleAllow.length}`)
  expect(r.v1Nodes, `${label}: the v1 walk really covered the surface`).toBeGreaterThanOrEqual(minNodes)
  expect(r.missingText, `${label}: v1 text missing from v2`).toEqual([])
  expect(r.missingHrefs, `${label}: v1 links missing from v2`).toEqual([])
  expect(r.staleAllow, `${label}: stale allow-list entries`).toEqual([])
}

const chainName = (id: number) => ({ 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum One' })[id]
const setWallet = (chainId: number, connected = true) => {
  h.chainId = chainId
  h.account = connected ? { address: WALLET, isConnected: true, chain: { id: chainId } } : { address: undefined, isConnected: false, chain: undefined }
}

beforeEach(() => {
  h.mode = 'swap'
  h.chainId = 1
  h.inactive = new Set()
  h.limitLive = false
  h.account = { address: undefined, isConnected: false, chain: undefined }
  h.balance = undefined
  h.push.mockReset()
  h.headers = null
  h.round = [1n, 245_000_000_000n, 0n, 0n, 1n]
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.tier = { data: null, loading: false }
  h.quote = { meta: null, loading: false, error: null, countdown: 12, refresh: noop }
  h.analytics = { dashboard: DASHBOARD, loading: false }
  h.personal = { data: PERSONAL, isLoading: false, error: null }
  resetDca()
  resetFake()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ══ Swap ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(CHAINS)('sweep · Swap · chain %i', (chainId) => {
  const ALLOW = glyphs(['⇅', '⟳', '✎', 'ⓘ', '⚙', '×'], 'swap controls')
  const type = (container: HTMLElement, value: string) => fireEvent.change(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value } })

  function both(connected: boolean) {
    h.mode = 'swap'
    setWallet(chainId, connected)
    h.balance = connected ? { value: 3_000_000_000_000_000_000n, decimals: 18 } : undefined
    const native = getChainTokenList(chainId).find((t) => t.symbol === 'ETH')!
    const usdc = getCanonicalUsdc(chainId)!
    h.quote = { meta: taggedFixture(fixtureMeta(), '1', chainId, native, usdc), loading: false, error: null, countdown: 12, refresh: noop }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
    const v1 = render(<SwapBox />)
    type(v1.container, '1')
    const v2 = render(<SwapCard />)
    type(v2.container, '1')
    return compareContent(v1.container, v2.container, ALLOW)
  }

  it('connected with a balance: v1 ⊆ v2, text and links', () => expectClean(`Swap ${chainName(chainId)} connected`, both(true), 30))

  it('a chain with no deployed FeeCollector (P223 coming-soon): the ONE open delta is the banner, exactly its two v1 strings', () => {
    h.inactive = new Set([chainId])
    const r = both(false)
    expect(r.missingText).toEqual(SWAP_INACTIVE_BANNER.map(normalize))
    expect(r.missingHrefs).toEqual([])
  })
  it('disconnected: v1 ⊆ v2, text and links', () => expectClean(`Swap ${chainName(chainId)} disconnected`, both(false), 20))
})

// ══ Portfolio ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(CHAINS)('sweep · Portfolio · chain %i', (chainId) => {
  it('holdings: v1 ⊆ v2, text and links, once both show the fully priced total', async () => {
    h.mode = 'portfolio'
    setWallet(chainId)
    h.balance = { value: 5n * 10n ** 17n, decimals: 18, symbol: 'ETH', formatted: '0.5' }
    vi.stubGlobal('fetch', portfolioFetch())
    const v1 = render(<V1PortfolioTab onSwapToken={() => h.push('/swap')} />)
    const v2 = render(<V2PortfolioTab />)
    await waitFor(
      () => {
        expect(v2.container.querySelector('[data-testid="portfolio-total"]')?.textContent).toBe(expectedTotalText(chainId))
        expect(normalize(v1.container.textContent ?? '')).toContain(normalize(expectedTotalText(chainId)))
      },
      { timeout: 8_000 },
    )
    expectClean(`Portfolio ${chainName(chainId)}`, compareContent(v1.container, v2.container), 8)
  })
})

// ══ DCA ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(DCA_CHAINS_LIVE)('sweep · DCA · chain %i (a DCA chain: the card)', (chainId) => {
  const ALLOW = glyphs(['▸', '↓'], 'DCA create form')
  const typeAmount = (container: HTMLElement, v: string) => fireEvent.change(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: v } })

  it.each(['', '0.5'])('create form, amount %j: v1 DCAPanel ⊆ v2 DcaCard', (amount) => {
    h.mode = 'dca'
    setWallet(chainId)
    dca.account = { address: WALLET, isConnected: true, chain: { id: chainId } }
    const weth = findChainToken(getWrappedNative(chainId), chainId)!
    dca.balances = new Map([[weth.address.toLowerCase(), { raw: 2_000_000_000_000_000_000n, formatted: '2.0' }]])
    const v1 = render(<DCAPanel chainId={chainId} />)
    if (amount) typeAmount(v1.container, amount)
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<DcaCard chainId={chainId} />)
    if (amount) typeAmount(v2.container, amount)
    const allow = [...ALLOW, ...(amount ? [{ text: 'Start DCA — 10 buys over 10.0 days', reason: 'owner B6a: "Review DCA"; the v1 label also names buys and duration, which the summary rows state' }] : [])]
    expectClean(`DCA ${chainName(chainId)} amount ${amount || 'empty'}`, compareContent(v1Root, v2.container, allow), 20)
  })
})

describe('sweep · DCA · chain 1 (not a DCA chain: the network gate)', () => {
  it("v1's ComingSoonPanel(dca) ⊆ v2's DcaNetworkGate — the sentence and both switches, never \"Soon\"", () => {
    h.mode = 'dca'
    setWallet(1, false)
    const v1 = render(<ComingSoonPanel mode="dca" chainId={1} onSwap={noop} />)
    const v1Sentence = v1.getByTestId('coming-soon-runs-on').textContent
    const v1Buttons = screen.getAllByTestId(/^switch-to-/).map((b) => b.textContent)
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<DcaNetworkGate />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`${v1Sentence}.`)
    expect(Array.from(v2.container.querySelectorAll('button')).map((b) => b.textContent)).toEqual([...v1Buttons, 'Swap Now →'])
    expectClean('DCA gate (Ethereum)', compareContent(v1Root, v2.container, [{ text: '⟳', reason: "v1's teaser icon: decorative; the gate is a hero without a glyph" }]), 5)
    expect(document.body.textContent).not.toMatch(/soon/i)
  })
})

// ══ Limit · SL/TP ════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(CHAINS)('sweep · Limit and SL/TP · chain %i (no v2 pane: owner decision, the tabs stay "Soon")', (chainId) => {
  it('the strip keeps both tabs disabled "Soon" and never navigates to the skeleton pane, even where v1 says live', () => {
    h.mode = 'swap'
    setWallet(chainId)
    h.limitLive = true // v1's gate answers "live" on Base — the exact condition under which v2 used to open the skeleton
    expect(isLimitLive(chainId)).toBe(chainId === 8453)
    render(<TabBar active="swap" />)
    for (const label of ['Limit', 'SL/TP']) {
      const tab = screen.getByRole('tab', { name: new RegExp(`^${label.replace('/', '\\/')}`) })
      expect(tab.hasAttribute('disabled'), `${label} on ${chainName(chainId)}`).toBe(true)
      expect(tab.textContent).toMatch(/soon/i)
      fireEvent.click(tab)
    }
    expect(h.push).not.toHaveBeenCalled()
  })
})

// ══ Orders ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(CHAINS)('sweep · Orders · wallet on chain %i (orders of every chain are listed whichever chain is selected)', (chainId) => {
  const fetchMock = vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
    const { pathname } = new URL(url, 'http://localhost')
    if (pathname === '/api/portfolio/prices') return json({ prices: PRICES })
    const m = /^\/api\/orders\/([^/]+)\/executions/.exec(pathname)
    if (m) return json({ executions: FILLS[m[1]] ?? [], order: ORDER_META[m[1]] ?? null })
    throw new Error(`unexpected fetch ${url}`)
  })

  it.each([
    ['active', /^Active/],
    ['completed', /^Completed/],
    ['cancelled', /^Cancelled/],
  ] as const)('the %s list: v1 OrderDashboard ⊆ v2 OrdersTab', (_f, name) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ORDERS_NOW)
    h.mode = 'orders'
    setWallet(chainId)
    fake.orders = ALL_ORDERS
    vi.stubGlobal('fetch', fetchMock)
    const v1 = render(<OrderDashboard />)
    fireEvent.click(screen.getByRole('button', { name }))
    const v1Root = remapV1(v1.container, ALL_ORDERS)
    cleanup()
    const v2 = render(<OrdersTab />)
    fireEvent.click(screen.getByRole('tab', { name }))
    expectClean(`Orders ${_f} (wallet ${chainName(chainId)})`, compareContent(v1Root, v2.container, ordersGlyphs(v1Root)), 10)
  })
})

// ══ History ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(CHAINS)('sweep · History · wallet on chain %i', (chainId) => {
  const ago = (ms: number) => new Date(ANALYTICS_NOW - ms).toISOString()
  const SWAPS: SwapRecord[] = [
    { kind: 'swap', id: 's1', tx_hash: `0x3c7e${'a'.repeat(54)}0091d2`, source: 'velora', token_in_symbol: 'ETH', token_out_symbol: 'USDC', amount_in: '700000000000000', amount_out: '1718300', amount_in_usd: 1.72, status: 'confirmed', created_at: ago(60_000), chain_id: 8453 },
    { kind: 'swap', id: 's2', tx_hash: `0x074fe0${'b'.repeat(52)}560b84`, source: '1inch', token_in_symbol: 'ETH', token_out_symbol: 'ETHFI', amount_in: '0.005', amount_out: '18.68', amount_in_usd: null, status: 'success', created_at: ago(17 * 86_400_000), chain_id: 1 },
    { kind: 'dca_fill', id: 'f1', tx_hash: `0xb404fe${'c'.repeat(52)}023768`, source: 'teraswap_order_engine', token_in_symbol: 'USDC', token_out_symbol: 'WETH', amount_in: '1148300', amount_out: '454000000000000', amount_in_usd: 1.15, status: 'confirmed', created_at: ago(28 * 86_400_000), chain_id: 42161, order_id: 'ord-0000-87e31a', execution_number: 3, dca_total: 3 },
    { kind: 'swap', id: 's3', tx_hash: `0x785cc9${'d'.repeat(52)}ae33a4`, source: 'paraswap', token_in_symbol: 'stETH', token_out_symbol: 'USDT', amount_in: '1000000000000000000', amount_out: '2480120000', amount_in_usd: 2480.5, status: 'reverted', created_at: ago(3 * 3_600_000), chain_id: 8453 },
  ]

  it('list: v1 WalletHistory ⊆ v2 HistoryTab, text and links (a tx links to its own chain\'s explorer)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ANALYTICS_NOW)
    h.mode = 'history'
    setWallet(chainId)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ swaps: SWAPS, total: 62 }) }) as Response))
    const v1 = render(<WalletHistory />)
    await waitFor(() => expect(v1.container.textContent).toMatch(/Showing 4 of 62/))
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<HistoryTab />)
    await waitFor(() => expect(v2.container.textContent).toMatch(/Showing 4 of 62/))
    expectClean(`History (wallet ${chainName(chainId)})`, compareContent(v1Root, v2.container, glyphs(['⟳', '⇄'].filter((g) => v1Root.textContent?.includes(g)), 'history row')), 30)
  })
})

// ══ Analytics ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(CHAINS)('sweep · Analytics · wallet on chain %i', (chainId) => {
  const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

  it('tab + /analytics page body: v1 ⊆ v2, text and links', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ANALYTICS_NOW)
    h.mode = 'analytics'
    setWallet(chainId)
    h.account = { address: PERSONAL.wallet, isConnected: true, chain: { id: chainId } }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => STATS }) as Response))
    const V1 = (): ReactElement => (
      <div>
        <AnalyticsDashboard />
        <PublicProtocolStats payload={STATS as PublicStatsPayload} loading={false} failed={false} />
        <PersonalDashboard />
      </div>
    )
    const v1 = render(<V1 />)
    await settle()
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<AnalyticsTab />)
    await settle()
    expectClean(`Analytics (wallet ${chainName(chainId)})`, compareContent(v1Root, v2.container), 100)
  })
})

// ══ Landing ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe.each(CHAINS)('sweep · landing · selected chain %i', (chainId) => {
  // owner, 26 Oct 2026 (feat/ui-v2-landing run): v2 has no particle network, so the clause would be untrue there
  const ALLOW: AllowedRemoval[] = [{ text: 'with a dynamic animated particle environment that responds to your every move', reason: 'owner, 26 Oct 2026: drop the clause, keep the rest of the sentence' }]

  it('v1 LandingPage + LandingBelowFold ⊆ v2 landing, text and links', () => {
    h.mode = 'landing'
    setWallet(chainId, false)
    const v1 = render(
      <div data-v1="">
        <LandingPage onLaunchApp={noop} />
        <LandingBelowFold onLaunchApp={noop} />
      </div>,
    )
    const v1Root = v1.container.querySelector('[data-v1]')!
    const v2 = render(<LandingV2 onLaunchApp={noop} />)
    const v2Root = v2.container.querySelector('[data-ts-landing]')!
    expectClean(`landing ${chainName(chainId)}`, compareContent(v1Root, v2Root, ALLOW), 100)
  })
})

// ══ the sweep covers every tab ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('sweep · coverage', () => {
  it('every one of the 8 tabs is either compared above or a documented no-pane tab in OPEN_DELTAS — a new tab cannot slip past', async () => {
    const { V2_TABS } = await import('../shell/tab-paths')
    const compared = ['swap', 'portfolio', 'dca', 'orders', 'history', 'analytics']
    expect([...compared, ...NO_PANE_TABS].sort()).toEqual(V2_TABS.map((t) => t.id).sort())
    for (const id of NO_PANE_TABS) expect(OPEN_DELTAS.some((d) => d.tab.toLowerCase().replace('/', '') === id), `${id} is in OPEN_DELTAS`).toBe(true)
  })
})
