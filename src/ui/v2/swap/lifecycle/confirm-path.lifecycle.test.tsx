// @vitest-environment jsdom
/**
 * [ADR-025 / B5] Hook-call equality, v1 vs v2. For each scenario the SAME mocked `useSwap` / `useSplitSwap` / `useApproval` /
 * `useSplitRoute` answer both trees: v1's SwapBox is driven the way a user drives it, the v2 card is driven the way a v2 user drives
 * it, and what each handed the hooks (arguments, order, count) must be equal. No wallet, no RPC, no transaction: the hooks are mocks.
 *
 * [A69 M-2] The hooks are mocks that RECORD what the tree handed them (`rec`: the constructor arguments of useSwap / useSplitSwap /
 * useApproval / useSplitRoute, per render) as well as what it later called on them (execute / approve / confirm…). Both go in the
 * v1-vs-v2 `toEqual`, so a dropped or altered argument — the `unpricedAck` option above all — fails every scenario that carries it.
 *
 * Evidence 2 of the goal: standard · approval-first · unpriced without ack (no call) · unpriced with ack (`{ unpricedAck: true }`) ·
 * CoW (`execute('cowswap', …)` then `confirmCowOrder`) · split (`execute(bestSplit[, ack])`, both legs) · 409 reopens the dialog.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'

const noop = () => {}
const h = vi.hoisted(() => {
  return {
    account: { address: undefined as string | undefined, isConnected: false, chain: undefined as { id: number } | undefined },
    balance: undefined as { value: bigint; decimals: number } | undefined,
    quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
    oracle: { chainlinkPrice: 2490, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as Record<string, unknown>,
    approval: {} as Record<string, unknown>,
    tier: { data: null as unknown, loading: false },
    swap: {} as Record<string, unknown>,
    split: {} as Record<string, unknown>,
    route: {} as Record<string, unknown>,
    depeg: { mode: 'ok', divergence: 0, symbol: '', message: null } as Record<string, unknown>,
    rec: { swap: [], split: [], approval: [], route: [] } as Record<'swap' | 'split' | 'approval' | 'route', unknown[][]>,
  }
})

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
vi.mock('@/hooks/useApproval', () => ({ useApproval: (...a: unknown[]) => (h.rec.approval.push(a), h.approval) }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => h.tier }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => h.depeg }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: (...a: unknown[]) => (h.rec.swap.push(a), h.swap) }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: (...a: unknown[]) => (h.rec.route.push(a), h.route) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: (...a: unknown[]) => (h.rec.split.push(a), h.split) }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('@/components/ActiveApprovals', () => ({ default: () => null }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: () => {} }))
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ toast: () => '', dismiss: () => {} }) }))
vi.mock('../../shell/toasts', () => ({ useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol}</button> }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: () => {} }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: () => {}, playTouchMP3: () => {}, playSwapConfirmMP3: () => {}, playCancelOrderMP3: () => {}, startWaitingSound: () => {}, stopWaitingSound: () => {} }))

import SwapBox from '@/components/SwapBox'
import { SwapCard } from '../SwapCard'

const addr = '0xd44d00000000000000000000000000000000962d'
const READY_APPROVAL = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, isReady: true, needsPermit2Education: false }

function swapHook(over: Record<string, unknown> = {}) {
  return {
    status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false,
    simulationPassed: null, simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null,
    execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
  }
}
function splitHook(over: Record<string, unknown> = {}) {
  return {
    status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false,
    execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn(), ...over,
  }
}
const calls = (f: unknown) => (f as ReturnType<typeof vi.fn>).mock.calls
const approve = () => h.approval.approve as ReturnType<typeof vi.fn>
const swapExecute = () => h.swap.execute as ReturnType<typeof vi.fn>
const splitExec = () => h.split.execute as ReturnType<typeof vi.fn>

const SPLIT = {
  bestSplit: {
    isSplit: true,
    legs: [
      { source: 'velora', percent: 60, outputAmount: '1492000000', inputAmount: '600000000000000000' },
      { source: 'kyberswap', percent: 40, outputAmount: '995000000', inputAmount: '400000000000000000' },
    ],
    totalOutput: '2487000000',
    improvementBps: 12,
    totalGasUsd: 0.05,
  },
  bestSingle: { source: 'velora', toAmount: '2484000000', gasUsd: 0.03 },
  splitRecommended: true,
}

beforeEach(() => {
  h.account = { address: addr, isConnected: true, chain: { id: 1 } }
  h.balance = { value: 3n * 10n ** 18n, decimals: 18 }
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.tier = { data: null, loading: false }
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.approval = { ...READY_APPROVAL, approve: vi.fn(async () => {}), confirmPermit2Education: noop, cancelPermit2Education: noop }
  h.swap = swapHook()
  h.split = splitHook()
  h.route = { splitResult: null, analyzing: false, useSplit: false, toggleSplit: noop }
  h.depeg = { mode: 'ok', divergence: 0, symbol: '', message: null }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const typeAmount = (c: HTMLElement) => fireEvent.change(c.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: '1' } })
const unpricedTier = { data: { tier: 'unpriced', legs: { in: { tier: 'unpriced', sources: [] }, out: { tier: 'unpriced', sources: [] } } }, loading: false }

/** The arguments each hook was last called with — the render the user is looking at. Every hook is called on every render, so empty means the mock dropped them. */
function hookArgs() {
  const last = Object.fromEntries(Object.entries(h.rec).map(([k, v]) => [k, v[v.length - 1]]))
  expect(Object.values(last).every((a) => Array.isArray(a) && a.length > 0)).toBe(true)
  return last
}
const clearRec = () => Object.values(h.rec).forEach((v) => (v.length = 0))

