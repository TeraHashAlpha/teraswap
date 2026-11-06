// @vitest-environment jsdom
/**
 * [feat/retire-force-mev, owner decision 2026-11-06] CoW's free quote API has answered 429 to our servers since 2026-10-29
 * (paid tier required) and the owner will not pay, so: the "Force MEV Protection" toggle, its "No MEV-protected quote…" notice,
 * the "CoW Protocol available… Enable" strip and the gasless card's "Use Gasless Route" CTA (which switched the same hidden
 * CoW-only filter on) are gone from v1 AND v2 — and CoW stays an ORDINARY source: counted, listed, compared, ranked, and routed
 * through its own review when it wins.
 *
 * v1 SwapBox and v2 SwapCard are rendered against the same mocked hook answers (the content-parity fixture). The v2 CoW review
 * from a click is pinned end to end in lifecycle/confirm-path.lifecycle.test.tsx ("standard CoW"); here both UIs mount their CoW
 * review for the frozen order.
 */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISABLED_SOURCES } from '@/lib/constants'
import { INTEGRATED_DEX_SOURCE_NAMES } from '@/config/product-claims'
import { NO_ORACLE, fixtureMeta, taggedFixture } from './test-fixtures'

const noop = () => {}
const addr = '0xd44d00000000000000000000000000000000962d'
const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chain: undefined as { id: number } | undefined },
  balance: undefined as { value: bigint; decimals: number } | undefined,
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  oracle: { chainlinkPrice: 2490, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as Record<string, unknown>,
  approval: { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 } as unknown, status: 'ready', error: null, approve: () => {}, isReady: true, needsPermit2Education: false, confirmPermit2Education: () => {}, cancelPermit2Education: () => {} },
  tier: { data: null as unknown, loading: false },
  swap: { status: 'idle', pendingCowOrder: null as unknown },
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: h.balance }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: () => {} }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: () => {} }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => h.oracle }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => h.tier }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: '' }) }))
vi.mock('@/hooks/useSwap', () => ({
  useSwap: () => ({ status: h.swap.status, txHash: undefined, errorMessage: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null, simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: h.swap.pendingCowOrder, mevSurplusActualWei: null, execute: () => {}, confirmSwap: () => {}, confirmCowOrder: () => {}, reset: () => {} }),
}))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({
  useSplitSwap: () => ({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: () => {}, confirmPlan: () => {}, reset: () => {} }),
}))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('@/components/ActiveApprovals', () => ({ default: () => null }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: () => {} }))
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ toast: () => '', dismiss: () => {} }) }))
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol}</button> }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: () => {} }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: () => {}, playTouchMP3: () => {}, playSwapConfirmMP3: () => {}, playCancelOrderMP3: () => {}, startWaitingSound: () => {}, stopWaitingSound: () => {} }))
vi.mock('../shell/toasts', () => ({ useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))

import SwapBox from '@/components/SwapBox'
import { SwapCard } from './SwapCard'

/** The retired copy (owner decision 2026-11-06). None of it may render in either UI. */
const RETIRED = [
  'Force MEV Protection',
  'Always route through CoW Protocol regardless of price.',
  'No MEV-protected quote available.',
  'CoW Protocol available for MEV protection.',
  'Use Gasless Route',
  'or keep current',
]

const type = (container: HTMLElement, value: string) =>
  fireEvent.change(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value } })

function renderBoth(amount = '1') {
  const v1 = render(<SwapBox />)
  type(v1.container, amount)
  const v2 = render(<SwapCard />)
  type(v2.container, amount)
  return { v1: v1.container, v2: v2.container }
}

/** A non-CoW best with CoW 1.1 % behind (> the 15 bps smart-promotion threshold) and the gasless engine recommending CoW:
 *  the exact state that used to show the Enable strip (mevExposedBest) and the "Use Gasless Route" CTA. */
function cowRunnerUpMeta() {
  const m = fixtureMeta()
  const cow = { ...m.all[1], source: 'cowswap' as const, toAmount: '2460000000', estimatedGas: 0, gasUsd: 0, routes: ['CoW Protocol'] }
  m.all = [m.all[0], cow, ...m.all.slice(2)]
  m.gasless = { available: true, recommended: true, reason: 'x', gasSavingsUsd: 2.5 } as never
  return m
}

