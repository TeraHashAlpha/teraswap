// @vitest-environment jsdom
/**
 * [ADR-025 / B7 C2] Orders tab parity. v1's OrderDashboard and the v2 tab run on ONE fake engine (`dca-engine-fake`, v1's observable
 * contract: Cancel / Cancel All freeze a plan, the review's confirm runs it) over one fixture set — DCA (Base, Arbitrum, Ethereum), Limit,
 * Take Profit, Stop Loss, in every status. Gates: content parity v1 ⊆ v2 per filter and per opened row (0 missing); the same fields per
 * order; filter parity (labels, counts, membership); the cancel path's engine calls (arguments, order, count) equal to v1's for every
 * type v1 can cancel; the states (disconnected, loading, read-signature denied, empty per filter). Wallet, RPC and API are mocked.
 *
 * Format remap (owner rule "numbers via format.ts"; "explorer links use the ORDER chain"), applied to v1's DOM before the compare and
 * asserted on its own: v1's raw `formatUnits` amounts → format.ts `fmtToken` of the same bigint; v1's `toLocale*` dates → `fmtDate` of
 * the same instant; v1's hard-coded chain-1 tx links → the order's chain. Nothing else is rewritten.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatUnits } from 'viem'
import { compareContent, normalize, type AllowedRemoval } from '../__tests__/content-parity'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { fmtDate, fmtToken } from '@/lib/format'
import type { AutonomousOrder } from '@/lib/order-engine'
import { fake, resetFake } from '../dca/dca-engine-fake'
import { A1, A3, ALL_ORDERS, BASE, E1, FILLS, H1, H2, H3, L1, L2, NOW, ORDER_META, PRICES, S1, T1, order as mkOrder } from '../dca/positions-fixtures'

const h = vi.hoisted(() => ({
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true },
  round: [1n, 245_000_000_000n, 0n, 0n, 1n] as readonly bigint[] | undefined,
  readArgs: [] as unknown[],
  sounds: [] as string[],
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useChainId: () => 8453,
  useReadContract: (args: unknown) => {
    h.readArgs.push(args)
    return { data: h.round }
  },
}))
vi.mock('@/hooks/useOrderEngine', async () => {
  const { useFakeOrderEngine } = await import('../dca/dca-engine-fake')
  return { useOrderEngine: useFakeOrderEngine }
})
vi.mock('@/hooks/useOrderExecutions', async () => {
  const { useOrderExecutionsFixture } = await import('../dca/positions-fixtures')
  return { useOrderExecutions: useOrderExecutionsFixture }
})
vi.mock('@/lib/sounds', () => ({
  playTouchMP3: () => { h.sounds.push('playTouchMP3') },
  playClick: () => { h.sounds.push('playClick') },
}))

import OrderDashboard from '@/components/OrderDashboard'
import { OrdersTab } from './OrdersTab'
import { amountInText, emptyText, receivedText, targetLabel, timeLeftText, v1AmountInText } from './orders-model'

const fetchMock = vi.fn(async (url: string) => {
  const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
  if (url.startsWith('/api/portfolio/prices')) return json({ prices: PRICES })
  const m = /^\/api\/orders\/([^/]+)\/executions/.exec(url)
  if (m) return json({ executions: FILLS[m[1]] ?? [], order: ORDER_META[m[1]] ?? null })
  throw new Error(`unexpected fetch ${url}`)
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  resetFake()
  fake.orders = ALL_ORDERS
  h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true }
  h.round = [1n, 245_000_000_000n, 0n, 0n, 1n]
  h.readArgs = []
  h.sounds = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** v1's glyphs: printed as text in v1, drawn `aria-hidden` (still visible) in v2 — the swap tab's rule; the words beside them stay. */
