// @vitest-environment jsdom
/**
 * [ADR-025 / B7 C1] DCA Positions parity. v1's DCADashboard (MissionControlCard for active positions, DCAOrderCard for history, with
 * DCAPositionStats, DCAFillsTimeline and SettlementReceiptModal inside) and the v2 list are rendered against ONE set of orders, fills,
 * prices and receipt (`positions-fixtures`). Gates:
 *   1. content parity v1 ⊆ v2 — every visible v1 text node and link, 0 missing (positions list and the receipt);
 *   2. the countdown — v1's and v2's ring centre print the same thing at the same instant, tick for tick, and agree on the accent;
 *   3. the P&L — v2's number IS v1's: both come out of `computePositionPnl` and are compared as numbers (Object.is), the stats as bigints.
 * The wallet, the API (`fetch`) and the on-chain receipt decoder are mocked; nothing is signed or sent.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionPnl, PositionStats } from '@/lib/dca/position-stats'
import { compareContent, type AllowedRemoval } from '../__tests__/content-parity'
import { A1, A2, A3, A4, A5, ACTIVE, BASE, FILLS, H1, H2, HISTORY, NOW, OWNER, PRICES, RECEIPT } from './positions-fixtures'

const h = vi.hoisted(() => ({
  pnl: [] as Array<PositionPnl | null>,
  stats: [] as PositionStats[],
  clip: [] as string[],
  reduced: false,
}))

vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true }) }))
vi.mock('@/lib/sounds', () => ({ playClick: vi.fn(), playTouchMP3: vi.fn() }))
vi.mock('@/hooks/useOrderExecutions', async () => {
  const { useOrderExecutionsFixture } = await import('./positions-fixtures')
  return { useOrderExecutions: useOrderExecutionsFixture }
})
// The formula owner, observed: every PositionStats / PositionPnl either tree computes is recorded (and returned unchanged).
vi.mock('@/lib/dca/position-stats', async (orig) => {
  const actual = await orig<typeof import('@/lib/dca/position-stats')>()
  return {
    ...actual,
    computePositionStats: (...a: Parameters<typeof actual.computePositionStats>) => {
      const r = actual.computePositionStats(...a)
      h.stats.push(r)
      return r
    },
    computePositionPnl: (...a: Parameters<typeof actual.computePositionPnl>) => {
      const r = actual.computePositionPnl(...a)
      h.pnl.push(r)
      return r
    },
  }
})
// v1's receipt decodes each fill's on-chain event; the decoder is the boundary that is mocked.
vi.mock('@/lib/dca/settlement-receipt', async (orig) => {
  const actual = await orig<typeof import('@/lib/dca/settlement-receipt')>()
  const { RECEIPT } = await import('./positions-fixtures')
  return { ...actual, buildSettlementReceipt: vi.fn(async () => RECEIPT) }
})

import DCADashboard from '@/components/dca/DCADashboard'
import MissionControlCard from '@/components/dca/MissionControlCard'
import DCAPositionStats from '@/components/dca/DCAPositionStats'
import { DcaOrdersList, DcaPositionCard } from './DcaOrdersList'
import { PositionSummary, usePositionStats } from './PositionSummary'
import { countdownView, nextBuyTarget } from './positions-model'
import { formatHMS } from '@/lib/order-engine/dca-countdown'
import { nextBuyAtMs } from '@/lib/order-engine'

const fetchMock = vi.fn(async (url: string) => {
  const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
  if (url.startsWith('/api/portfolio/prices')) return json({ prices: PRICES })
  const m = /^\/api\/orders\/([^/]+)\/executions/.exec(url)
  if (m) return json({ executions: FILLS[m[1]] ?? [], order: null })
  throw new Error(`unexpected fetch ${url}`)
})

function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: q.includes('reduced-motion') ? h.reduced : false, media: q, addEventListener: () => {}, removeEventListener: () => {} }),
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.pnl = []
  h.stats = []
  h.clip = []
  h.reduced = false
  installMatchMedia()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (t: string) => { h.clip.push(t) }) } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const noop = () => {}
const props = { latestEvent: null, connectedChainId: BASE, onCancel: noop, onCancelAll: noop, onRemove: noop, onCreate: noop }

/** Decorative glyphs: v1 prints them as text, v2 draws them `aria-hidden` (still visible) — nothing is lost. */
const ALLOW: AllowedRemoval[] = []

