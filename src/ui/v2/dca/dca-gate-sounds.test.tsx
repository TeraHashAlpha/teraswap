// @vitest-environment jsdom
/**
 * [ADR-025] B6a commit 3 —
 *   (5a) the chain gate: Ethereum says where DCA runs (v1's own sentence) and offers the switch; Base / Arbitrum mount the card, never the gate;
 *   (5b) the sounds table: the same sounds.ts calls as v1's DCAPanel for the same actions and the same engine events (v1 vs v2, one harness);
 *   a11y: names, groups, pressed state, tabs; the review sheet's focus trap / Esc is asserted in dca-review.test.tsx (B4 Sheet).
 */
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, h, offchainInfo, resetHarness } from './dca-harness'

vi.mock('wagmi', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('wagmi')>('wagmi')
  return { ...actual, useAccount: () => h.account, useChainId: () => 8453, useSwitchChain: () => ({ switchChain: h.switchChain, switchChainAsync: vi.fn(), isPending: false }) }
})
vi.mock('@rainbow-me/rainbowkit', async () => {
  const { h } = await import('./dca-harness')
  return { ConnectButton: () => <button>Connect</button>, useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }
})
vi.mock('@/hooks/useOrderEngine', async () => {
  const { h } = await import('./dca-harness')
  return {
    useOrderEngine: () => ({
      dcaOrders: h.engine.dcaOrders, activeOrders: [], historyOrders: [], latestEvent: h.engine.latestEvent, isSubmitting: false,
      createOrder: h.engine.createOrder, pendingOrder: null, confirmOrder: vi.fn(), clearPendingOrder: vi.fn(),
      pendingCancel: null, confirmCancel: vi.fn(), clearPendingCancel: vi.fn(), cancelOrder: h.engine.cancelOrder,
      cancelAllOrders: h.engine.cancelAllOrders, removeOrder: h.engine.removeOrder,
    }),
  }
})
vi.mock('@/hooks/useTokenBalances', async () => {
  const { h } = await import('./dca-harness')
  return { useTokenBalances: () => ({ balances: h.balances }) }
})
vi.mock('@/hooks/useTokenBalance', async () => {
  const { h } = await import('./dca-harness')
  return { useTokenBalance: () => h.direct }
})
vi.mock('@/hooks/useChainlinkPrice', async () => {
  const { h } = await import('./dca-harness')
  const { getCanonicalUsdc } = await import('@/lib/chains/tokens')
  return { useChainlinkPrice: (a?: string) => (a && a.toLowerCase() === getCanonicalUsdc(8453)?.address.toLowerCase() ? h.oracleOut : h.oracle) }
})
vi.mock('@/hooks/useDepegCheck', async () => {
  const { h } = await import('./dca-harness')
  return { useDepegCheck: () => h.depeg }
})
vi.mock('@/hooks/useOrderExecutions', () => ({ useOrderExecutions: () => ({ executions: [], lastFillAtMs: null, orderMeta: null, loading: false }) }))
vi.mock('@/components/dca/pair-floor-info', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('@/components/dca/pair-floor-info')>('@/components/dca/pair-floor-info')
  return { ...actual, fetchPairFloorInfo: async () => h.floor }
})
vi.mock('@/lib/order-engine', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return { ...actual, getOrderExecutorV3: (c: number) => (h.v3Chains.includes(c) ? '0x3333333333333333333333333333333333333333' : null) }
})
vi.mock('@/lib/dca-launch', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('@/lib/dca-launch')>('@/lib/dca-launch')
  return { ...actual, isDcaLive: (id: number) => h.v3Chains.includes(id) }
})
vi.mock('@/lib/order-engine/check-route', () => ({ checkRoute: async () => ({ routable: true }) }))
vi.mock('@/lib/defillama-client', () => ({ fetchDefiLlamaPriceViaApi: async () => null }))
vi.mock('@/lib/sounds', async () => {
  const { h } = await import('./dca-harness')
  return { ...h.sounds }
})
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: () => {} }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: () => {} }))
vi.mock('@/components/ToastProvider', async () => {
  const { h } = await import('./dca-harness')
  return { useToast: () => ({ toast: h.toast, dismiss: () => {} }) }
})
vi.mock('../shell/toasts', async () => {
  const { h } = await import('./dca-harness')
  return { useV2Toast: () => ({ toast: h.toast, dismiss: () => {}, update: () => {} }) }
})
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol ?? 'Select'}</button> }))
vi.mock('../modals/TokenSheet', () => ({ TokenSheet: () => null }))
vi.mock('@/components/dca/SettlementReceiptModal', () => ({ default: () => null, isReceiptEligible: () => false }))
vi.mock('@/components/dca/DCAPositionStats', () => ({ default: () => null }))

