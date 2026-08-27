// @vitest-environment jsdom
/**
 * [CHORE-ARBITRUM-ACTIVATION-SWITCH-PROOF, repaired INC-2026-08-26-001] Page-level proof that the
 * real (unmocked) gate on Arbitrum blocks <DCAPanel> from mounting.
 *
 * page.test.tsx mocks '@/lib/dca-launch' entirely (a file-scoped vi.mock, so it can't be
 * selectively un-mocked for one test in that file) — it pins the page's WIRING to isDcaLive, not
 * isDcaLive's own real behavior. This file is the real-gate counterpart: it mounts the actual
 * Home component (src/app/page.tsx — the real owner of the Coming-Soon-vs-<DCAPanel> branch) with
 * the connected chain set to Arbitrum (42161) and the real, unmocked dca-launch / order-engine /
 * chain-registry modules.
 *
 * Every case names exactly which of the three gate variables it holds SET vs UNSET — never
 * "today's defaults". The original version of this file deleted all three in beforeEach and called
 * that "today's real default (both Arbitrum vars unset)", while in Production NEXT_PUBLIC_DCA_ENABLED
 * was set, NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR had been set since 2026-07-20 and
 * NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM was set from 2026-08-04 to 2026-08-26. The suite
 * was green against a world that no longer existed (INC-2026-08-26-001: DCA reachable on Arbitrum
 * for 22 days on a chain with no keeper). The third case below IS that Production shape; it holds
 * only because v3 chain eligibility is now a code decision (ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS in
 * src/lib/order-engine/config.ts) and it FAILS against a config.ts where env alone can enable a chain.
 *
 * The order-engine config and the chain registry read env at MODULE LOAD, so every case resets the
 * module registry and imports the page fresh AFTER its env stubs (the pattern
 * dca-launch.arbitrum-activation.test.ts uses). vi.mock registrations survive vi.resetModules().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'

const useChainIdMock = vi.fn(() => 42161)

vi.mock('wagmi', () => ({ useChainId: () => useChainIdMock() }))
vi.mock('@/lib/sounds', () => ({ playTouchMP3: vi.fn() }))
// '@/lib/dca-launch', '@/lib/order-engine' (getOrderExecutorV3 / isLimitLive) and '@/lib/chains'
// (isChainActive) are intentionally NOT mocked here — the real gates run against real env.

// Stub every heavy child so Home mounts in jsdom without canvas / RPC / providers — identical to
// page.test.tsx's stub set, so the only behavioral difference from that file is the real gate.
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null }))
vi.mock('@/components/LandingPage', () => ({
  default: ({ onLaunchApp }: { onLaunchApp: () => void }) => (
    <button onClick={onLaunchApp}>launch-app</button>
  ),
}))
vi.mock('@/components/ScrollSpy', () => ({ default: () => null }))
vi.mock('@/components/Header', () => ({ default: () => null }))
vi.mock('@/components/SwapBox', () => ({ default: () => <div data-testid="swapbox" /> }))
vi.mock('@/components/SwapHistory', () => ({ default: () => null }))
vi.mock('@/components/Footer', () => ({ default: () => null }))
vi.mock('@/components/SwapErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/HelpButton', () => ({ default: () => null }))
vi.mock('@/components/NotificationBanner', () => ({ default: () => null }))
vi.mock('@/components/DCAPanel', () => ({ default: () => <div data-testid="dca-panel">DCA Panel</div> }))
vi.mock('@/components/LimitOrderPanel', () => ({ default: () => <div data-testid="limit-panel">Limit Panel</div> }))
vi.mock('@/components/ConditionalOrderPanel', () => ({ default: () => <div data-testid="sltp-panel">SL/TP Panel</div> }))
vi.mock('@/components/AnalyticsDashboard', () => ({ default: () => null }))
vi.mock('@/components/OrderDashboard', () => ({ default: () => null }))
vi.mock('@/components/WalletHistory', () => ({ default: () => null }))
vi.mock('@/components/PortfolioTab', () => ({ default: () => null }))

import { render, screen, fireEvent, within } from '@testing-library/react'

/**
 * Mount the REAL Home fresh. The registry (NEXT_PUBLIC_*_FEE_COLLECTOR) and the order-engine config
 * (NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS*) read env at module load, so the import must happen AFTER
 * the case's env stubs — a static top-level import would pin every case to the env of the first load.
 */