const GLYPHS = ['🔗', '📋', '⟳', '⇅', '🎯', '🛡️', '📎', '⏱', '⛽']
function allowFor(v1: HTMLElement): AllowedRemoval[] {
  const text = v1.textContent ?? ''
  return GLYPHS.filter((g) => text.includes(g)).map((g) => ({ text: g, reason: 'decorative glyph: aria-hidden in v2, still drawn' }))
}

/** The instants an order (and its fills / meta) prints, for the date remap. */
function instants(o: AutonomousOrder): number[] {
  const out = [o.createdAt, o.executedAt, o.expiresAt].filter((t): t is number => typeof t === 'number' && t > 0)
  for (const f of FILLS[o.id] ?? []) for (const t of [f.executed_at, f.created_at]) if (t) out.push(Date.parse(t))
  const meta = ORDER_META[o.id]?.executed_at
  if (typeof meta === 'string') out.push(Date.parse(meta))
  return out
}

/** Apply the documented format remap to a clone of v1's DOM (see the header). */
function remapV1(root: HTMLElement, orders: AutonomousOrder[]): HTMLElement {
  const clone = root.cloneNode(true) as HTMLElement
  const amount = new Map<string, string>()
  const dates = new Set<string>()
  for (const o of orders) {
    amount.set(normalize(v1AmountInText(o)), amountInText(o))
    if (o.amountOut) amount.set(normalize(formatUnits(BigInt(o.amountOut), o.tokenOutDecimals || 18)), fmtToken(BigInt(o.amountOut), o.tokenOutDecimals || 18))
    for (const t of instants(o)) {
      const d = new Date(t)
      dates.add(normalize(d.toLocaleDateString()))
      dates.add(normalize(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
      dates.add(normalize(d.toLocaleDateString([], { month: 'short', day: 'numeric' })))
    }
  }
  const walker = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = normalize(n.textContent ?? '')
    if (amount.has(t)) n.textContent = amount.get(t) as string
    else if (dates.has(t)) n.textContent = ''
  }
  for (const a of Array.from(clone.querySelectorAll('a[href^="https://etherscan.io/tx/"]'))) {
    const hash = (a.getAttribute('href') as string).slice('https://etherscan.io/tx/'.length)
    const owner = orders.find((o) => o.txHash === hash || (FILLS[o.id] ?? []).some((f) => f.tx_hash === hash) || ORDER_META[o.id]?.tx_hash === hash)
    if (owner) a.setAttribute('href', explorerTxUrl(hash, owner.chainId ?? 1))
  }
  return clone
}

/** format.ts groups thousands with a thin space (U+2009); the expected strings below are typed with a plain one. */
const plain = (s: string | null | undefined) => (s ?? '').replace(/\u2009/g, ' ')

const v1Tab = (name: RegExp) => screen.getByRole('button', { name })
const v2Tab = (name: RegExp) => screen.getByRole('tab', { name })
/** v1's row toggles: the header buttons that carry the chevron. */
const v1Rows = (root: HTMLElement) => Array.from(root.querySelectorAll('svg path[d="M19 9l-7 7-7-7"]')).map((p) => p.closest('button') as HTMLButtonElement)
const v2Rows = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('[data-order-toggle]'))

async function pnlSettled(root: HTMLElement, o: AutonomousOrder) {
  if (o.orderType === 2 && (FILLS[o.id] ?? []).some((f) => f.status === 'confirmed')) await waitFor(() => expect(root.textContent).toMatch(/P&L vs spot/))
  if ((ORDER_META[o.id] || (FILLS[o.id] ?? []).length) && o.status !== 'signing') await waitFor(() => expect(root.textContent).toMatch(/Execution History/))
}

const FILTERS = [['active', /^Active/], ['completed', /^Completed/], ['cancelled', /^Cancelled/]] as const
const ids = (filter: string) =>
  ALL_ORDERS.filter((o) => (filter === 'active' ? ['active', 'executing', 'partially_filled', 'signing'].includes(o.status) : filter === 'completed' ? o.status === 'filled' : ['cancelled', 'expired', 'error'].includes(o.status))).map((o) => o.id)

