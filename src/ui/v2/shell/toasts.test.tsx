// @vitest-environment jsdom
/**
 * [ADR-025] v2 toasts keep v1's ToastProvider API and defaults (toast / dismiss / update, dedupKey, error 8 s,
 * loading sticky, else 5 s) and add the pack-05 stack rules (max 3, newest on top, chain-aware tx link).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 8453 }))

import { MAX_VISIBLE_TOASTS, V2ToastProvider, defaultDuration, useV2Toast, type ToastType } from './toasts'

const held = { api: null as ReturnType<typeof useV2Toast> | null }
const api = new Proxy({} as ReturnType<typeof useV2Toast>, {
  get: (_t, key: keyof ReturnType<typeof useV2Toast>) => held.api![key],
})
function Probe() {
  const current = useV2Toast()
  useEffect(() => {
    held.api = current
  })
  return null
}
function mount() {
  render(
    <V2ToastProvider>
      <Probe />
    </V2ToastProvider>,
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('v2 toasts', () => {
  it('default durations match v1: error 8 s, loading sticky, others 5 s', () => {
    const d = (t: ToastType) => defaultDuration(t)
    expect([d('error'), d('loading'), d('success'), d('warning'), d('info')]).toEqual([8000, 0, 5000, 5000, 5000])
  })

  it('shows at most 3, newest on top (visually first)', () => {
    mount()
    act(() => {
      for (const n of [1, 2, 3, 4]) api.toast({ type: 'info', title: `t${n}`, duration: 0 })
    })
    expect(MAX_VISIBLE_TOASTS).toBe(3)
    const titles = screen.getAllByRole('status').map((el) => el.textContent)
    expect(titles).toHaveLength(3)
    expect(titles.join('|')).not.toContain('t1')
    // DOM order is oldest→newest inside a flex-col-reverse stack, so t4 renders at the top.
    expect(screen.getByRole('region', { name: 'Notifications' }).className).toContain('flex-col-reverse')
  })

  it('auto-dismisses after its duration; dismiss() removes immediately', () => {
    mount()
    act(() => {
      api.toast({ type: 'success', title: 'ok' })
      api.toast({ type: 'info', title: 'keep', duration: 0 })
    })
    expect(screen.getAllByRole('status')).toHaveLength(2)
    act(() => void vi.advanceTimersByTime(5000))
    expect(screen.queryByText('ok')).toBeNull()
    fireEvent.click(screen.getByLabelText('Dismiss notification'))
    expect(screen.queryByText('keep')).toBeNull()
  })

  it('dedupKey replaces the earlier toast; update() turns a loading toast into its result and starts the timer', () => {
    mount()
    let id = ''
    act(() => {
      api.toast({ type: 'error', title: 'first', dedupKey: 'q' })
      id = api.toast({ type: 'loading', title: 'Executing swap…' })
      api.toast({ type: 'error', title: 'second', dedupKey: 'q' })
    })
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second')).toBeTruthy()
    act(() => api.update(id, { type: 'success', title: 'Swap confirmed!' }))
    expect(screen.getByText('Swap confirmed!')).toBeTruthy()
    expect(screen.queryByText('Executing swap…')).toBeNull()
    act(() => void vi.advanceTimersByTime(5000))
    expect(screen.queryByText('Swap confirmed!')).toBeNull()
  })

  it('errors are alerts; the tx link follows the toast chain, defaulting to the selected chain', () => {
    mount()
    act(() => {
      api.toast({ type: 'error', title: 'boom', duration: 0 })
      api.toast({ type: 'success', title: 'a', txHash: '0xabc', duration: 0 })
      api.toast({ type: 'success', title: 'b', txHash: '0xdef', chainId: 42161, duration: 0 })
    })
    expect(screen.getByRole('alert').textContent).toContain('boom')
    const links = screen.getAllByText('View on explorer ↗').map((a) => a.getAttribute('href'))
    expect(links).toEqual(['https://basescan.org/tx/0xabc', 'https://arbiscan.io/tx/0xdef'])
  })

  it('useV2Toast outside the provider throws (same contract as v1 useToast)', () => {
    function Bad() {
      useV2Toast()
      return null
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Bad />)).toThrow(/inside <V2ToastProvider>/)
    spy.mockRestore()
  })
})
