// @vitest-environment jsdom
/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] CountdownCenter — the live next-buy countdown. Ticks every 1s,
 * recomputing remaining from the target (no drift), shows "Executing soon…" once due and stops the
 * interval, renders a static terminal label when there's no countdown, and NEVER fetches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import CountdownCenter from '../CountdownCenter'

const BASE = 1_700_000_000_000

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('CountdownCenter', () => {
  it('renders HH:MM:SS to the target', () => {
    render(<CountdownCenter targetMs={BASE + 2 * 3600 * 1000} />)
    expect(screen.getByTestId('countdown')).toHaveTextContent('02:00:00')
  })

  it('ticks down one second per second', () => {
    render(<CountdownCenter targetMs={BASE + 2 * 3600 * 1000} />)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByTestId('countdown')).toHaveTextContent('01:59:59')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByTestId('countdown')).toHaveTextContent('01:59:58')
  })

  it('shows "Executing soon…" once due and stops ticking (clears the interval)', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    render(<CountdownCenter targetMs={BASE + 1000} />)
    act(() => { vi.advanceTimersByTime(1500) })
    expect(screen.getByTestId('countdown')).toHaveTextContent(/executing soon/i)
    expect(clearSpy).toHaveBeenCalled()
  })

  it('renders a static terminal label with NO countdown/interval when targetMs is null', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    render(<CountdownCenter targetMs={null} terminalLabel="Completed" />)
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByTestId('countdown')).toBeNull()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('never fetches across many ticks (no API hammering)', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(<CountdownCenter targetMs={BASE + 60_000} />)
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