function cowBestMeta() {
  const m = fixtureMeta()
  const cow = { ...m.all[0], source: 'cowswap' as const, estimatedGas: 0, gasUsd: 0, routes: ['CoW Protocol'] }
  m.all = [cow, ...m.all.slice(1)]
  m.best = cow
  return m
}

beforeEach(() => {
  h.account = { address: addr, isConnected: true, chain: { id: 1 } }
  h.balance = { value: 3_000_000_000_000_000_000n, decimals: 18 }
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.tier = { data: null, loading: false }
  h.swap = { status: 'idle', pendingCowOrder: null }
  h.quote = { meta: taggedFixture(cowRunnerUpMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('retired in BOTH UIs: the toggle, its notice, the Enable strip and the gasless CTA', () => {
  it('none renders under the state that used to show all of them; the gasless card stays, as information only', () => {
    const { v1, v2 } = renderBoth()
    for (const [ui, c] of [['v1', v1], ['v2', v2]] as const) {
      const text = c.textContent ?? ''
      for (const s of RETIRED) expect(text, `${ui}: "${s}"`).not.toContain(s)
      expect(c.querySelector('[role="switch"]'), `${ui}: a switch`).toBeNull()
      expect(c.querySelector('[aria-label="Toggle force MEV protection"]'), `${ui}: v1 toggle button`).toBeNull()
      expect(within(c).queryByRole('button', { name: 'Enable' }), `${ui}: Enable`).toBeNull()
      expect(within(c).queryByRole('button', { name: 'Dismiss MEV protection hint' }), `${ui}: dismiss ×`).toBeNull()
      expect(within(c).queryByRole('button', { name: /Switch to the gasless CoW Protocol route/ }), `${ui}: gasless CTA`).toBeNull()
      expect(text, `${ui}: gasless card`).toContain('Zero Gas Available')
      expect(text, `${ui}: best stays the top output — no forced filter`).toContain('Best via Velora')
    }
  })

  it('the hint dismissal key is neither read nor written any more', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    renderBoth()
    expect(get.mock.calls.map((c) => c[0])).not.toContain('teraswap:mev-hint-dismissed')
    expect(set.mock.calls.map((c) => c[0])).not.toContain('teraswap:mev-hint-dismissed')
    get.mockRestore()
    set.mockRestore()
  })
})

describe('CoW stays an ordinary source', () => {
  it('counted and listed: in the integrated set (sources count, source list) and not disabled', () => {
    expect(INTEGRATED_DEX_SOURCE_NAMES).toContain('cowswap')
    expect(DISABLED_SOURCES).not.toHaveProperty('cowswap')
  })

  it('compared: a CoW runner-up appears in Compare in both UIs', () => {
    const { v1, v2 } = renderBoth()
    fireEvent.click(within(v2).getByRole('button', { name: /Compare/ }))
    expect(v1.textContent).toContain('CoW Protocol')
    expect(v2.textContent).toContain('CoW Protocol')
  })

  it('ranked: a CoW best is "Best via CoW Protocol" in both UIs', () => {
    h.quote = { meta: taggedFixture(cowBestMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
    const { v1, v2 } = renderBoth()
    expect(v1.textContent).toContain('Best via CoW Protocol')
    expect(v2.textContent).toContain('Best via CoW Protocol')
  })

  it('reviewed: a frozen CoW order mounts the CoW review in v1 (modal) and v2 (sheet)', () => {
    h.quote = { meta: taggedFixture(cowBestMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
    h.swap = {
      status: 'cow_awaiting_review',
      pendingCowOrder: { domain: {}, types: {}, message: { sellToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', buyToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', receiver: addr, sellAmount: 10n ** 18n, buyAmount: 2480000000n, validTo: Math.floor(Date.now() / 1000) + 1800, appData: '0x' + '11'.repeat(32), feeAmount: 0n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' }, orderParams: {}, tokenIn: { symbol: 'ETH', decimals: 18 }, tokenOut: { symbol: 'USDC', decimals: 6 }, rawAmount: '1', settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', chainId: 1, account: addr, startTime: 0 },
    }
    const v1 = render(<SwapBox />)
    expect(within(v1.container).getByTestId('cow-review-body')).toBeTruthy()
    cleanup()
    render(<SwapCard />)
    expect(document.querySelector('[data-testid="cow-confirm"]')).not.toBeNull()
  })
})