async function renderSwapView() {
  vi.resetModules()
  const { default: Home } = await import('./page')
  render(<Home />)
  fireEvent.click(screen.getByText('launch-app'))
}

function tabButtons(): HTMLButtonElement[] {
  return screen.getAllByRole('button') as HTMLButtonElement[]
}

function dcaTab(): HTMLButtonElement {
  const btn = tabButtons().find(b => /^DCA/.test(b.textContent ?? ''))
  if (!btn) throw new Error('DCA tab not found')
  return btn
}

function expectDcaTabIsTheTeaser() {
  const tab = dcaTab()
  expect(tab).toBeDisabled()
  expect(within(tab).getByText('Soon')).toBeInTheDocument()

  // The tab is disabled, so a real user (and jsdom) can never select it — the swap mode stays on
  // 'instant' and neither the teaser panel nor <DCAPanel> ever render. That IS the proof: the DCA
  // panel is unreachable, not merely unmounted-by-default.
  fireEvent.click(tab)
  expect(screen.queryByTestId('dca-panel')).not.toBeInTheDocument()
  expect(screen.queryByText(/Coming Soon on L2/i)).not.toBeInTheDocument()
}

const ENV_KEYS = [
  'NEXT_PUBLIC_DCA_ENABLED',
  'NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR',
  'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM',
  // Base's pair — held unset too, so the positive control below owns its own state explicitly.
  'NEXT_PUBLIC_BASE_FEE_COLLECTOR',
  'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE',
] as const

// Test constants only — the same synthetic, syntactically valid 20-byte addresses this repo's own
// tests use (dca-launch.arbitrum-activation.test.ts / order-engine/config.test.ts). Nothing on-chain.
const FEE_COLLECTOR_STUB = '0x000000000000000000000000000000000000dEaD'
const V3_EXECUTOR_STUB = '0x5555555555555555555555555555555555555555'

beforeEach(() => {
  vi.clearAllMocks()
  useChainIdMock.mockReturnValue(42161)
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Home — real Arbitrum gate (no mocked dca-launch / order-engine / registry)', () => {
  it('flag UNSET, FeeCollector UNSET, v3 address UNSET ⇒ DCA tab is the Soon teaser and <DCAPanel> never mounts', async () => {
    await renderSwapView()
    expectDcaTabIsTheTeaser()
  })

  it('flag SET, FeeCollector UNSET, v3 address UNSET ⇒ still the teaser (holds both Arbitrum vars unset — NOT the Production shape)', async () => {
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')
    await renderSwapView()
    expectDcaTabIsTheTeaser()
  })

  it('flag SET, FeeCollector SET, v3 address SET — the Production shape 2026-08-04 → 2026-08-26 ⇒ STILL the teaser: eligibility is a code decision, not env', async () => {
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', FEE_COLLECTOR_STUB)
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', V3_EXECUTOR_STUB)

    // Sanity: the env genuinely reached the REAL modules — the chain is active and the raw v3 env
    // slot is populated. The only thing standing between this state and <DCAPanel> is the
    // code-level allowlist; if these two lines ever fail the case would be passing vacuously.
    vi.resetModules()
    const { isChainActive } = await import('@/lib/chains')
    const { ORDER_EXECUTOR_V3_BY_CHAIN, getOrderExecutorV3 } = await import('@/lib/order-engine')
    expect(isChainActive(42161)).toBe(true)
    expect(ORDER_EXECUTOR_V3_BY_CHAIN[42161]).toBe(V3_EXECUTOR_STUB)
    expect(getOrderExecutorV3(42161)).toBeNull()

    await renderSwapView()
    expectDcaTabIsTheTeaser()
  })

  it('positive control — the same three vars SET for Base (the eligible chain) ⇒ the DCA tab opens and <DCAPanel> mounts', async () => {
    // Without this case every assertion above could pass vacuously (e.g. if the DCA tab were never
    // enableable at all). The gate CAN open — on the chain the code allows.
    useChainIdMock.mockReturnValue(8453)
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_BASE_FEE_COLLECTOR', FEE_COLLECTOR_STUB)
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', V3_EXECUTOR_STUB)

    await renderSwapView()
    const tab = dcaTab()
    expect(tab).not.toBeDisabled()
    expect(within(tab).queryByText('Soon')).not.toBeInTheDocument()

    fireEvent.click(tab)
    // next/dynamic mounts asynchronously — same assertion shape as page.test.tsx.
    expect(await screen.findByTestId('dca-panel')).toBeInTheDocument()
  })
})