/** Drive v1 the way a user does, return what the hooks received; reset the spies for the v2 run. */
function v1Run(drive: () => void) {
  clearRec()
  const v1 = render(<SwapBox />)
  typeAmount(v1.container)
  drive()
  const out = { hooks: hookArgs(), execute: [...calls(h.swap.execute)], split: [...calls(h.split.execute)], approve: [...calls(h.approval.approve)], reset: calls(h.swap.reset).length, splitReset: calls(h.split.reset).length, confirmSwap: calls(h.swap.confirmSwap).length, confirmCow: calls(h.swap.confirmCowOrder).length, confirmPlan: calls(h.split.confirmPlan).length }
  cleanup()
  clearRec()
  for (const f of [h.swap.execute, h.split.execute, h.approval.approve, h.swap.reset, h.split.reset, h.swap.confirmSwap, h.swap.confirmCowOrder, h.split.confirmPlan]) (f as ReturnType<typeof vi.fn>).mockClear()
  return out
}
function v2Render() {
  const v2 = render(<SwapCard />)
  typeAmount(v2.container)
  return v2
}
const v2Out = () => ({ hooks: hookArgs(), execute: [...calls(h.swap.execute)], split: [...calls(h.split.execute)], approve: [...calls(h.approval.approve)], reset: calls(h.swap.reset).length, splitReset: calls(h.split.reset).length, confirmSwap: calls(h.swap.confirmSwap).length, confirmCow: calls(h.swap.confirmCowOrder).length, confirmPlan: calls(h.split.confirmPlan).length })