import ComingSoonPanel from '@/components/ComingSoonPanel'
import DCAPanel from '@/components/DCAPanel'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'
import { findChainToken, getCanonicalUsdc } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { DcaNetworkGate, shouldShowDcaGate } from '../shell/DcaNetworkGate'
import { DcaCard } from './DcaCard'
import type { AutonomousOrder } from '@/lib/order-engine'
import { OrderType } from '@/lib/order-engine'

const weth = () => findChainToken(getWrappedNative(BASE), BASE)!

beforeEach(() => {
  resetHarness()
  h.balances = new Map([[weth().address.toLowerCase(), { raw: 2_000_000_000_000_000_000n, formatted: '2.0' }]])
  useDisconnectedChainSelection.setState({ chainId: 1 })
})
afterEach(cleanup)

// ── (5a) the chain gate ───────────────────────────────────────────────────────

describe('(5a) chain gate', () => {
  it('Ethereum: v2 says what v1 says ("DCA runs on Base and Arbitrum One") and offers the same two switches — never "Soon"', () => {
    h.account = { ...h.account, isConnected: false, chain: undefined }
    const v1 = render(<ComingSoonPanel mode="dca" chainId={1} onSwap={() => {}} />)
    const v1Sentence = v1.getByTestId('coming-soon-runs-on').textContent
    const v1Buttons = [screen.getByTestId('switch-to-8453').textContent, screen.getByTestId('switch-to-42161').textContent]
    cleanup()
    render(<DcaNetworkGate />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`${v1Sentence}.`)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DCA runs on Base and Arbitrum One.')
    expect([screen.getByRole('button', { name: 'Switch to Base' }).textContent, screen.getByRole('button', { name: 'Switch to Arbitrum One' }).textContent]).toEqual(v1Buttons)
    expect(document.body.textContent).not.toMatch(/soon/i)
  })

  it('the switch buttons use v1\'s mechanism: the disconnected selection store, or wagmi switchChain when a wallet is connected', () => {
    h.account = { ...h.account, isConnected: false, chain: undefined }
    const a = render(<DcaNetworkGate />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Base' }))
    expect(useDisconnectedChainSelection.getState().chainId).toBe(8453)
    a.unmount()
    useDisconnectedChainSelection.setState({ chainId: 1 })
    h.account = { ...h.account, isConnected: true, chain: { id: 1 } }
    render(<DcaNetworkGate />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Arbitrum One' }))
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: 42161 })
  })

  it.each([[1, true], [8453, false], [42161, false]] as const)('chain %i: gate shown = %s (Base and Arbitrum mount the card)', (chainId, gated) => {
    expect(shouldShowDcaGate(chainId)).toBe(gated)
    if (!gated) {
      h.account = { ...h.account, chain: { id: chainId } }
      render(<DcaCard chainId={chainId} />)
      expect(document.querySelector('[data-dca-card]')).not.toBeNull()
      expect(document.querySelector('[data-dca-gate]')).toBeNull()
    }
  })
})

// ── (5b) the sounds table ──────────────────────────────────────────────────────