describe('B7 · Orders: content parity v1 OrderDashboard ⊆ v2 (0 missing)', () => {
  it.each(FILTERS)('the %s list, collapsed', (_f, name) => {
    const v1 = render(<OrderDashboard />)
    fireEvent.click(v1Tab(name))
    const v1Root = remapV1(v1.container, ALL_ORDERS)
    cleanup()
    const v2 = render(<OrdersTab />)
    fireEvent.click(v2Tab(name))
    const r = compareContent(v1Root, v2.container, allowFor(v1Root))
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
  })

  it.each(ALL_ORDERS.map((o) => [o.id, o] as const))('order %s, opened: every v1 field and link', async (_id, o) => {
    const filter = FILTERS.find(([f]) => ids(f).includes(o.id)) as (typeof FILTERS)[number]
    const idx = ids(filter[0]).indexOf(o.id)
    const v1 = render(<OrderDashboard />)
    fireEvent.click(v1Tab(filter[1]))
    fireEvent.click(v1Rows(v1.container)[idx])
    await pnlSettled(v1.container, o)
    const v1Root = remapV1(v1.container, ALL_ORDERS) // every row is on screen (collapsed ones too)
    cleanup()
    const v2 = render(<OrdersTab />)
    fireEvent.click(v2Tab(filter[1]))
    fireEvent.click(v2Rows(v2.container)[idx])
    await pnlSettled(v2.container, o)
    const r = compareContent(v1Root, v2.container, allowFor(v1Root))
    expect({ id: o.id, missing: r.missingText, hrefs: r.missingHrefs, stale: r.staleAllow }).toEqual({ id: o.id, missing: [], hrefs: [], stale: [] })
    // the remapped fields, asserted on their own
    const row = v2.container.querySelector(`[data-order-id="${o.id}"]`) as HTMLElement
    for (const t of [o.createdAt, o.executedAt, o.expiresAt]) if (t) expect(row.textContent).toContain(fmtDate(t))
    expect(row.textContent).toContain(`${amountInText(o)} ${o.tokenInSymbol}`)
    const received = receivedText(o)
    if (received) expect(row.textContent).toContain(received)
    for (const a of Array.from(row.querySelectorAll('a[href]'))) expect(a.getAttribute('href')).not.toMatch(o.chainId === 1 ? /^$/ : /etherscan\.io/)
  })
})