/** Wait until every position that has fills shows its P&L (the price read resolved) in the given tree. */
async function settled(n: number) {
  await waitFor(() => expect(screen.getAllByText(/P&L vs spot/i).length).toBe(n))
}

describe('B7 · Positions: content parity, v1 DCADashboard ⊆ v2 (0 missing)', () => {
  it('every visible v1 string and link, for 5 active + 4 history positions', async () => {
    const v1 = render(<DCADashboard active={ACTIVE} history={HISTORY} {...props} />)
    await settled(3) // a1, a4, a5 have confirmed fills
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<DcaOrdersList active={ACTIVE} history={HISTORY} {...props} />)
    await settled(3)
    const r = compareContent(v1Root, v2.container, ALLOW)
    expect(r.v1Nodes).toBeGreaterThan(150)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
  })

  it('per position: the same fields as v1 for the same order object (status, tier, chain, filled/total, facts, summary, fills)', async () => {
    for (const o of ACTIVE) {
      const v1 = render(<MissionControlCard order={o} connectedChainId={BASE} onCancel={noop} />)
      if (FILLS[o.id].some((f) => f.status === 'confirmed') && o.status !== 'signing') await waitFor(() => expect(v1.container.textContent).toMatch(/P&L vs spot/))
      const v1Root = v1.container.cloneNode(true) as HTMLElement
      cleanup()
      const v2 = render(<DcaPositionCard order={o} connectedChainId={BASE} onCancel={noop} />)
      if (FILLS[o.id].some((f) => f.status === 'confirmed') && o.status !== 'signing') await waitFor(() => expect(v2.container.textContent).toMatch(/P&L vs spot/))
      const r = compareContent(v1Root, v2.container, ALLOW)
      expect({ id: o.id, missing: r.missingText, hrefs: r.missingHrefs }).toEqual({ id: o.id, missing: [], hrefs: [] })
      cleanup()
    }
  })

  it('history rows: v1 DCAOrderCard status labels, totals, failure reason, chain-aware tx link and "View receipt" gating', () => {
    const v2 = render(<DcaOrdersList active={[]} history={HISTORY} {...props} />)
    const rows = Array.from(v2.container.querySelectorAll('[data-testid="dca-order-row"]')) as HTMLElement[]
    expect(rows.map((r) => within(r).getByTestId('status-pill').textContent)).toEqual(['Completed', 'Cancelled', 'Expired', 'Failed'])
    expect(rows.map((r) => !!within(r).queryByTestId('view-receipt'))).toEqual([true, true, false, false])
    expect(within(rows[0]).getByText('View on explorer ↗').getAttribute('href')).toBe(`https://arbiscan.io/tx/${H1.txHash}`)
    expect(within(rows[3]).getByTestId('failed-banner').textContent).toBeTruthy()
    expect(rows[0].textContent).toContain('3.4449 USDC total')
  })
})