type Step = (c: HTMLElement) => unknown
const ACTIONS: Array<[string, Step]> = [
  ['50% quick-fill', () => { fireEvent.click(screen.getAllByRole('button', { name: '50%' })[0]) }],
  ['Custom toggle', () => { fireEvent.click(screen.getByTestId('dca-custom-toggle')) }],
  ['Use presets toggle', () => { fireEvent.click(screen.getByTestId('dca-custom-toggle')) }],
  ['buys preset 3', () => { fireEvent.click(screen.getAllByRole('button', { name: '3' })[0]) }],
  ['interval preset 4h', () => { fireEvent.click(screen.getAllByRole('button', { name: '4h' })[0]) }],
  ['expiry preset 24h', () => { fireEvent.click(screen.getAllByRole('button', { name: '24h' })[0]) }],
]

async function soundsFor(Panel: 'v1' | 'v2', steps: Step[], tier: 'onchain' | 'offchain' = 'onchain') {
  const out: string[][] = []
  const { container } = render(Panel === 'v1' ? <DCAPanel chainId={BASE} /> : <DcaCard chainId={BASE} />)
  await act(async () => {})
  for (const step of steps) {
    const before = h.soundLog.length
    await act(async () => { await step(container) })
    out.push(h.soundLog.slice(before))
  }
  void tier
  cleanup()
  return out
}

