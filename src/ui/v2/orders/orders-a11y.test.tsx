// @vitest-environment jsdom
/**
 * [ADR-025 / B7 C3] Orders tab keyboard + focus. ↑ / ↓ / Home / End walk the row toggles (Tab order untouched); a toggle announces its
 * state (`aria-expanded` + `aria-controls`); the cancel review sheet opens on Keep (v1's safe default), Esc and Keep hand focus back to
 * the Cancel control, and when a confirmed cancel takes the row out of the list focus lands on the selected filter tab, never <body>.
 * On v1's engine contract (the fake); nothing is signed or sent.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fake, resetFake } from '../dca/dca-engine-fake'
import { ALL_ORDERS, NOW } from '../dca/positions-fixtures'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true }),
  useChainId: () => 8453,
  useReadContract: () => ({ data: undefined }),
}))
vi.mock('@/hooks/useOrderEngine', async () => {
  const { useFakeOrderEngine } = await import('../dca/dca-engine-fake')
  return { useOrderEngine: useFakeOrderEngine }
})
vi.mock('@/hooks/useOrderExecutions', async () => {
  const { useOrderExecutionsFixture } = await import('../dca/positions-fixtures')
  return { useOrderExecutions: useOrderExecutionsFixture }
})
vi.mock('@/lib/sounds', () => ({ playTouchMP3: () => {}, playClick: () => {} }))

import { OrdersTab } from './OrdersTab'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  resetFake()
  fake.orders = ALL_ORDERS
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ prices: {}, executions: [] }) })))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const toggles = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-order-toggle]'))

describe('B7 · Orders keyboard', () => {
  it('↑ / ↓ / Home / End move between the rows (wrapping); Enter / Space are the button\'s own', () => {
    render(<OrdersTab />)
    const t = toggles()
    expect(t).toHaveLength(6)
    t[0].focus()
    fireEvent.keyDown(t[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(t[1])
    fireEvent.keyDown(t[1], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(t[0])
    fireEvent.keyDown(t[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(t[5])
    fireEvent.keyDown(t[5], { key: 'Home' })
    expect(document.activeElement).toBe(t[0])
    fireEvent.keyDown(t[0], { key: 'End' })
    expect(document.activeElement).toBe(t[5])
  })

  it('a toggle announces its state and the panel it controls; one row open at a time (v1\'s accordion)', () => {
    render(<OrdersTab />)
    const [a, b] = toggles()
    expect(a.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(a)
    expect(a.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(a.getAttribute('aria-controls') as string)).not.toBeNull()
    fireEvent.click(b)
    expect(a.getAttribute('aria-expanded')).toBe('false')
    expect(b.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByTestId('order-detail')).toHaveLength(1)
  })

  it('the filter tabs are an underline tab list: ← / → move and select', () => {
    render(<OrdersTab />)
    const active = screen.getByRole('tab', { name: /^Active/ })
    active.focus()
    fireEvent.keyDown(active, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: /^Completed/ }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Completed/ }))
  })
})

describe('B7 · Orders focus after the cancel sheet', () => {
  function openCancel(id: string) {
    const toggle = document.querySelector<HTMLButtonElement>(`[data-order-toggle="${id}"]`) as HTMLButtonElement
    fireEvent.click(toggle)
    const cancel = within(toggle.closest('[data-testid="order-row"]') as HTMLElement).getByTestId('order-cancel')
    cancel.focus()
    fireEvent.click(cancel)
    return cancel
  }

  it('opens on "Keep this order"; Keep and Esc return focus to Cancel Order', async () => {
    render(<OrdersTab />)
    const cancel = openCancel('l1')
    const dialog = await screen.findByRole('dialog')
    expect(document.activeElement).toBe(within(dialog).getByTestId('dca-cancel-keep'))
    fireEvent.click(within(dialog).getByTestId('dca-cancel-keep'))
    expect(document.activeElement).toBe(cancel)
    fireEvent.click(cancel)
    await screen.findByRole('dialog')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(cancel)
  })

  it('confirm: the row leaves Active and focus lands on the selected filter tab, not <body>', async () => {
    render(<OrdersTab />)
    openCancel('l1')
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('dca-cancel-confirm'))
    await waitFor(() => expect(document.querySelector('[data-order-toggle="l1"]')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Active \(5\)/ })))
  })

  it('Cancel All: focus returns to Cancel All while it is listed, and to the tab once the list empties', async () => {
    render(<OrdersTab />)
    const all = screen.getByTestId('orders-cancel-all')
    all.focus()
    fireEvent.click(all)
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Keep my orders'))
    expect(document.activeElement).toBe(all)
    fireEvent.click(all)
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Confirm — Cancel All'))
    await act(async () => {})
    await waitFor(() => expect(screen.queryByTestId('orders-cancel-all')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { selected: true })))
  })
})