describe('B7 · Orders: the same fields per order, every type and status v1 lists', () => {
  it('type, chain, status, target, fills, time left — v1 OrderCard\'s values', () => {
    render(<OrdersTab />)
    const expectRow = (o: AutonomousOrder, type: string, status: string) => {
      const row = screen.getAllByTestId('order-row').find((r) => r.getAttribute('data-order-id') === o.id) as HTMLElement
      expect(within(row).getByTestId('order-type').textContent).toBe(type)
      expect(within(row).getByTestId('order-status').textContent).toBe(status)
      expect(within(row).getByTestId('order-chain-badge').textContent).toBe(o.chainId === 1 ? 'Ethereum' : o.chainId === 42161 ? 'Arbitrum One' : 'Base')
      const target = targetLabel(o)
      if (target) expect(row.textContent).toContain(target)
      const left = timeLeftText(o, NOW)
      if (left) expect(row.textContent).toContain(left)
      return row
    }
    expectRow(A1, 'DCA', 'Active')
    expect(plain(expectRow(L1, 'Limit', 'Active').textContent)).toContain('@ $2 400.00')
    expect(plain(expectRow(T1, 'Take Profit', 'Active').textContent)).toContain('TP ≥ $3 000.00')
    expect(plain(expectRow(S1, 'Stop Loss', 'Active').textContent)).toContain('SL ≤ $2 000.00')
    expect(expectRow(E1, 'DCA', 'Active').querySelector('[data-testid="order-chain-badge"]')?.className).toMatch(/amber/) // wallet on Base
    expectRow(A3, 'DCA', 'Signing')
    expect(timeLeftText(T1, NOW)).toBe('42m')
    expect(timeLeftText(S1, NOW)).toBe('5h 10m')
    expect(timeLeftText(L1, NOW)).toBe('6d 5h')
    // the live price: v1's `Now $x (±y%)` — read on the ORDER's chain at the shared informational cadence
    const live = within(screen.getAllByTestId('order-row').find((r) => r.getAttribute('data-order-id') === 'l1') as HTMLElement).getByTestId('live-price')
    expect(plain(live.textContent)).toBe('Now $2 450.00 (+2.1%)')
    expect(h.readArgs.some((a) => (a as { chainId?: number; query?: { refetchInterval?: number } }).chainId === BASE && (a as { query: { refetchInterval: number } }).query.refetchInterval === 60_000)).toBe(true)
  })

  it('every status label is v1\'s (STATUS_CONFIG) for the same order object', () => {
    const statuses = ['signing', 'active', 'executing', 'partially_filled', 'filled', 'cancelled', 'expired', 'error'] as const
    const orders = statuses.map((s, i) => mkOrder({ id: `st${i}`, status: s }))
    for (const s of statuses) FILLS[`st${statuses.indexOf(s)}`] = []
    const labels = (root: HTMLElement) => v1Rows(root).map((b) => b.lastElementChild?.textContent?.trim())
    const seen: Record<string, unknown[]> = {}
    for (const [f, name] of FILTERS) {
      fake.orders = orders
      const v1 = render(<OrderDashboard />)
      fireEvent.click(v1Tab(name))
      seen[`v1-${f}`] = labels(v1.container)
      cleanup()
      fake.orders = orders
      render(<OrdersTab />)
      fireEvent.click(v2Tab(name))
      seen[`v2-${f}`] = screen.queryAllByTestId('order-status').map((n) => n.textContent)
      expect(seen[`v2-${f}`]).toEqual(seen[`v1-${f}`])
      cleanup()
    }
    expect(seen['v2-active']).toEqual(['Signing', 'Active', 'Executing', 'Partially Filled'])
    expect(seen['v2-completed']).toEqual(['Filled'])
    expect(seen['v2-cancelled']).toEqual(['Cancelled', 'Expired', 'Failed'])
  })
})

describe('B7 · Orders: filter parity', () => {
  it('labels, counts and membership per filter are v1\'s', () => {
    const v1 = render(<OrderDashboard />)
    const v1Labels = FILTERS.map(([, n]) => v1Tab(n).textContent)
    const v1Counts = FILTERS.map(([, n]) => { fireEvent.click(v1Tab(n)); return v1Rows(v1.container).length })
    const v1Header = within(v1.container).getByText('My Orders').textContent
    cleanup()
    const v2 = render(<OrdersTab />)
    expect(FILTERS.map(([, n]) => v2Tab(n).textContent)).toEqual(v1Labels)
    expect(v1Labels).toEqual(['Active (6)', 'Completed (2)', 'Cancelled (3)'])
    for (const [i, [f, n]] of FILTERS.entries()) {
      fireEvent.click(v2Tab(n))
      expect(v2Rows(v2.container).map((b) => b.getAttribute('data-order-toggle'))).toEqual(ids(f))
      expect(v2Rows(v2.container).length).toBe(v1Counts[i])
    }
    expect(v1Header).toContain('11')
    expect(screen.getByTestId('orders-count').textContent).toBe('11')
  })

  it('v1\'s sounds: a touch on each filter press, Cancel All, Cancel Order and Remove', () => {
    const press = (tab: (n: RegExp) => HTMLElement, rows: (r: HTMLElement) => HTMLButtonElement[], root: HTMLElement, cancel: string) => {
      fireEvent.click(tab(/^Completed/))
      fireEvent.click(rows(root)[0])
      fireEvent.click(screen.getByText('Remove'))
      fireEvent.click(tab(/^Active/))
      fireEvent.click(rows(root)[0])
      fireEvent.click(screen.getByText(cancel))
    }
    const v1 = render(<OrderDashboard />)
    press(v1Tab, v1Rows, v1.container, 'Cancel Order')
    const v1Sounds = [...h.sounds]
    const v1Seq = [...fake.seq]
    cleanup()
    resetFake()
    fake.orders = ALL_ORDERS
    h.sounds = []
    const { container } = render(<OrdersTab />)
    press(v2Tab, v2Rows, container, 'Cancel Order')
    expect(h.sounds).toEqual(v1Sounds)
    expect(fake.seq).toEqual(v1Seq)
    expect(v1Seq).toEqual([['removeOrder', 'h1'], ['cancelOrder', 'a1']])
  })
})

