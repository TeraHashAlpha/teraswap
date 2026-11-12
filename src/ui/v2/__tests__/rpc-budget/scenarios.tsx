/**
 * [feat/frontend-rpc-diet] Scenario runner for the browser-RPC budget tests.
 *
 * Mounts the REAL provider tree (`src/app/providers.tsx`: wagmi config + QueryClient defaults) and the REAL Swap / landing
 * components, with fake timers and the counting transport from `rpc-harness.ts`. A test file must
 * `vi.mock('@/lib/rpc-guarded-transport', ...)` itself (vi.mock is hoisted per file) — see `harness.test.tsx`.
 *
 * Window definition (kept identical for BEFORE and AFTER so the tables compare):
 *   mount  = every call in the first SETTLE_MS after mount  (one-time page-load burst, reported not budgeted per minute)
 *   steady = every call in the following 60 s                (the per-minute rate a left-open tab pays)
 *   return = calls in the 5 s after the tab goes visible again (hidden scenarios only)
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { vi } from 'vitest'
import { connect, disconnect } from 'wagmi/actions'
import { mock } from 'wagmi/connectors'
import { fixtureMeta } from '@/ui/v2/swap/test-fixtures'
import { DASHBOARD, PERSONAL, STATS } from '@/ui/v2/analytics/analytics-fixtures'
import { rpcCounter, resetRpcCounter, totalRpcCalls } from '@/test-utils/rpc-harness'

export type Ui = 'v1' | 'v2'
/**
 * Globals every harness test file needs (call from `beforeAll`). The test file itself must also hoist these mocks:
 * `@/lib/rpc-guarded-transport` (→ `mockGuardedTransportModule()`), `@/components/BackgroundMusic`,
 * `@/lib/sounds`, `@/ui/v2/font-loader`, `@/components/ParticleNetwork` — see `harness.test.tsx`.
 */