const v1Click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const openReview = () => fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
const confirmBtn = (name: string | RegExp = 'Confirm & Sign') => within(screen.getByRole('dialog')).getByRole('button', { name })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('standard route (1inch/0x/Velora/Kyber/…): the same execute(source, fallbacks) — and no third argument', () => {
  it('approval ready → v1 Swap = v2 Review swap → Confirm & Sign', async () => {
    const one = v1Run(() => v1Click('Swap'))
    expect(one.execute).toHaveLength(1)
    expect(one.execute[0]).toHaveLength(2) // (source, fallbacks) — v1 passes no options object when there is no consent
    v2Render()
    openReview()
    expect(swapExecute()).not.toHaveBeenCalled() // opening the review executes nothing
    fireEvent.click(confirmBtn())
    await flush()
    expect(v2Out()).toEqual(one)
    expect(one.execute[0][0]).toBe('velora')
  })

  it('approval needed → v1 "Approve & Swap" = v2 Confirm "Approve & Swap": approve() once, execute not called, in that order', async () => {
    h.approval = { ...h.approval, isReady: false, status: 'idle' }
    const one = v1Run(() => v1Click('Approve & Swap'))
    expect(one.approve).toHaveLength(1)
    expect(one.execute).toHaveLength(0)
    v2Render()
    openReview()
    fireEvent.click(confirmBtn('Approve & Swap'))
    await flush()
    expect(v2Out()).toEqual(one)
  })

  it('the approval states surface as v1 words: Approving... / Signing... / Approval error — retry; then the swap states', () => {
    // The review is open before the approval starts (the user pressed Confirm in it), so open it first and then let the hooks move.
    for (const [status, label] of [['approving_permit2', 'Approving...'], ['signing', 'Signing...'], ['error', 'Approval error — retry']] as const) {
      h.approval = { ...h.approval, isReady: false, status: 'idle' }
      const v2 = v2Render()
      openReview()
      h.approval = { ...h.approval, isReady: false, status }
      v2.rerender(<SwapCard />)
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: label })).toBeTruthy()
      cleanup()
    }
    h.approval = { ...READY_APPROVAL, approve: vi.fn() }
    for (const [status, label] of [['fetching_swap', 'Preparing swap...'], ['simulating', 'Simulating transaction...']] as const) {
      h.swap = swapHook()
      const v2 = v2Render()
      openReview()
      h.swap = swapHook({ status })
      v2.rerender(<SwapCard />)
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: label }).getAttribute('aria-disabled')).toBe('true') // held, but it keeps focus
      cleanup()
    }
  })

  it('frozen review (status confirming): Confirm calls confirmSwap, exactly as v1\'s TransactionPreview', async () => {
    const pendingSwap = { source: 'velora', txTo: addr, txData: '0x12345678', txValue: 0n, txGas: undefined, routerAddress: '0x6a000f20005980200259b80c5102003040001068', routerCalldata: '0x12345678', routeViaFeeCollector: true, routeType: 'fee_collector_eth', swapToAmount: '2487684200', rawAmountBn: 10n ** 18n, tokenIn: { symbol: 'ETH', decimals: 18, address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', name: 'Ether' }, tokenOut: { symbol: 'USDC', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USD Coin' }, minimumOutput: 2480221100n, swapStartTime: 0 }
    h.swap = swapHook({ status: 'confirming', pendingSwap })
    const one = v1Run(() => v1Click(/Confirm/))
    expect(one.confirmSwap).toBe(1)
    h.swap = swapHook()
    const v2 = v2Render()
    openReview()
    h.swap = swapHook({ status: 'confirming', pendingSwap })
    v2.rerender(<SwapCard />) // Confirm was pressed → the hook froze the transaction → the SAME sheet now carries the calldata
    expect(screen.getByTestId('review-decoded')).toBeTruthy() // the frozen half: recipient / validation / selector rows
    fireEvent.click(confirmBtn())
    await flush()
    // (v1's `reset: 1` here is only this harness typing the amount while the hook already says `confirming` — handleAmountChange resets then.)
    expect(v2Out()).toEqual({ ...one, reset: 0 })
  })
})

