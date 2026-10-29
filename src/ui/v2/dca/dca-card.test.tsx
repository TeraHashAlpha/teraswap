// @vitest-environment jsdom
/**
 * [ADR-025] B6a commit 1 — the DCA form. v1's DCAPanel and the v2 card/hook are driven against ONE set of mocked hook answers:
 *   (3) the draft v2 builds equals the config v1's `handleCreate` hands `createOrder`, field for field, across the form's controls;
 *   (4) the cap / floor / tier messages are v1's own strings (rendered by v1's exported helpers, compared as text);
 *   (2) content parity: every visible v1 text node of the create tab is in v2 (the B10 gate), allow-list only for owner-listed removals;
 *   the CTA states and the skeleton while the server's tier is in flight.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, type AllowedRemoval } from '../__tests__/content-parity'
import { BASE, h, offchainInfo, onchainInfo, resetHarness, unpricedInfo } from './dca-harness'

vi.mock('wagmi', async () => {
  const { h } = await import('./dca-harness')
  const actual = await vi.importActual<typeof import('wagmi')>('wagmi')
  return { ...actual, useAccount: () => h.account, useChainId: () => 8453, useSwitchChain: () => ({ switchChain: h.switchChain, switchChainAsync: vi.fn() }) }
})
vi.mock('@rainbow-me/rainbowkit', async () => {
  const { h } = await import('./dca-harness')
  return { ConnectButton: () => <button data-testid="rk-connect">Connect</button>, useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }
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

import DCAPanel from '@/components/DCAPanel'
import { floorConsentCopy } from '@/components/dca/DcaFloorConsentDialog'
import { floorTierHint } from '@/components/dca/pair-floor-info'
import { DCA_INTERVAL_PRESETS, DCA_NO_PRICE_FILL_CAP_MAX_USD, DCA_TOTAL_PRESETS, EXPIRY_PRESETS, type CreateOrderConfig } from '@/lib/order-engine'
import { findChainToken, getCanonicalUsdc } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { DcaCard } from './DcaCard'
import { useDcaForm, type PrepareResult } from './use-dca-form'
import { dcaCtaFor, protectionHint } from './dca-model'

const weth = () => findChainToken(getWrappedNative(BASE), BASE)!
const usdc = () => getCanonicalUsdc(BASE)!
const WETH_BALANCE = { raw: 2_000_000_000_000_000_000n, formatted: '2.0' }

beforeEach(() => {
  resetHarness()
  h.balances = new Map([[weth().address.toLowerCase(), WETH_BALANCE]])
})
afterEach(cleanup)

const typeAmount = (container: HTMLElement, v: string) => fireEvent.change(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: v } })
const clickText = (text: string | RegExp) => fireEvent.click(screen.getAllByRole('button', { name: text })[0])

// ── (3) draft equality ────────────────────────────────────────────────────────

type Setup = { v1: () => void; v2: (f: ReturnType<typeof useDcaForm>) => void }
const SCENARIOS: Record<string, Setup> = {
  'defaults, 0.5 total': { v1: () => {}, v2: () => {} },
  '25% quick-fill': {
    v1: () => clickText('25%'),
    v2: (f) => f.fillPct(25),
  },
  '100% quick-fill, 3 buys, 4h, 24h expiry': {
    v1: () => { clickText('100%'); clickText(String(DCA_TOTAL_PRESETS[0])); clickText(DCA_INTERVAL_PRESETS[1].label); clickText(EXPIRY_PRESETS[1].label) },
    v2: (f) => { f.fillPct(100); f.setPartsIdx(0); f.setIntervalIdx(1); f.setExpiryIdx(1) },
  },
  'custom mode: 12 buys every 3 hours': {
    v1: () => {
      clickText('Custom')
      fireEvent.change(screen.getByTestId('dca-custom-buys-input'), { target: { value: '12' } })
      fireEvent.change(screen.getByTestId('dca-custom-interval-input'), { target: { value: '3' } })
      fireEvent.click(screen.getByTestId('dca-custom-interval-unit-hours'))
    },
    v2: (f) => { f.setCustomMode(true); f.setCustomBuysRaw(12); f.setCustomIntervalNumRaw(3); f.setCustomIntervalUnit('hours') },
  },
}

function stripAck(c: CreateOrderConfig): Omit<CreateOrderConfig, 'floorAck'> {
  const { floorAck: _ack, ...rest } = c
  return rest
}

async function v1Config(setup: Setup, amount: string, ack?: boolean): Promise<CreateOrderConfig> {
  const { container } = render(<DCAPanel chainId={BASE} />)
  await act(async () => {}) // the server's tier answer lands (v1 keeps Start disabled until it does)
  if (amount) typeAmount(container, amount)
  setup.v1()
  fireEvent.click(screen.getByRole('button', { name: /^Start DCA/ }))
  if (ack) {
    await screen.findByTestId('floor-consent-dialog')
    fireEvent.click(screen.getByTestId('floor-consent-checkbox'))
    fireEvent.click(screen.getByTestId('floor-consent-confirm'))
  }
  await waitFor(() => expect(h.engine.createOrder).toHaveBeenCalledTimes(1))
  const config = h.engine.createOrder.mock.calls[0][0] as CreateOrderConfig
  cleanup()
  return config
}

async function v2Draft(setup: Setup, amount: string) {
  const { result } = renderHook(() => useDcaForm(BASE, false))
  await act(async () => {})
  act(() => { if (amount) result.current.setTotalDisplay(amount) })
  act(() => setup.v2(result.current))
  let out: Awaited<ReturnType<typeof result.current.prepare>> = { ok: false }
  await act(async () => { out = await result.current.prepare() })
  return out as PrepareResult
}

describe('(3) the draft v2 builds equals v1\'s createOrder config', () => {
  for (const [name, setup] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const amount = name.includes('%') ? '' : '0.5'
      const c1 = await v1Config(setup, amount)
      h.engine.createOrder.mockClear()
      const out = await v2Draft(setup, amount)
      expect(out.ok).toBe(true)
      if (out.ok) expect(out.review.draft).toEqual(c1)
    })
  }

  it.each([
    ['offchain-price', offchainInfo()],
    ['unpriced', unpricedInfo()],
  ] as const)('%s tier: the same draft once the acknowledgement is stripped; v1 asks consent for the tier the server named', async (tier, info) => {
    h.floor = info
    const c1 = await v1Config(SCENARIOS['defaults, 0.5 total'], '0.5', true)
    h.engine.createOrder.mockClear()
    const out = await v2Draft(SCENARIOS['defaults, 0.5 total'], '0.5')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(c1.floorAck?.tier).toBe(tier)
    expect(out.review.info.tier).toBe(tier)
    expect(out.review.draft).toEqual(stripAck(c1))
    expect(out.review.symbols.length).toBeGreaterThan(0)
  })

  it('the draft carries no price condition (DCA signs priceFeed = address(0), targetPrice 0)', async () => {
    const out = await v2Draft(SCENARIOS['defaults, 0.5 total'], '0.5')
    if (!out.ok) throw new Error('expected a draft')
    expect(out.review.draft.priceFeed).toBe('0x0000000000000000000000000000000000000000')
    expect(out.review.draft.targetPrice).toBe('0')
    expect(out.review.draft.tokenIn.address).toBe(weth().address)
    expect(out.review.draft.tokenOut.address).toBe(usdc().address)
  })
})

// ── (4) cap / floor / tier messages are v1's ───────────────────────────────────

describe('(4) cap, floor and tier lines are v1\'s own strings', () => {
  it('unpriced: the cap line is v1\'s floorTierHint with the REAL cap, clamped to the ceiling', () => {
    for (const [cap, shown] of [[250, 250], [100, 100], [9999, DCA_NO_PRICE_FILL_CAP_MAX_USD]] as const) {
      const info = unpricedInfo({ effectiveCap: cap })
      expect(protectionHint(info)?.text).toBe(floorTierHint(info))
      expect(protectionHint(info)?.text).toBe(`No market price source right now — buys capped at $${shown} and flagged`)
    }
  })

  it('renders the cap line in the card, tagged with its tier, and the Protection row is v1\'s badge label', async () => {
    h.floor = unpricedInfo({ effectiveCap: 250 })
    render(<DcaCard chainId={BASE} />)
    expect((await screen.findByTestId('dca-tier-hint')).textContent).toBe('No market price source right now — buys capped at $250 and flagged')
    expect(screen.getByTestId('dca-tier-hint').getAttribute('data-tier')).toBe('unpriced')
    expect(screen.getByTestId('dca-sum-protection').textContent).toContain('No price source')
  })

  it('offchain-price: v1\'s hint and badge label; on-chain feed: no hint (the badge-less row of pack 31)', async () => {
    h.floor = offchainInfo()
    const { unmount } = render(<DcaCard chainId={BASE} />)
    expect((await screen.findByTestId('dca-tier-hint')).textContent).toBe('Protected by executor price checks (no Chainlink feed registered yet)')
    expect(screen.getByTestId('dca-sum-protection').textContent).toContain('Off-chain check')
    unmount()
    h.floor = onchainInfo()
    render(<DcaCard chainId={BASE} />)
    await waitFor(() => expect(screen.getByTestId('dca-sum-protection').textContent).toContain('On-chain price feed'))
    expect(screen.queryByTestId('dca-tier-hint')).toBeNull()
  })

  it('the consent body keeps v1\'s words and numbers: {N}, the symbols and the cap come from the server answer', () => {
    const info = unpricedInfo({ registeredFeedCount: 3, effectiveCap: 250 })
    expect(floorConsentCopy({ tier: 'unpriced', symbols: ['USDC'], effectiveCapUsd: 250, registeredFeedCount: 3 })).toContain('3 tokens on this network have a Chainlink price feed registered in our contract. USDC doesn’t'.replace('’', "'"))
    expect(floorConsentCopy({ tier: 'unpriced', symbols: ['USDC'], effectiveCapUsd: info.effectiveCap, registeredFeedCount: info.registeredFeedCount })).toContain('each buy is capped at $250 and flagged')
  })

  it('floor: the under-minimum buy message is v1\'s (same formatter, same inputs) — shown inline and the CTA says so', async () => {
    const { container } = render(<DCAPanel chainId={BASE} />)
    typeAmount(container, '0.000000000000000001')
    const v1Text = container.querySelector('p.text-amber-300')?.textContent
    cleanup()
    expect(v1Text).toBeTruthy()
    const v2 = render(<DcaCard chainId={BASE} />)
    typeAmount(v2.container, '0.000000000000000001')
    expect(v2.container.textContent).toContain(v1Text as string)
    expect(screen.getByRole('button', { name: 'Below minimum buy' })).toHaveProperty('disabled', true)
  })
})

// ── CTA states ─────────────────────────────────────────────────────────────────

describe('the CTA', () => {
  const base = { isConnected: true, wrongNetwork: false, targetChainName: 'Base', paused: false, hasTokens: true, hasAmount: true, insufficient: false, belowFloor: false, checkingRoute: false, blocked: false }
  it.each([
    [{ isConnected: false }, 'connect', 'Connect wallet', false],
    [{ wrongNetwork: true }, 'wrong-network', 'Switch to Base', false],
    [{ paused: true }, 'paused', 'DCA temporarily paused', true],
    [{ hasTokens: false }, 'select-tokens', 'Select Tokens', true],
    [{ hasAmount: false }, 'enter-amount', 'Enter Amount', true],
    [{ insufficient: true }, 'insufficient-balance', 'Insufficient balance', true],
    [{ checkingRoute: true }, 'checking-route', 'Checking route…', true],
    [{ belowFloor: true }, 'below-floor', 'Below minimum buy', true],
    [{ blocked: true }, 'blocked', 'Review DCA', true],
    [{}, 'review', 'Review DCA', false],
  ] as const)('%j → %s "%s"', (over, kind, label, disabled) => {
    expect(dcaCtaFor({ ...base, ...over })).toEqual({ kind, label, disabled })
  })

  it('the card: Enter amount → Review DCA; short balance → Insufficient balance (only when the balance is KNOWN)', async () => {
    const { container } = render(<DcaCard chainId={BASE} />)
    expect(screen.getByRole('button', { name: 'Enter Amount' })).toHaveProperty('disabled', true)
    typeAmount(container, '0.5')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review DCA' })).toHaveProperty('disabled', false))
    typeAmount(container, '5')
    expect(screen.getByRole('button', { name: 'Insufficient balance' })).toHaveProperty('disabled', true)
  })

  it('not connected → Connect wallet opens the connect modal; wrong wallet chain → switches to the selected chain', () => {
    h.account = { ...h.account, isConnected: false, chain: undefined }
    const a = render(<DcaCard chainId={BASE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(h.openConnectModal).toHaveBeenCalled()
    a.unmount()
    h.account = { ...h.account, isConnected: true, chain: { id: 1 } }
    render(<DcaCard chainId={BASE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Base' }))
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: BASE })
  })

  it('skeleton while the server\'s tier is in flight: the Protection row is aria-busy, and the CTA cannot review yet', async () => {
    h.floor = null as never // the ask never resolves to an object
    const { container } = render(<DcaCard chainId={BASE} />)
    typeAmount(container, '0.5')
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Review DCA' })).toHaveProperty('disabled', true)
  })
})

// ── (2) content parity: v1's create tab ⊆ v2 ───────────────────────────────────

const GLYPH = 'decorative glyph, aria-hidden in v2; the control keeps its accessible name'
const ALLOW: AllowedRemoval[] = [
  { text: '▸', reason: `Advanced settings chevron: ${GLYPH}` },
  { text: '↓', reason: `buy/sell separator: ${GLYPH}` },
]

describe('(2) parity: every visible v1 DCA create-tab text node is in v2', () => {
  for (const amount of ['', '0.5']) {
    it(amount ? 'with an amount (summary, route sentence, Start DCA → Review DCA)' : 'empty form', () => {
      const v1 = render(<DCAPanel chainId={BASE} />)
      if (amount) typeAmount(v1.container, amount)
      const v1Root = v1.container.cloneNode(true) as HTMLElement
      cleanup()
      const v2 = render(<DcaCard chainId={BASE} />)
      if (amount) typeAmount(v2.container, amount)
      const allow = [...ALLOW, ...(amount ? [{ text: 'Start DCA — 10 buys over 10.0 days', reason: 'owner B6a: "Review DCA"; the v1 label also names buys and duration, which the summary rows state' }] : [])]
      const r = compareContent(v1Root, v2.container, allow)
      expect(r.missingText).toEqual([])
      expect(r.missingHrefs).toEqual([])
      expect(r.staleAllow).toEqual([])
    })
  }
})
