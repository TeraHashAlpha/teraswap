/**
 * [feat/frontend-rpc-diet] Scenario runner for the browser-RPC budget tests.
 *
 * Mounts the REAL provider tree (`src/app/providers.tsx`: wagmi config + QueryClient defaults) and the REAL Swap / landing
 * components, with fake timers and the counting transport from `rpc-harness.ts`. A test file must
 * `vi.mock('@/lib/rpc-guarded-transport', ...)` itself (vi.mock is hoisted per file) — see `rpc-budget.harness.test.tsx`.
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
import { rpcCounter, resetRpcCounter, totalRpcCalls } from './rpc-harness'

export type Ui = 'v1' | 'v2'
/** a0 landing visitor · a swap visitor, no amount · b visitor + amount · c wallet + amount (ETH→USDC) · c20 wallet + amount, ERC-20 sell (USDC→ETH) */
export type State = 'a0' | 'a' | 'b' | 'c' | 'c20'

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

    if (state === 'c' || state === 'c20') {
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

    const before = snap()
    await advance(WINDOW_MS)
    const steadyEnd = snap()
    const diff = (a: Record<string, number>, b: Record<string, number>) => {
      const out: Record<string, number> = {}
      for (const m of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = (b[m] ?? 0) - (a[m] ?? 0)
        if (d) out[m] = d
      }
      return out
    }

    let hiddenCalls: Record<string, number> | null = null
    let returned: Record<string, number> | null = null
    if (hide) {
      setVisibility('hidden')
      await advance(0)
      const h0 = snap()
      await advance(WINDOW_MS)
      hiddenCalls = diff(h0, snap())
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
    }
    return result
  } finally {
    cleanup()
    // The wagmi config is a module singleton: drop the mock wallet so the next scenario starts as a visitor.
    if (state === 'c' || state === 'c20') await act(async () => { await disconnect(config).catch(() => {}) })
    try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom storage unavailable */ }
    clock = Math.max(clock, Date.now())
    vi.useRealTimers()
  }
}

export const sum = (m: Record<string, number> | null): number => (m ? Object.values(m).reduce((a, b) => a + b, 0) : 0)
export { totalRpcCalls }