describe('B7 · settlement receipt: v1 SettlementReceiptModal ⊆ v2 sheet, same "Copy as text"', () => {
  it.each([H1, H2])('%s', async (o) => {
    const v1 = render(<DCADashboard active={[]} history={[o]} {...props} />)
    fireEvent.click(screen.getByText('View receipt'))
    await screen.findByText('Total protocol fee')
    const v1Dialog = (screen.getByRole('dialog').cloneNode(true)) as HTMLElement
    fireEvent.click(screen.getByText('Copy as text'))
    await waitFor(() => expect(h.clip.length).toBe(1))
    v1.unmount()
    cleanup()
    render(<DcaOrdersList active={[]} history={[o]} {...props} />)
    const opener = screen.getByTestId('view-receipt')
    opener.focus()
    fireEvent.click(opener)
    await screen.findByText('Total protocol fee')
    const v2Dialog = screen.getByRole('dialog')
    const r = compareContent(v1Dialog, v2Dialog)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    fireEvent.click(screen.getByTestId('settlement-receipt-copy'))
    await waitFor(() => expect(h.clip.length).toBe(2))
    expect(h.clip[1]).toBe(h.clip[0])
    expect(within(v2Dialog).getByText('Copied!')).toBeTruthy()
    // one fetch of the order's fills each, the receipt's own path and wallet
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/executions')).map(([u]) => u)).toEqual([
      `/api/orders/${o.id}/executions?wallet=${OWNER}`,
      `/api/orders/${o.id}/executions?wallet=${OWNER}`,
    ])
    // Close returns focus to "View receipt" (the Sheet's contract)
    fireEvent.click(screen.getByTestId('settlement-receipt-close'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('view-receipt'))
  })

  it('a fill without a runner-up says "Aggregation value: —"; the receipt numbers are format.ts bigint renders', async () => {
    render(<DcaOrdersList active={[]} history={[H1]} {...props} />)
    fireEvent.click(screen.getByTestId('view-receipt'))
    await screen.findByText('Total protocol fee')
    const rows = screen.getAllByTestId('fill-aggregation-value').map((n) => n.textContent)
    expect(rows[0]).toBe('Aggregation value: —')
    expect(rows[1]).toMatch(/^Best route: .+ → 0\.000452 WETH\. Next-best: KyberSwap → 0\.000451 WETH\. Aggregation value: \+0\.000001 WETH\.$/)
    expect(within(screen.getByTestId('settlement-totals')).getByText('3.4449 USDC')).toBeTruthy()
    expect(RECEIPT.fills).toHaveLength(3)
  })
})