describe('B7 · Orders: cancel args = v1\'s, per type v1 can cancel (via the reused v2 cancel sheet)', () => {
  async function run(tree: 'v1' | 'v2', o: AutonomousOrder, answer: 'confirm' | 'keep') {
    resetFake()
    fake.orders = ALL_ORDERS
    const r = render(tree === 'v1' ? <OrderDashboard /> : <OrdersTab />)
    const idx = ids('active').indexOf(o.id)
    fireEvent.click((tree === 'v1' ? v1Rows : v2Rows)(r.container)[idx])
    fireEvent.click(screen.getByText(o.chainId === BASE ? 'Cancel Order' : `Switch to ${o.chainId === 1 ? 'Ethereum' : 'Arbitrum One'}`))
    const dialog = await screen.findByRole(tree === 'v1' ? 'dialog' : 'dialog')
    const body = dialog.cloneNode(true) as HTMLElement
    fireEvent.click(within(dialog).getByText(answer === 'confirm' ? 'Confirm — Cancel Order' : 'Keep this order'))
    await act(async () => {})
    const out = { seq: [...fake.seq], body, rows: v2Rows(r.container).length }
    cleanup()
    return out
  }

  it.each([['DCA', A1], ['Limit', L1], ['Take Profit', T1], ['Stop Loss', S1], ['DCA (Ethereum, wallet on Base)', E1]] as const)('%s: confirm', async (_t, o) => {
    const v1 = await run('v1', o, 'confirm')
    const v2 = await run('v2', o, 'confirm')
    expect(v2.seq).toEqual(v1.seq)
    expect(v1.seq).toEqual([['cancelOrder', o.id], ['confirmCancel']])
    // the review the user confirms: v1's OrderCancelReviewModal ⊆ the v2 sheet
    const r = compareContent(v1.body, v2.body)
    expect(r.missingText).toEqual([])
  })

  it.each([['DCA', A1], ['Limit', L1], ['Take Profit', T1], ['Stop Loss', S1]] as const)('%s: keep → clearPendingCancel, never confirmCancel', async (_t, o) => {
    const v1 = await run('v1', o, 'keep')
    const v2 = await run('v2', o, 'keep')
    expect(v2.seq).toEqual(v1.seq)
    expect(v1.seq).toEqual([['cancelOrder', o.id], ['clearPendingCancel']])
  })

  it('Cancel All (6): the same freeze + confirm as v1', async () => {
    const calls: Array<Array<[string, ...unknown[]]>> = []
    for (const tree of ['v1', 'v2'] as const) {
      resetFake()
      fake.orders = ALL_ORDERS
      render(tree === 'v1' ? <OrderDashboard /> : <OrdersTab />)
      fireEvent.click(screen.getByText(/^Cancel All \(6\)$/))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByText('Confirm — Cancel All'))
      await act(async () => {})
      calls.push([...fake.seq])
      cleanup()
    }
    expect(calls[1]).toEqual(calls[0])
    expect(calls[0]).toEqual([['cancelAllOrders'], ['confirmCancel']])
  })

  it('no order is cancelled without the sheet\'s confirm; the list shows the engine\'s status (no optimistic flip)', async () => {
    render(<OrdersTab />)
    fireEvent.click(v2Rows(document.body)[ids('active').indexOf('l1')])
    fireEvent.click(screen.getByText('Cancel Order'))
    await screen.findByRole('dialog')
    expect(fake.seq).toEqual([['cancelOrder', 'l1']])
    expect(screen.getByRole('tab', { name: /^Active/ }).textContent).toBe('Active (6)')
    fireEvent.click(screen.getByText('Confirm — Cancel Order'))
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Active/ }).textContent).toBe('Active (5)'))
    expect(screen.getByRole('tab', { name: /^Cancelled/ }).textContent).toBe('Cancelled (4)')
  })
})