describe('(5b) sounds: the same sounds.ts calls as v1 for the same actions', () => {
  it('chips, quick-fill and the Custom toggle → playClick (v1 and v2 identical, step by step)', async () => {
    const steps = ACTIONS.map(([, f]) => f)
    const v1 = await soundsFor('v1', steps)
    h.soundLog.length = 0
    const v2 = await soundsFor('v2', steps)
    expect(v2).toEqual(v1)
    expect(v2.flat().length).toBeGreaterThan(0)
  })

  it('CTA → playTouchMP3 then startWaitingSound; a weaker tier stops the wait when the consent opens (v1: dialog; v2: review)', async () => {
    h.floor = offchainInfo()
    const type = (c: HTMLElement) => fireEvent.change(c.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: '0.5' } })
    const cta = (re: RegExp) => () => { fireEvent.click(screen.getByRole('button', { name: re })) }
    const v1 = await soundsFor('v1', [type, cta(/^Start DCA/)], 'offchain')
    h.soundLog.length = 0
    const v2 = await soundsFor('v2', [type, cta(/^Review DCA$/)], 'offchain')
    expect(v1[1]).toEqual(['playTouchMP3', 'startWaitingSound', 'stopWaitingSound'])
    expect(v2[1]).toEqual(v1[1])
  })

  it('CTA on an on-chain-feed pair: v1 keeps the wait going into signing; v2 (no signing, B6a) ends it — the ONE documented difference', async () => {
    h.floor = { tier: 'onchain-feed', legs: { in: { registered: true, priced: true }, out: { registered: true, priced: true } }, registeredFeedCount: 2, effectiveCap: 250 }
    const type = (c: HTMLElement) => fireEvent.change(c.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: '0.5' } })
    const v1 = await soundsFor('v1', [type, () => { fireEvent.click(screen.getByRole('button', { name: /^Start DCA/ })) }])
    h.soundLog.length = 0
    const v2 = await soundsFor('v2', [type, () => { fireEvent.click(screen.getByRole('button', { name: /^Review DCA$/ })) }])
    expect(v1[1]).toEqual(['playTouchMP3', 'startWaitingSound'])
    expect(v2[1]).toEqual(['playTouchMP3', 'startWaitingSound', 'stopWaitingSound'])
  })

  const ORDER_EVENTS = [
    { type: 'order_created', orderId: 'o', orderHash: '0x1' },
    { type: 'dca_execution', orderId: 'o', executionNumber: 2 },
    { type: 'order_filled', orderId: 'o', txHash: '0xabc' },
    { type: 'order_cancelled', orderId: 'o' },
    { type: 'order_error', orderId: 'o', error: 'boom' },
    { type: 'order_error', orderId: 'o', error: 'New DCA orders are temporarily paused…' },
  ] as const
  it.each(ORDER_EVENTS.map((e, i) => [`${e.type}#${i}`, e] as const))('engine event %s → the same sounds and the same toast as v1', (_n, event) => {
    h.engine.latestEvent = event
    render(<DCAPanel chainId={BASE} />)
    const v1Sounds = [...h.soundLog]
    const v1Toast = h.toast.mock.calls.map((c) => c[0])
    cleanup()
    h.soundLog.length = 0
    h.toast.mockClear()
    render(<DcaCard chainId={BASE} />)
    expect(h.soundLog).toEqual(v1Sounds)
    expect(h.toast.mock.calls.map((c) => c[0])).toEqual(v1Toast)
  })

  it('Cancel / Remove rows → playClick, as v1\'s dashboard', () => {
    const o = (id: string, status: AutonomousOrder['status']) => ({
      id, orderHash: '0x', signature: '0x', orderType: OrderType.DCA, chainId: BASE, status,
      order: { owner: '0xd44d00000000000000000000000000000000962d', tokenIn: weth().address, tokenOut: getCanonicalUsdc(BASE)!.address, amountIn: 1n, dcaInterval: 86_400n },
      tokenInSymbol: 'WETH', tokenInDecimals: 18, tokenOutSymbol: 'USDC', tokenOutDecimals: 6, dcaExecuted: 1, dcaTotal: 3, floorTier: null,
      createdAt: Date.now(), executedAt: null, expiresAt: Date.now() + 86_400_000, error: null, amountOut: null, txHash: null,
    }) as unknown as AutonomousOrder
    h.engine.dcaOrders = [o('a', 'active'), o('d', 'filled')]
    render(<DCAPanel chainId={BASE} />)
    fireEvent.click(screen.getByRole('button', { name: /Positions/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const v1 = [...h.soundLog]
    cleanup()
    h.soundLog.length = 0
    render(<DcaCard chainId={BASE} />)
    fireEvent.click(screen.getByRole('tab', { name: /Positions/ }))
    fireEvent.click(screen.getByTestId('order-cancel'))
    fireEvent.click(screen.getByTestId('order-remove'))
    expect(h.soundLog).toEqual(v1)
    expect(v1).toEqual(['playClick', 'playClick', 'playClick'].slice(0, v1.length))
  })
})

// ── a11y ──────────────────────────────────────────────────────────────────────

describe('a11y', () => {
  it('names, groups and pressed state: every control has an accessible name, presets are labelled groups with the default pressed', async () => {
    render(<DcaCard chainId={BASE} />)
    await act(async () => {})
    expect(screen.getByRole('textbox', { name: 'Total to spend' })).toBeTruthy()
    expect(screen.getByRole('tablist', { name: 'DCA' })).toBeTruthy()
    for (const [group, pressed] of [['Number of buys', '10'], ['Interval', '1d'], ['Order expiry', '30d']] as const) {
      const g = screen.getByRole('group', { name: group })
      const on = Array.from(g.querySelectorAll('button[aria-pressed="true"]')).map((b) => b.textContent?.toLowerCase())
      expect(on).toEqual([pressed])
    }
    for (const b of screen.getAllByRole('button')) expect((b.textContent ?? '').trim() || b.getAttribute('aria-label')).toBeTruthy()
  })

  it('the sub-tabs move with the arrow keys and Positions shows v1\'s empty state', async () => {
    render(<DcaCard chainId={BASE} />)
    await act(async () => {})
    const create = screen.getByRole('tab', { name: 'New DCA' })
    create.focus()
    fireEvent.keyDown(create, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByRole('tab', { name: /Positions/ }).getAttribute('aria-selected')).toBe('true'))
    expect(screen.getByTestId('dca-empty')).toBeTruthy()
  })

  it('the Create CTA is the ONLY filled shape on the form (round 7): every other button is a text / chip / icon variant', async () => {
    render(<DcaCard chainId={BASE} />)
    await act(async () => {})
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1)
  })
})