describe('B7 · countdown: v2 = v1 at every instant', () => {
  const v1Face = (root: HTMLElement) => ({
    countdown: root.querySelector('[data-testid="countdown"]')?.textContent ?? null,
    terminal: root.querySelector('[data-testid="countdown-terminal"]')?.textContent ?? null,
    label: root.querySelector('[data-testid="countdown"]')?.previousElementSibling?.textContent ?? null,
    accent: (() => {
      const stroke = root.querySelector('[data-testid="ring-arc"]')?.getAttribute('stroke')
      return stroke === '#4ADE80' ? 'success' : stroke ? 'gold' : null
    })(),
  })
  const v2Face = (root: HTMLElement) => ({
    countdown: root.querySelector('[data-testid="countdown"]')?.textContent ?? null,
    terminal: root.querySelector('[data-testid="countdown-terminal"]')?.textContent ?? null,
    label: root.querySelector('[data-testid="countdown"]')?.previousElementSibling?.textContent ?? null,
    accent: root.querySelector('[data-testid="next-buy-ring"]')?.getAttribute('data-accent') ?? null,
  })

  // [order, ms after NOW]: well before, 30 s before (imminent), at, after (due), the 0-fill schedule start, and the terminal faces.
  const nextA1 = A1.createdAt + 5 * 86_400_000
  const CASES: Array<[string, typeof A1, number]> = [
    ['a1 now (9h 07m)', A1, 0],
    ['a1 30 s before', A1, nextA1 - NOW - 30_000],
    ['a1 at the target', A1, nextA1 - NOW],
    ['a1 2 min after', A1, nextA1 - NOW + 120_000],
    ['a2 schedule start + interval', A2, 0],
    ['a3 signing', A3, 0],
    ['a4 executing, due', A4, 0],
    ['h1 completed', H1, 0],
    ['h2 cancelled', H2, 0],
    ['expired', { ...A1, id: 'x', status: 'expired' as const }, 0],
  ]

  it.each(CASES)('%s', async (_name, o, offset) => {
    vi.useRealTimers()
    vi.useFakeTimers()
    vi.setSystemTime(NOW + offset)
    const faces: Array<[unknown, unknown]> = []
    const v1 = render(<MissionControlCard order={o} connectedChainId={BASE} onCancel={noop} />)
    const v2 = render(<DcaPositionCard order={o} connectedChainId={BASE} onCancel={noop} />)
    faces.push([v1Face(v1.container), v2Face(v2.container)])
    for (const step of [1000, 1000, 59_000, 3_600_000]) {
      await act(async () => { vi.advanceTimersByTime(step) })
      faces.push([v1Face(v1.container), v2Face(v2.container)])
    }
    for (const [a, b] of faces) expect(b).toEqual(a)
    // the face is never empty: a countdown or a terminal label
    expect(faces.every(([a]) => (a as { countdown: string | null; terminal: string | null }).countdown !== null || (a as { terminal: string | null }).terminal !== null)).toBe(true)
  })

  it('the math: target = v1 `nextBuyAtMs(last fill ?? schedule start, interval)`, the value = v1 `formatHMS`', () => {
    const last = Date.parse(FILLS.a1[3].created_at as string)
    expect(nextBuyTarget(A1, last)).toBe(nextBuyAtMs({ lastFillAtMs: last, scheduleStartMs: A1.createdAt, intervalSec: 86_400 }))
    expect(nextBuyTarget(A2, null)).toBe(A2.createdAt + 14_400_000)
    expect(nextBuyTarget(A3, null)).toBeNull()
    for (const ms of [1, 999, 1000, 59_999, 3_599_999, 32_820_000, 90 * 86_400_000 + 7]) {
      const v = countdownView(NOW + ms, undefined, NOW)
      expect(v).toEqual({ kind: 'live', label: 'Next buy in', value: formatHMS(ms), due: false })
    }
    expect(countdownView(NOW, undefined, NOW)).toEqual({ kind: 'live', label: 'Buying now', value: 'Executing soon…', due: true })
    expect(countdownView(null, undefined, NOW)).toEqual({ kind: 'terminal', text: '—' })
  })

  it('reduced motion: no ring is drawn — the same words stand as static text', () => {
    h.reduced = true
    installMatchMedia()
    const v1 = render(<MissionControlCard order={A1} connectedChainId={BASE} onCancel={noop} />)
    const v1Text = v1Face(v1.container)
    cleanup()
    const v2 = render(<DcaPositionCard order={A1} connectedChainId={BASE} onCancel={noop} />)
    expect(v2.container.querySelector('svg circle[data-testid="ring-arc"]')).toBeNull()
    expect(v2.container.querySelector('[data-testid="next-buy-static"]')).not.toBeNull()
    expect(v2.container.querySelector('[data-testid="countdown"]')?.textContent).toBe(v1Text.countdown)
    expect(v2.container.querySelector('[data-testid="order-progress"]')?.textContent).toBe('4 of 10 buys')
  })
})

