// @vitest-environment jsdom
/**
 * [ADR-025 / B5] Sound + toast parity table (evidence 4 + "same events v1 toasts"). The REAL v1 SwapBox and the REAL v2 card run on
 * the same mocked hooks; each row moves the hooks through the same status transition in both trees and records every
 * `@/lib/sounds` call and every toast. v2 must equal v1 — except the three rows marked DEVIATION, which pin the places v2 stops
 * a loop v1 leaves running (documented in the feedback file) and the one place a v1 toast is replaced.
 *
 * | moment                          | v1 sounds                                | v1 toast                               |
 * | Swap / Approve pressed          | playTouchMP3 (button) · startWaitingSound| —                                      |
 * | standard tx broadcast           | —                                        | loading "Transaction pending..."       |
 * | CoW sign / order submitted      | —                                        | loading "Signing CoW order..." / "CoW order submitted — …" |
 * | success                         | stopWaitingSound · playSwapConfirmMP3    | success "Swap confirmed!" (+ txHash)   |
 * | failure / wallet rejection      | stopWaitingSound · playCancelOrderMP3    | error "Swap failed"                    |
 * | split success / partial / error | stop · confirm / cancel / cancel         | "Split swap complete!" / "…partially complete" / "…failed" |
 * | approval error                  | (none — DEVIATION: v2 stops the loop)    | error "Approval failed"                |
 * | review cancelled                | (none — DEVIATION: v2 stops the loop)    | —                                      |
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'

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

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: { value: 3n * 10n ** 18n, decimals: 18 } }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: () => {} }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: () => {} }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => ({ ...NO_ORACLE, chainlinkPrice: 2490 }) }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }) }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => h.split }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('@/components/ActiveApprovals', () => ({ default: () => null }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: () => {} }))
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol}</button> }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: () => {} }))
// v1's toast provider and v2's both record into the same `h.toasts`; the tree under test decides which one is called.
vi.mock('@/components/ToastProvider', () => ({
  useToast: () => ({
    toast: (t: Record<string, unknown>) => {
      h.toasts.push({ ...t })
      return `t${h.toasts.length}`
    },
    dismiss: (id: string) => void h.dismissed.push(id),
  }),
}))
vi.mock('../../shell/toasts', () => ({
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
  return { playQuoteReceived: () => {}, playTouchMP3: rec('touch'), playSwapConfirmMP3: rec('confirm'), playCancelOrderMP3: rec('cancel'), startWaitingSound: rec('wait+'), stopWaitingSound: rec('wait-') }
})

import SwapBox from '@/components/SwapBox'
import { SwapCard } from '../SwapCard'

const READY = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, isReady: true, needsPermit2Education: false, approve: async () => {}, confirmPermit2Education: noop, cancelPermit2Education: noop }
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const splitHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn(), ...over,
})
const noChain = (t: Record<string, unknown>) => {
  const { chain: _chain, ...rest } = t
  return rest
}
const TX = '0x8c1f000000000000000000000000000000000000000000000000000000c44b0'

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
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type Tree = 'v1' | 'v2'
const typeAmount = (c: HTMLElement) => fireEvent.change(c.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: '1' } })

/** Mount a tree on idle hooks, then step the hooks through `steps` (each a partial hook state), rerendering after each. */
function play(tree: Tree, steps: { swap?: Record<string, unknown>; split?: Record<string, unknown>; approval?: Record<string, unknown> }[]) {
  // Every tree starts from idle hooks (the previous run left them on its last step).
  h.swap = swapHook()
  h.split = splitHook()
  h.approval = { ...READY }
  // A NEW element per render: React skips a subtree whose element is the same object, and the hooks are module mocks.
  const ui = () => (tree === 'v1' ? <SwapBox /> : <SwapCard />)
  const r = render(ui())
  typeAmount(r.container)
  h.log = []
  h.toasts = []
  for (const s of steps) {
    if (s.swap) h.swap = swapHook(s.swap)
    if (s.split) h.split = splitHook(s.split)
    if (s.approval) h.approval = { ...READY, ...s.approval }
    r.rerender(ui())
  }
  const out: { sounds: string[]; toasts: Record<string, unknown>[] } = { sounds: [...h.log], toasts: h.toasts.map(({ chainId, ...t }) => ({ ...t, ...(chainId === undefined ? {} : { chain: chainId }) })) }
  cleanup()
  return out
}

