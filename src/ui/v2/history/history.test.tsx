// @vitest-environment jsdom
/**
 * [ADR-025 / B7 C3] History tab parity. v1's WalletHistory and the v2 tab are rendered against ONE mocked `/api/history` answer per state
 * (disconnected, loading, error ×2, empty, list) and compared: every visible v1 string and link is in v2 (0 missing); the request each
 * makes is identical (URL, read-signature headers, on connect and on Refresh); CSV export is v1's link with v1's gating; ↑ / ↓ / Home / End
 * walk the rows' tx links. The wallet and the API are mocked; nothing is signed or sent.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, type AllowedRemoval } from '../__tests__/content-parity'
import type { SwapRecord } from './history-model'

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const DAY = 86_400_000

const h = vi.hoisted(() => ({
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true },
  headers: null as Record<string, string> | null,
  answer: null as null | (() => Promise<Response>),
}))

vi.mock('wagmi', () => ({ useAccount: () => h.account }))
vi.mock('@/lib/order-engine/read-auth', () => ({ ordersReadHeaders: () => h.headers }))

import WalletHistory from '@/components/WalletHistory'
import { HistoryTab } from './HistoryTab'
import { historyAmount, sourceLabel, timeAgo } from './history-model'

const WALLET = '0xd44d00000000000000000000000000000000962d'
const SWAPS: SwapRecord[] = [
  { kind: 'swap', id: 's1', tx_hash: `0x3c7e${'a'.repeat(54)}0091d2`, source: 'velora', token_in_symbol: 'ETH', token_out_symbol: 'USDC', amount_in: '700000000000000', amount_out: '1718300', amount_in_usd: 1.72, status: 'confirmed', created_at: ago(MIN), chain_id: 8453 },
  { kind: 'swap', id: 's2', tx_hash: `0x074fe0${'b'.repeat(52)}560b84`, source: '1inch', token_in_symbol: 'ETH', token_out_symbol: 'ETHFI', amount_in: '0.005', amount_out: '18.68', amount_in_usd: null, status: 'success', created_at: ago(17 * DAY), chain_id: 1 },
  { kind: 'dca_fill', id: 'f1', tx_hash: `0xb404fe${'c'.repeat(52)}023768`, source: 'teraswap_order_engine', token_in_symbol: 'USDC', token_out_symbol: 'WETH', amount_in: '1148300', amount_out: '454000000000000', amount_in_usd: 1.15, status: 'confirmed', created_at: ago(28 * DAY), chain_id: 42161, order_id: 'ord-0000-87e31a', execution_number: 3, dca_total: 3 },
  { kind: 'dca_fill', id: 'f2', tx_hash: null, source: 'teraswap_order_engine', token_in_symbol: 'WETH', token_out_symbol: 'USDC', amount_in: '500000000000000', amount_out: '1150000', amount_in_usd: null, status: 'pending', created_at: ago(29 * DAY), chain_id: 8453, order_id: null, execution_number: null, dca_total: null },
  { kind: 'swap', id: 's3', tx_hash: `0x785cc9${'d'.repeat(52)}ae33a4`, source: 'paraswap', token_in_symbol: 'stETH', token_out_symbol: 'USDT', amount_in: '1000000000000000000', amount_out: '2480120000', amount_in_usd: 2480.5, status: 'reverted', created_at: ago(3 * 60 * MIN), chain_id: 8453 },
  { kind: 'swap', id: 's4', tx_hash: `0x0da2a5${'e'.repeat(52)}eaf009`, source: '', token_in_symbol: 'FOO', token_out_symbol: 'WBTC', amount_in: 'n/a', amount_out: '1234', amount_in_usd: 0.004, status: 'weird', created_at: ago(45 * DAY), chain_id: 8453 },
]

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as Response
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => (h.answer ? h.answer() : json({ swaps: SWAPS, total: 62 })))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.account = { address: WALLET, isConnected: true }
  h.headers = null
  h.answer = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** v1 prints its row glyphs (⟳ ⇄) as text; v2 draws them `aria-hidden` (still visible) — the swap / orders rule. */