describe('B7 · P&L: v2 = v1 for the same fixture (number equality, the lib is the formula owner)', () => {
  const ARGS = (o: typeof A1) => ({
    orderId: o.id, wallet: OWNER, tokenIn: o.order.tokenIn as string, tokenOut: o.order.tokenOut as string,
    tokenInSymbol: o.tokenInSymbol, tokenOutSymbol: o.tokenOutSymbol, tokenInDecimals: o.tokenInDecimals, tokenOutDecimals: o.tokenOutDecimals,
    chainId: o.chainId ?? 1, dcaTotal: o.dcaTotal,
  })
  const lastPnl = () => [...h.pnl].reverse().find((p) => p !== null) ?? null

  async function v1Values(o: typeof A1, fills?: typeof FILLS.a1) {
    h.pnl = []
    h.stats = []
    const v1 = render(<DCAPositionStats {...ARGS(o)} fills={fills} />)
    await waitFor(() => expect(lastPnl()).not.toBeNull())
    const out = { pnl: lastPnl() as PositionPnl, stats: h.stats.at(-1) as PositionStats, text: v1.container.textContent }
    cleanup()
    return out
  }

  it.each([['a1 (Base, up)', A1], ['h1 (Arbitrum, self-fetch)', H1], ['a5 (one fill)', A5]] as const)('%s', async (_n, o) => {
    const fills = o.id === 'h1' ? undefined : FILLS[o.id]
    const v1 = await v1Values(o, fills)

    h.pnl = []
    h.stats = []
    const { result } = renderHook(() => usePositionStats({ ...ARGS(o), fills }))
    await waitFor(() => expect(result.current.pnl).not.toBeNull())
    const v2 = result.current
    expect(Object.is(v2.pnl!.pnlUsd, v1.pnl.pnlUsd)).toBe(true)
    expect(Object.is(v2.pnl!.pnlPct, v1.pnl.pnlPct)).toBe(true)
    expect(Object.is(v2.pnl!.investedUsd, v1.pnl.investedUsd)).toBe(true)
    expect(Object.is(v2.pnl!.currentValueUsd, v1.pnl.currentValueUsd)).toBe(true)
    expect(v2.pnl!.direction).toBe(v1.pnl.direction)
    expect(BigInt(v2.stats.totalInvestedRaw)).toBe(BigInt(v1.stats.totalInvestedRaw))
    expect(BigInt(v2.stats.totalReceivedRaw)).toBe(BigInt(v1.stats.totalReceivedRaw))
    expect(v2.stats).toEqual(v1.stats)

    // and the rendered P&L reads the same
    cleanup()
    const r = render(<PositionSummary {...ARGS(o)} fills={fills} />)
    await waitFor(() => expect(r.container.querySelector('[data-testid="position-pnl"]')).not.toBeNull())
    const v1Pnl = /P&L vs spot(.+)$/.exec(v1.text ?? '')?.[1]
    expect(r.container.querySelector('[data-testid="position-pnl"] dd')?.textContent).toBe(v1Pnl)
  })

  it('a loss: the same negative number, v1\'s calm cue (never red); no price → no P&L in either', async () => {
    const down = { ...PRICES }
    for (const k of Object.keys(down)) if (down[k] > 100) down[k] = 2000
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => (url.startsWith('/api/portfolio/prices') ? { prices: down } : { executions: [] }) }) as Response)
    const v1 = await v1Values(A1, FILLS.a1)
    expect(v1.pnl.direction).toBe('down')
    h.pnl = []
    const r = render(<PositionSummary {...ARGS(A1)} fills={FILLS.a1} />)
    await waitFor(() => expect(r.container.querySelector('[data-testid="position-pnl"]')).not.toBeNull())
    expect(Object.is(lastPnl()!.pnlUsd, v1.pnl.pnlUsd)).toBe(true)
    expect(r.container.querySelector('[data-testid="position-pnl"] span')?.className).not.toMatch(/red/)
    cleanup()

    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ prices: {} }) }) as Response)
    const v1None = render(<DCAPositionStats {...ARGS(A1)} fills={FILLS.a1} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(v1None.container.textContent).not.toMatch(/P&L/)
    cleanup()
    const v2None = render(<PositionSummary {...ARGS(A1)} fills={FILLS.a1} />)
    await act(async () => {})
    expect(v2None.container.textContent).not.toMatch(/P&L/)
    expect(v2None.container.textContent).toMatch(/Position summary/)
  })
})

describe('B7 · Positions keyboard', () => {
  it('↑ / ↓ / Home / End walk every row control (Cancel, fill tx links, explorer, View receipt, Remove)', () => {
    render(<DcaOrdersList active={[A1]} history={[H1, H2]} {...props} />)
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-row-nav]'))
    // a1: 4 fill links + Cancel · h1: explorer + receipt + Remove · h2: receipt + Remove
    expect(items.map((n) => n.textContent?.trim().slice(0, 12))).toHaveLength(4 + 1 + 3 + 2)
    items[0].focus()
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'End' })
    expect(document.activeElement).toBe(items[items.length - 1])
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
  })
})