describe('unpriced pair (#608 / #613): consent gates execute; the ack rides execute as { unpricedAck: true }', () => {
  it('without the ack → no hook call at all (v1: Swap opens the dialog; v2: Confirm is disabled until ticked)', async () => {
    h.tier = unpricedTier
    const one = v1Run(() => v1Click('Swap'))
    expect(one.execute).toHaveLength(0)
    expect(one.split).toHaveLength(0)
    v2Render()
    openReview()
    expect((confirmBtn() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirmBtn())
    await flush()
    expect(v2Out()).toEqual(one)
  })

  it('with the ack → execute(source, fallbacks, { unpricedAck: true }) — v1 dialog Continue = v2 tick + Confirm', async () => {
    h.tier = unpricedTier
    const one = v1Run(() => {
      v1Click('Swap')
      fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
      fireEvent.click(screen.getByTestId('unpriced-consent-confirm'))
    })
    expect(one.execute).toHaveLength(1)
    expect(one.execute[0][2]).toEqual({ unpricedAck: true })
    v2Render()
    openReview()
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    fireEvent.click(confirmBtn())
    await flush()
    expect(v2Out()).toEqual(one)
  })

  it('the tick never leaks into a priced pair: no options argument there', async () => {
    h.tier = { data: { tier: 'priced', legs: { in: { tier: 'priced', sources: ['chainlink'], usd: 2490 }, out: { tier: 'priced', sources: ['chainlink'], usd: 1 } } }, loading: false }
    v2Render()
    openReview()
    fireEvent.click(confirmBtn())
    await flush()
    expect(calls(h.swap.execute)[0]).toHaveLength(2)
  })
})

describe('CoW route: execute("cowswap", …) then the frozen order is signed by confirmCowOrder', () => {
  const cowMeta = () => {
    const m = fixtureMeta()
    const cow = { ...m.all[0], source: 'cowswap' as const, gasUsd: 0 }
    return { ...m, best: cow, all: [cow, ...m.all.slice(1)] }
  }
  it('standard CoW: the same execute call; the review is the CoW order sheet; Confirm = confirmCowOrder', async () => {
    h.quote = { ...h.quote, meta: taggedFixture(cowMeta(), '1') }
    const one = v1Run(() => v1Click('Swap'))
    expect(one.execute[0][0]).toBe('cowswap')
    v2Render()
    openReview()
    fireEvent.click(confirmBtn())
    await flush()
    expect(v2Out()).toEqual(one)
    // the hook then freezes the order and moves to cow_awaiting_review
    cleanup()
    const order = { domain: {}, types: {}, message: { sellToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', buyToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', receiver: addr, sellAmount: 10n ** 18n, buyAmount: 2480000000n, validTo: Math.floor(Date.now() / 1000) + 1800, appData: '0x' + '11'.repeat(32), feeAmount: 0n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' }, orderParams: {}, tokenIn: { symbol: 'ETH', decimals: 18 }, tokenOut: { symbol: 'USDC', decimals: 6 }, rawAmount: '1', settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', chainId: 1, account: addr, startTime: 0 }
    h.swap = swapHook({ status: 'cow_awaiting_review', pendingCowOrder: order })
    v2Render()
    fireEvent.click(screen.getByTestId('cow-confirm'))
    await flush()
    expect(calls(h.swap.confirmCowOrder)).toHaveLength(1)
  })

  it('CoW + unpriced ack: execute("cowswap", fallbacks, { unpricedAck: true }) — the same consent as the standard path (M-1)', async () => {
    h.tier = unpricedTier
    h.quote = { ...h.quote, meta: taggedFixture(cowMeta(), '1') }
    const one = v1Run(() => {
      v1Click('Swap')
      fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
      fireEvent.click(screen.getByTestId('unpriced-consent-confirm'))
    })
    expect(one.execute[0][0]).toBe('cowswap')
    expect(one.execute[0][2]).toEqual({ unpricedAck: true })
    v2Render()
    openReview()
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    fireEvent.click(confirmBtn())
    await flush()
    expect(v2Out()).toEqual(one)
  })
})

describe('split route: execute(bestSplit[, { unpricedAck: true }]) — both legs, one call (the hook walks the legs)', () => {
  beforeEach(() => {
    h.route = { splitResult: SPLIT, analyzing: false, useSplit: true, toggleSplit: vi.fn() }
  })
  it('split ON, priced: v1 Swap = v2 CTA "Swap" → splitExecute(bestSplit); the single hook is untouched', async () => {
    const one = v1Run(() => v1Click('Swap'))
    expect(one.split).toHaveLength(1)
    expect(one.split[0]).toHaveLength(1)
    expect((one.split[0][0] as typeof SPLIT.bestSplit).legs).toHaveLength(2)
    expect(one.execute).toHaveLength(0)
    v2Render()
    expect(screen.getByRole('button', { name: 'Swap' })).toBeTruthy() // no single-route review for a split: v1's own label
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
    await flush()
    expect(v2Out()).toEqual(one)
  })

  it('split ON, unpriced: consent first (v1 dialog / v2 consent sheet), then execute(bestSplit, { unpricedAck: true })', async () => {
    h.tier = unpricedTier
    const one = v1Run(() => {
      v1Click('Swap')
      fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
      fireEvent.click(screen.getByTestId('unpriced-consent-confirm'))
    })
    expect(one.split[0][1]).toEqual({ unpricedAck: true })
    v2Render()
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
    await flush()
    expect(calls(h.split.execute)).toHaveLength(0) // consent not given yet → nothing executed
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }))
    await flush()
    expect(v2Out()).toEqual(one)
  })

  it('the plan awaits review (status awaiting-review) → the split sheet; Confirm = confirmPlan, as v1\'s SplitReviewModal', async () => {
    const plannedLegs = SPLIT.bestSplit.legs.map((l) => ({ source: l.source, percent: l.percent, legAmount: BigInt(l.inputAmount), routeViaFeeCollector: true, isNativeIn: true, routerAddress: '0x6a000f20005980200259b80c5102003040001068', routerCalldata: '0x12345678', txTo: addr, txData: '0x12', txValue: 0n, legMinOutput: 1n, expectedOut: l.outputAmount, outputAmount: l.outputAmount, simulated: true, status: 'reviewed' }))
    h.split = splitHook({ status: 'awaiting-review', plannedLegs })
    const one = v1Run(() => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Confirm/ })))
    expect(one.confirmPlan).toBe(1)
    h.split = splitHook({ status: 'awaiting-review', plannedLegs })
    v2Render()
    fireEvent.click(screen.getByTestId('split-confirm'))
    await flush()
    expect(v2Out().confirmPlan).toBe(1)
  })
})