describe('B7 · Orders: states (v1\'s words, verbatim)', () => {
  it('disconnected', () => {
    h.account = { address: undefined, isConnected: false }
    const v1 = render(<OrderDashboard />)
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<OrdersTab />)
    const r = compareContent(v1Root, v2.container, allowFor(v1Root))
    expect(r.missingText).toEqual([])
    expect(screen.getByText('Connect your wallet to view orders')).toBeTruthy()
  })

  it('loading: skeleton rows, busy, no words (v1 shows none)', () => {
    fake.isLoading = true
    const v1 = render(<OrderDashboard />)
    expect(v1.container.textContent).toBe('')
    cleanup()
    render(<OrdersTab />)
    expect(screen.getByTestId('orders-loading').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('orders-loading').textContent).toBe('')
  })

  it('read signature denied: v1\'s notice; "Sign to view" calls v1\'s retry (the test never signs)', () => {
    fake.readAuthDenied = true
    fake.orders = []
    const v1 = render(<OrderDashboard />)
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    fireEvent.click(screen.getByText('Sign to view'))
    const v1Seq = [...fake.seq]
    cleanup()
    resetFake()
    fake.readAuthDenied = true
    fake.orders = []
    const v2 = render(<OrdersTab />)
    const r = compareContent(v1Root, v2.container, allowFor(v1Root))
    expect(r.missingText).toEqual([])
    fireEvent.click(screen.getByTestId('orders-sign-to-view'))
    expect(fake.seq).toEqual(v1Seq)
    expect(v1Seq).toEqual([['requestOrdersReadAuth']])
  })

  it.each(FILTERS)('empty %s list', (f, name) => {
    fake.orders = []
    const v1 = render(<OrderDashboard />)
    fireEvent.click(v1Tab(name))
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    fake.orders = []
    render(<OrdersTab />)
    fireEvent.click(v2Tab(name))
    const r = compareContent(v1Root, document.body, allowFor(v1Root))
    expect(r.missingText).toEqual([])
    expect(screen.getByTestId('orders-empty').textContent).toContain(emptyText(f))
    expect(screen.queryByTestId('orders-count')).toBeNull() // v1: no count badge for 0 orders
    expect(screen.queryByTestId('orders-cancel-all')).toBeNull()
  })

  it('failed order: v1\'s reason, even with none persisted; filled Limit: v1\'s synthetic execution entry', async () => {
    render(<OrdersTab />)
    fireEvent.click(v2Tab(/^Cancelled/))
    fireEvent.click(v2Rows(document.body)[ids('cancelled').indexOf('h4')])
    expect(screen.getByTestId('order-error').textContent).toBeTruthy()
    fireEvent.click(v2Tab(/^Completed/))
    fireEvent.click(v2Rows(document.body)[ids('completed').indexOf('l2')])
    await screen.findByTestId('execution-history')
    expect(screen.getAllByTestId('exec-row')).toHaveLength(1)
    expect(plain(screen.getByTestId('exec-row').textContent)).toContain('@ $2 448.00')
    expect(screen.getByTestId('exec-row').querySelector('a')?.getAttribute('href')).toBe(explorerTxUrl(L2.txHash as string, BASE))
    expect([H1, H2, H3].length).toBe(3)
  })
})