export function installHarnessGlobals(): void {
  // jsdom has no IntersectionObserver (framer-motion's useInView on the landing needs one).
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    },
  )
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  // /api/quote answers with a real-shaped 5-source quote (HTTP is not RPC; the quote only has to EXIST so the oracle /
  // approval hooks that key off it are active, exactly as for a user who typed an amount). Everything else: `{}`.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      let body: unknown = {}
      // [B9] the Analytics tab's three reads answer with real-shaped bodies (HTTP is not RPC; v1's PersonalDashboard reads `sourceWinRates`).
      if (url.includes('/api/analytics/personal')) body = PERSONAL
      else if (url.includes('/api/analytics')) body = { dashboard: DASHBOARD }
      else if (url.includes('/api/stats')) body = STATS
      else if (url.includes('/api/quote')) {
        // Echo the request's identity exactly as /api/quote does (useQuote rejects a quote that does not name its pair).
        const q = new URL(url, 'http://localhost').searchParams
        body = {
          ...fixtureMeta({ fetchedAt: Date.now() }),
          tokenIn: q.get('src'),
          tokenOut: q.get('dst'),
          chainId: Number(q.get('chainId') ?? 1),
          decimalsIn: Number(q.get('srcDecimals')),
          decimalsOut: Number(q.get('dstDecimals')),
          amountIn: q.get('amount'),
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
}

/** a0 landing visitor · a swap visitor, no amount · b visitor + amount · c wallet + amount (ETH→USDC) · c20 wallet + amount, ERC-20 sell (USDC→ETH) · p wallet on the Portfolio tab (B8) · an wallet on the Analytics tab (B9) · docs visitor on /docs (feat/ui-v2-docs-legal) */
export type State = 'a0' | 'a' | 'b' | 'c' | 'c20' | 'p' | 'an' | 'docs'

export interface ScenarioResult {
  ui: Ui
  state: State
  /** Per-method calls in the page-load burst. */
  mount: Record<string, number>
  /** Per-method calls in the 60 s steady window (visible). */
  steady: Record<string, number>
  /** Per-method calls in the 60 s window after the tab went hidden (null when the scenario never hides). */
  hidden: Record<string, number> | null
  /** Per-method calls in the 5 s after the tab became visible again (null when the scenario never hides). */
  returned: Record<string, number> | null
  /** [B9] HTTP (not RPC) requests per path over the same two windows — `/api/analytics` is polled by v1's own hook; reported so v1 and v2 compare. */
  http: { steady: Record<string, number>; hidden: Record<string, number> | null }
}

export const SETTLE_MS = 5_000
export const WINDOW_MS = 60_000
export const RETURN_MS = 5_000
export const TEST_ACCOUNT = '0x1111111111111111111111111111111111111111' as const

/**
 * viem caches reads (`withCache`) with `Date.now()` stamps on a client that outlives a scenario, so every scenario must
 * start its fake clock AFTER the previous one ended, or its first minute would be answered from the previous run's cache.
 */
let clock = Date.now()

export function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' })
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

const snap = () => ({ ...rpcCounter.byMethod })

/** Count of `fetch` calls per URL path so far (the global stub is a vi.fn that lives across scenarios; windows are diffed). */
const httpSnap = (): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [input] of (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
    const path = new URL(String(input), 'http://localhost').pathname
    out[path] = (out[path] ?? 0) + 1
  }
  return out
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Type into the sell-amount input of whichever UI is mounted. */
function typeAmount(ui: Ui, value: string): void {
  const input =
    ui === 'v2'
      ? (document.querySelector('input[aria-label="Sell amount"]') as HTMLInputElement)
      : (document.querySelector('input[inputmode="decimal"]') as HTMLInputElement)
  if (!input) throw new Error('sell-amount input not found')
  fireEvent.change(input, { target: { value } })
}

export async function runScenario(opts: { ui: Ui; state: State; hide?: boolean }): Promise<ScenarioResult> {
  const { ui, state, hide = false } = opts
  // Load every module BEFORE faking timers: the module runner needs real timers to resolve dynamic imports.
  const [{ default: Providers }, { config }] = await Promise.all([import('@/app/providers'), import('@/lib/wagmiConfig')])

  let tree: React.ReactNode
  if (state === 'a0') {
    if (ui === 'v1') {
      const [{ default: LandingPage }, { default: Footer }] = await Promise.all([import('@/components/LandingPage'), import('@/components/Footer')])
      tree = (
        <>
          <LandingPage onLaunchApp={() => {}} />
          <Footer />
        </>
      )
    } else {
      const { LandingV2 } = await import('@/ui/v2/landing')
      tree = <LandingV2 onLaunchApp={() => {}} />
    }
  } else if (state === 'docs') {
    // [feat/ui-v2-docs-legal] A disconnected visitor on /docs: the page reads no wallet/chain RPC of its own
    // (product-claims are pure functions), so the only RPC is the footer's block poll — same budget as a0/a.
    if (ui === 'v1') {
      const [{ default: DocsPage }, { default: Footer }] = await Promise.all([import('@/components/DocsPage'), import('@/components/Footer')])
      tree = (
        <>
          <DocsPage />
          <Footer />
        </>
      )
    } else {
      const [{ DocsTabV2 }, { Footer }, { V2ToastProvider }] = await Promise.all([
        import('@/ui/v2/docs-legal/DocsTabV2'),
        import('@/ui/v2/shell/Footer'),
        import('@/ui/v2/shell/toasts'),
      ])
      tree = (
        <V2ToastProvider>
          <DocsTabV2 />
          <Footer />
        </V2ToastProvider>
      )
    }
  } else if (state === 'an') {
    // [B9] The Analytics tab with a connected wallet. v1 = its three Analytics components in the order the tab + /analytics page show them
    // (AnalyticsDashboard, PublicProtocolStats, PersonalDashboard), v2 = the one tab. The reads are HTTP; the only RPC is the footer block
    // and the connected wallet's own reads, so the budget is the Portfolio one.
    if (ui === 'v1') {
      const [{ default: AnalyticsDashboard }, { default: PublicProtocolStats }, { default: PersonalDashboard }, { default: Footer }] = await Promise.all([
        import('@/components/AnalyticsDashboard'),
        import('@/components/PublicProtocolStats'),
        import('@/components/PersonalDashboard'),
        import('@/components/Footer'),
      ])
      tree = (
        <>
          <AnalyticsDashboard />
          <PublicProtocolStats payload={STATS} loading={false} failed={false} />
          <PersonalDashboard />
          <Footer />
        </>
      )
    } else {
      const [{ AnalyticsTab }, { Footer }, { V2ToastProvider }] = await Promise.all([
        import('@/ui/v2/analytics/AnalyticsTab'),
        import('@/ui/v2/shell/Footer'),
        import('@/ui/v2/shell/toasts'),
      ])
      tree = (
        <V2ToastProvider>
          <AnalyticsTab />
          <Footer />
        </V2ToastProvider>
      )
    }
  } else if (state === 'p') {
    // [B8] The Portfolio tab with a connected wallet: v1's PortfolioTab / the v2 tab, both over the same usePortfolio().
    // /api/portfolio/* answers `{}` (HTTP is not RPC): discovery is "available" with no ERC-20s, so the native balance is the RPC reader.
    if (ui === 'v1') {
      const [{ default: PortfolioTab }, { default: Footer }] = await Promise.all([import('@/components/PortfolioTab'), import('@/components/Footer')])
      tree = (
        <>
          <PortfolioTab />
          <Footer />
        </>
      )
    } else {
      const [{ PortfolioTab }, { Footer }, { V2ToastProvider }] = await Promise.all([
        import('@/ui/v2/portfolio/PortfolioTab'),
        import('@/ui/v2/shell/Footer'),
        import('@/ui/v2/shell/toasts'),
      ])
      tree = (
        <V2ToastProvider>
          <PortfolioTab />
          <Footer />
        </V2ToastProvider>
      )
    }
  } else if (ui === 'v1') {
    const [{ default: SwapBox }, { default: Footer }] = await Promise.all([import('@/components/SwapBox'), import('@/components/Footer')])
    tree = (
      <>
        <SwapBox />
        <Footer />
      </>
    )
  } else {
    const [{ SwapCard }, { Footer }, { V2ToastProvider }] = await Promise.all([
      import('@/ui/v2/swap/SwapCard'),
      import('@/ui/v2/shell/Footer'),
      import('@/ui/v2/shell/toasts'),
    ])
    tree = (
      <V2ToastProvider>
        <SwapCard />
        <Footer />
      </V2ToastProvider>
    )
  }

  try {
    clock += 10 * 60_000
    vi.useFakeTimers({ now: clock, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    setVisibility('visible')
    resetRpcCounter()

    await act(async () => {
      render(<Providers>{tree}</Providers>)
    })
    // `Providers` is loaded through next/dynamic in production only; here it is the component itself.

    if (state === 'c' || state === 'c20' || state === 'p' || state === 'an') {
      // Let WagmiProvider's reconnect-on-mount finish first, or its "no recent connector" result lands after connect().
      await advance(250)
      await act(async () => {
        const connector = config._internal.connectors.setup(mock({ accounts: [TEST_ACCOUNT], features: { reconnect: true } }))
        await connect(config, { connector })
      })
      if (config.state.status !== 'connected') throw new Error(`mock wallet failed to connect (status ${config.state.status})`)
    }
    if (state === 'c20') {
      // ⇅ flips ETH→USDC into USDC→ETH: an ERC-20 sell, so the allowance / Permit2 reads are exercised.
      const flip = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('⇅'))
      if (!flip) throw new Error('flip button not found')
      fireEvent.click(flip)
    }
    if (state === 'b' || state === 'c' || state === 'c20') {
      typeAmount(ui, '1')
    }

    await advance(SETTLE_MS)
    const afterMount = snap()

    const diff = (a: Record<string, number>, b: Record<string, number>) => {
      const out: Record<string, number> = {}
      for (const m of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = (b[m] ?? 0) - (a[m] ?? 0)
        if (d) out[m] = d
      }
      return out
    }

    const before = snap()
    const httpBefore = httpSnap()
    await advance(WINDOW_MS)
    const steadyEnd = snap()
    const httpSteady = diff(httpBefore, httpSnap())

    let hiddenCalls: Record<string, number> | null = null
    let returned: Record<string, number> | null = null
    let httpHidden: Record<string, number> | null = null
    if (hide) {
      setVisibility('hidden')
      await advance(0)
      const h0 = snap()
      const hh0 = httpSnap()
      await advance(WINDOW_MS)
      hiddenCalls = diff(h0, snap())
      httpHidden = diff(hh0, httpSnap())
      const r0 = snap()
      setVisibility('visible')
      await advance(RETURN_MS)
      returned = diff(r0, snap())
    }

    const result: ScenarioResult = {
      ui,
      state,
      mount: afterMount,
      steady: diff(before, steadyEnd),
      hidden: hiddenCalls,
      returned,
      http: { steady: httpSteady, hidden: httpHidden },
    }
    return result
  } finally {
    cleanup()
    // The wagmi config is a module singleton: drop the mock wallet so the next scenario starts as a visitor.
    if (state === 'c' || state === 'c20' || state === 'p' || state === 'an') await act(async () => { await disconnect(config).catch(() => {}) })
    try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom storage unavailable */ }
    clock = Math.max(clock, Date.now())
    vi.useRealTimers()
  }
}

export const sum = (m: Record<string, number> | null): number => (m ? Object.values(m).reduce((a, b) => a + b, 0) : 0)
export { totalRpcCalls }