describe('409 unpriced_ack_required: the consent comes back, unticked, even after a Cancel — and Cancel resets the hook that raised it', () => {
  it('single: swap.unpricedAckRequired reopens the review (v1: the dialog); Continue re-runs execute with the ack; Cancel → reset()', async () => {
    h.swap = swapHook({ unpricedAckRequired: true })
    const one = v1Run(() => {
      expect(screen.getByTestId('unpriced-consent-dialog')).toBeTruthy()
      fireEvent.click(screen.getByTestId('unpriced-consent-cancel'))
    })
    expect(one.reset).toBe(1)
    h.swap = swapHook({ unpricedAckRequired: true })
    const two = v1Run(() => {
      fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
      fireEvent.click(screen.getByTestId('unpriced-consent-confirm'))
    })
    expect(two.execute[0][2]).toEqual({ unpricedAck: true })

    h.swap = swapHook({ unpricedAckRequired: true })
    v2Render() // no CTA click: the server asked
    const dlg = screen.getByRole('dialog')
    expect((screen.getByTestId('unpriced-consent-checkbox') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    expect(calls(h.swap.reset)).toHaveLength(one.reset)
    cleanup()
    h.swap = swapHook({ unpricedAckRequired: true })
    v2Render()
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    fireEvent.click(confirmBtn())
    await flush()
    expect(v2Out().execute).toEqual(two.execute)
    expect(v2Out()).toEqual(two) // [A69 M-2] …and every hook argument and call, not only execute's
  })

  it('split: split.unpricedAckRequired reopens the consent; Continue → execute(bestSplit, { unpricedAck: true }); Cancel → the split hook\'s reset()', async () => {
    h.route = { splitResult: SPLIT, analyzing: false, useSplit: true, toggleSplit: noop }
    h.split = splitHook({ unpricedAckRequired: true })
    const one = v1Run(() => fireEvent.click(screen.getByTestId('unpriced-consent-cancel')))
    expect(one.splitReset).toBe(1)
    h.split = splitHook({ unpricedAckRequired: true })
    v2Render()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(calls(h.split.reset)).toHaveLength(1)
    cleanup()
    h.split = splitHook({ unpricedAckRequired: true })
    const two = v1Run(() => {
      fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
      fireEvent.click(screen.getByTestId('unpriced-consent-confirm'))
    })
    expect(two.split[0][1]).toEqual({ unpricedAck: true })
    h.split = splitHook({ unpricedAckRequired: true })
    v2Render()
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continue' }))
    await flush()
    expect(v2Out()).toEqual(two) // [A69 M-2] the retry after a split 409: v1's calls and hook arguments, equal
    expect(calls(h.split.execute)[0][1]).toEqual({ unpricedAck: true })
    expect(approve()).not.toHaveBeenCalled()
    expect(splitExec()).toHaveBeenCalledTimes(1)
    expect(swapExecute()).not.toHaveBeenCalled()
  })
})