function allowFor(v1: HTMLElement): AllowedRemoval[] {
  return ['⟳', '⇄'].filter((g) => v1.textContent?.includes(g)).map((g) => ({ text: g, reason: 'decorative glyph: aria-hidden in v2, still drawn' }))
}

async function both(settle: (root: HTMLElement) => Promise<void> | void) {
  const v1 = render(<WalletHistory />)
  await settle(v1.container)
  const v1Root = v1.container.cloneNode(true) as HTMLElement
  const v1Calls = fetchMock.mock.calls.map(([u, i]) => [u, i?.headers])
  cleanup()
  fetchMock.mockClear()
  const v2 = render(<HistoryTab />)
  await settle(v2.container)
  const v2Calls = fetchMock.mock.calls.map(([u, i]) => [u, i?.headers])
  return { v1Root, v2: v2.container, v1Calls, v2Calls, r: compareContent(v1Root, v2.container, allowFor(v1Root)) }
}

describe('B7 · History: content parity v1 WalletHistory ⊆ v2, per state (0 missing)', () => {
  it('list: swaps + DCA fills, every v1 string and link (tx on each record\'s chain, Export CSV)', async () => {
    const { r, v2, v1Calls, v2Calls } = await both(async (root) => { await waitFor(() => expect(root.textContent).toMatch(/Showing 6 of 62/)) })
    expect(r.v1Nodes).toBeGreaterThan(60)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
    expect(v2Calls).toEqual(v1Calls)
    expect(v1Calls).toEqual([[`/api/history?wallet=${WALLET}&limit=50`, undefined]])
    const rows = within(v2).getAllByTestId('history-row')
    expect(rows.map((row) => row.querySelector('a[href]')?.getAttribute('href') ?? null)).toEqual([
      `https://basescan.org/tx/${SWAPS[0].tx_hash}`, `https://etherscan.io/tx/${SWAPS[1].tx_hash}`, `https://arbiscan.io/tx/${SWAPS[2].tx_hash}`, null,
      `https://basescan.org/tx/${SWAPS[4].tx_hash}`, `https://basescan.org/tx/${SWAPS[5].tx_hash}`,
    ])
    expect(rows.map((row) => within(row).getByTestId('history-status').textContent)).toEqual(['confirmed', 'confirmed', 'confirmed', 'pending', 'failed', 'pending'])
    expect(rows.map((row) => within(row).getByTestId('history-chain').textContent)).toEqual(['Base', 'Ethereum', 'Arbitrum One', 'Base', 'Base', 'Base'])
    expect(within(rows[2]).getByTestId('history-dca').getAttribute('title')).toBe('Automated DCA fill executed by the TeraSwap keeper')
  })

  it('v1\'s words for each record: source names, fill labels, amounts (format.ts), time ago', () => {
    expect(SWAPS.map((s) => sourceLabel(s.source))).toEqual(['velora', '1inch', 'teraswap_order_engine', 'teraswap_order_engine', 'ParaSwap', 'Unknown'])
    expect(historyAmount('700000000000000', 'ETH')).toBe('0.0007')
    expect(historyAmount('1718300', 'USDC')).toBe('1.7183')
    expect(historyAmount('0.005', 'ETH')).toBe('0.005')
    expect(historyAmount('n/a', 'FOO')).toBe('n/a')
    expect(historyAmount('1234', 'WBTC')).toBe('0.00001234')
    expect(SWAPS.map((s) => timeAgo(s.created_at, NOW))).toEqual(['1m ago', '17d ago', '28d ago', '29d ago', '3h ago', '1mo ago'])
  })

  it('the read signature, when the session holds one, rides the same request as v1 — on connect and on Refresh', async () => {
    h.headers = { 'x-orders-read-sig': '0xsig', 'x-orders-read-issued': '1' }
    const settle = async (root: HTMLElement) => {
      await waitFor(() => expect(root.textContent).toMatch(/Showing 6 of 62/))
      fireEvent.click(within(root).getByText('Refresh'))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(within(root).getByText('Refresh')).toBeTruthy())
    }
    const { v1Calls, v2Calls } = await both(settle)
    expect(v2Calls).toEqual(v1Calls)
    expect(v1Calls).toEqual([
      [`/api/history?wallet=${WALLET}&limit=50`, h.headers],
      [`/api/history?wallet=${WALLET}&limit=50`, h.headers],
    ])
  })

  it('disconnected', async () => {
    h.account = { address: undefined, isConnected: false }
    const { r, v2, v1Calls, v2Calls } = await both(() => {})
    expect(r.missingText).toEqual([])
    expect(v2.textContent).toContain('Connect your wallet to see swap history')
    expect(v1Calls).toEqual([])
    expect(v2Calls).toEqual([])
  })

  it('loading: v1\'s "Loading..." on Refresh, skeleton rows, the request in flight', async () => {
    h.answer = () => new Promise<Response>(() => {}) // never settles
    const { r, v2 } = await both(async (root) => { await waitFor(() => expect(root.textContent).toMatch(/Loading\.\.\./)) })
    expect(r.missingText).toEqual([])
    expect(within(v2).getByTestId('history-loading').querySelectorAll('.ts-v2-skeleton')).toHaveLength(5)
    expect((within(v2).getByTestId('history-refresh') as HTMLButtonElement).disabled).toBe(true)
    expect(v2.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it.each([
    ['HTTP 500', () => Promise.resolve(json({}, false, 500)), 'Could not fetch swap history'],
    ['network', () => Promise.reject(new Error('offline')), 'Could not fetch swap history'],
    ['API error body', () => Promise.resolve(json({ error: 'Rate limit exceeded' })), 'Rate limit exceeded'],
  ] as const)('error (%s): v1\'s line, verbatim', async (_n, answer, text) => {
    h.answer = answer as () => Promise<Response>
    const { r, v2 } = await both(async (root) => { await waitFor(() => expect(root.textContent).toContain(text)) })
    expect(r.missingText).toEqual([])
    expect(within(v2).getByRole('alert').textContent).toBe(text)
    expect(within(v2).queryByTestId('history-empty')).toBeNull() // v1: no empty sentence under an error
  })

  it('empty: v1\'s sentence; Export CSV is inert (aria-disabled, click prevented), no footer', async () => {
    h.answer = () => Promise.resolve(json({ swaps: [], total: 0 }))
    const { r, v2 } = await both(async (root) => { await waitFor(() => expect(root.textContent).toMatch(/No activity yet/)) })
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    const exp = within(v2).getByTestId('history-export')
    expect(exp.getAttribute('aria-disabled')).toBe('true')
    expect(exp.getAttribute('href')).toBe(`/api/analytics/export?wallet=${WALLET}&format=csv`)
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    exp.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(within(v2).queryByTestId('history-footer')).toBeNull()
    expect(within(v2).queryByTestId('history-total')).toBeNull()
  })

  it('a list: Export CSV is live (v1\'s href, not prevented); one page of 50, as v1 (no pagination, no infinite scroll)', async () => {
    render(<HistoryTab />)
    await screen.findByText(/Showing 6 of 62 records on TeraSwap/)
    const exp = screen.getByTestId('history-export')
    expect(exp.getAttribute('aria-disabled')).toBe('false')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    exp.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(screen.getByTestId('history-total').textContent).toBe('(62)')
    expect(screen.queryByText(/load more|next page/i)).toBeNull()
    await act(async () => { window.dispatchEvent(new Event('scroll')) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('B7 · History: keyboard', () => {
  it('↑ / ↓ / Home / End walk the rows\' tx links (wrapping); Tab order is untouched', async () => {
    render(<HistoryTab />)
    await screen.findByText(/Showing 6 of 62/)
    const links = Array.from(document.querySelectorAll<HTMLElement>('[data-history-link]'))
    expect(links).toHaveLength(5) // the pending fill has no tx
    links[0].focus()
    fireEvent.keyDown(links[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(links[1])
    fireEvent.keyDown(links[1], { key: 'End' })
    expect(document.activeElement).toBe(links[4])
    fireEvent.keyDown(links[4], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(links[0])
    fireEvent.keyDown(links[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(links[4])
    fireEvent.keyDown(links[4], { key: 'Home' })
    expect(document.activeElement).toBe(links[0])
    // a key on a control that is not a row link is left alone
    const refresh = screen.getByTestId('history-refresh')
    refresh.focus()
    fireEvent.keyDown(refresh, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(refresh)
  })
})