describe('same transitions → same sounds and same toasts', () => {
  const rows: [string, Parameters<typeof play>[1]][] = [
    ['standard tx broadcast (swapping)', [{ swap: { status: 'swapping' } }]],
    ['CoW: signing then order submitted', [{ swap: { status: 'cow_signing' } }, { swap: { status: 'cow_pending' } }]],
    ['success (txHash set)', [{ swap: { status: 'swapping' } }, { swap: { status: 'success', txHash: TX } }]],
    ['failure: wallet rejection after the broadcast step', [{ swap: { status: 'swapping' } }, { swap: { status: 'error', errorMessage: 'Transaction rejected in wallet.' } }]],
    ['failure with no message → v1 fallback copy', [{ swap: { status: 'error' } }]],
    ['split: all legs done', [{ split: { status: 'success', totalLegs: 2, completedLegs: 2 } }]],
    ['split: partial', [{ split: { status: 'partial', totalLegs: 2, completedLegs: 1, errorMessage: '1/2 legs completed. 1 failed.' } }]],
    ['split: error', [{ split: { status: 'error', totalLegs: 2, errorMessage: 'Split swap failed.' } }]],
  ]
  it.each(rows)('%s', (_n, steps) => {
    const one = play('v1', steps)
    const two = play('v2', steps)
    // v1 builds the success description from the quote at settle time; v2 from the quote frozen at Confirm — equal here (no re-quote).
    expect(two.sounds).toEqual(one.sounds)
    expect(two.toasts.map(noChain)).toEqual(one.toasts)
  })

  it('the toasts are what the sound rows promise (the table, as data)', () => {
    const ok = play('v2', [{ swap: { status: 'swapping' } }, { swap: { status: 'success', txHash: TX } }])
    expect(ok.sounds).toEqual(['wait-', 'confirm'])
    expect(ok.toasts[0]).toMatchObject({ type: 'loading', title: 'Transaction pending...', description: 'ETH → USDC' })
    expect(ok.toasts[1]).toMatchObject({ type: 'success', title: 'Swap confirmed!', txHash: TX, duration: 10000, chain: 1 }) // chain-aware explorer link
    const bad = play('v2', [{ swap: { status: 'swapping' } }, { swap: { status: 'error', errorMessage: 'Transaction rejected in wallet.' } }])
    expect(bad.sounds).toEqual(['wait-', 'cancel'])
    expect(bad.toasts[1]).toMatchObject({ type: 'error', title: 'Swap failed', description: 'Transaction rejected in wallet.' })
  })

  it('a CoW fill with realised surplus carries v1\'s "you saved" line, and only then', () => {
    const cow = fixtureMeta()
    const best = { ...cow.all[0], source: 'cowswap' as const, gasUsd: 0 }
    h.quote = { ...h.quote, meta: taggedFixture({ ...cow, best, all: [best, ...cow.all.slice(1)] }, '1') }
    const surplus = [{ swap: { status: 'cow_pending' } }, { swap: { status: 'success', txHash: TX, mevSurplusActualWei: 5_000_000n } }]
    const one = play('v1', surplus)
    const two = play('v2', surplus)
    expect(two.toasts.map(noChain)).toEqual(one.toasts)
    expect(String(two.toasts.at(-1)!.description)).toContain('You saved ~')
    const none = play('v2', [{ swap: { status: 'cow_pending' } }, { swap: { status: 'success', txHash: TX, mevSurplusActualWei: null } }])
    expect(String(none.toasts.at(-1)!.description)).not.toContain('You saved')
  })
})

describe('the press → waiting loop (the one place the click path differs by design: two clicks in v2, one in v1)', () => {
  it('Swap/Approve pressed: v1 = touch + start; v2 = touch (Review swap) then touch + start (Confirm) — the loop starts exactly once', () => {
    const v1 = render(<SwapBox />)
    typeAmount(v1.container)
    h.log = []
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
    expect(h.log).toEqual(['touch', 'wait+'])
    cleanup()

    render(<SwapCard />)
    typeAmount(document.body)
    h.log = []
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
    expect(h.log).toEqual(['touch'])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm & Sign' }))
    expect(h.log).toEqual(['touch', 'touch', 'wait+'])
    expect(h.log.filter((e) => e === 'wait+')).toHaveLength(1)
  })

  it('"Approve & Swap": the loop starts on the approval press too, in both', () => {
    h.approval = { ...READY, isReady: false, status: 'idle', approve: vi.fn(async () => {}) }
    const v1 = render(<SwapBox />)
    typeAmount(v1.container)
    h.log = []
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Swap' }))
    expect(h.log).toEqual(['touch', 'wait+'])
    cleanup()
    render(<SwapCard />)
    typeAmount(document.body)
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
    h.log = []
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve & Swap' }))
    expect(h.log).toEqual(['touch', 'wait+'])
  })
})

describe('DEVIATIONS — v2 stops a loop that v1 leaves running (feedback finding)', () => {
  it('approval error: v1 toasts and plays nothing; v2 toasts the same and stops the loop', () => {
    const steps = [{ approval: { isReady: false, status: 'error', error: 'User rejected the request.' } }]
    const one = play('v1', steps)
    const two = play('v2', steps)
    expect(one.sounds).toEqual([])
    expect(two.sounds).toEqual(['wait-'])
    expect(two.toasts).toEqual(one.toasts)
    expect(two.toasts[0]).toMatchObject({ type: 'error', title: 'Approval failed', description: 'User rejected the request.' })
  })

  it('review cancelled: v1 calls only reset(); v2 calls reset() and stops the loop', () => {
    const v1 = render(<SwapBox />)
    typeAmount(v1.container)
    cleanup()
    const pending = { source: 'velora', txTo: '0x1', txData: '0x12345678', txValue: 0n, routerAddress: '0x6a000f20005980200259b80c5102003040001068', routerCalldata: '0x12345678', routeViaFeeCollector: true, routeType: 'fee_collector_eth', swapToAmount: '2487684200', rawAmountBn: 10n ** 18n, tokenIn: { symbol: 'ETH', decimals: 18, address: '0x', name: 'Ether' }, tokenOut: { symbol: 'USDC', decimals: 6, address: '0x', name: 'USDC' }, minimumOutput: 1n, swapStartTime: 0 }
    h.swap = swapHook({ status: 'confirming', pendingSwap: pending })
    const r2 = render(<SwapBox />)
    typeAmount(r2.container)
    h.log = []
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Cancel/ }))
    expect(h.log).toEqual([])
    cleanup()

    h.swap = swapHook()
    const r3 = render(<SwapCard />)
    typeAmount(r3.container)
    fireEvent.click(screen.getByRole('button', { name: 'Review swap' }))
    h.swap = swapHook({ status: 'confirming', pendingSwap: pending })
    r3.rerender(<SwapCard />)
    h.log = []
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(h.log).toEqual(['wait-'])
    expect((h.swap.reset as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
  })
})

describe('quote errors: one toast per distinct message (v1\'s dedup), and the spender allow-list toast', () => {
  it('the poll re-raising the same string toasts once; a new string toasts again; v2 = v1', () => {
    const run = (tree: Tree) => {
      const ui = () => (tree === 'v1' ? <SwapBox /> : <SwapCard />)
      h.quote = { ...h.quote, error: null }
      const r = render(ui())
      typeAmount(r.container)
      h.toasts = []
      for (const error of ['Rate limit exceeded', 'Rate limit exceeded', null, 'Rate limit exceeded', 'No route returned a quote for this pair.']) {
        h.quote = { ...h.quote, error }
        r.rerender(ui())
      }
      const t = [...h.toasts]
      cleanup()
      return t
    }
    const one = run('v1')
    const two = run('v2')
    expect(two).toEqual(one)
    expect(two).toHaveLength(3)
    expect(two[0]).toMatchObject({ type: 'warning', title: 'Quote unavailable', duration: 6000, dedupKey: 'quote-error' })
  })
})
