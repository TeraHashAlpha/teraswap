// @vitest-environment jsdom
/**
 * [SPRINT-9Z] WalletSessionGuard — mobile WalletConnect lifecycle.
 *
 * The prod bug: on mobile, tapping a wallet backgrounds the tab during the WC
 * deep-link handshake; on return `isConnected` flips false→true. The guard read a
 * STALE `connectedAt` on that transition and disconnected the brand-new
 * connection ("expired while inactive"), counting the handshake backgrounding as
 * idle. These tests lock the fix: a fresh connect (even with a stale baseline)
 * and a background/visibility change during the handshake must NOT disconnect,
 * while a genuine 1h of inactivity still does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const useAccountMock = vi.fn()
const disconnectMock = vi.fn()
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useDisconnect: () => ({ disconnect: disconnectMock }),
}))

import { render, act } from '@testing-library/react'
import WalletSessionGuard from './WalletSessionGuard'

const STORAGE_KEY = 'teraswap_wallet_connected_at'
const ONE_HOUR = 60 * 60 * 1000

/** Render disconnected, then flip to connected (a real false→true connect). */
function connect() {
  useAccountMock.mockReturnValue({ isConnected: false })
  const { rerender } = render(<WalletSessionGuard />)
  useAccountMock.mockReturnValue({ isConnected: true })
  act(() => {
    rerender(<WalletSessionGuard />)
  })
  return { rerender }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-08T12:00:00Z'))
  sessionStorage.clear()
  useAccountMock.mockReset()
  disconnectMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WalletSessionGuard — mobile lifecycle [SPRINT-9Z]', () => {
  it('does NOT disconnect a fresh connect even when a stale connectedAt is present', () => {
    // A stale baseline left in the tab from an earlier session (2h ago) — exactly
    // what made the old guard kill the mobile deep-link return.
    sessionStorage.setItem(STORAGE_KEY, String(Date.now() - 2 * ONE_HOUR))

    connect()

    expect(disconnectMock).not.toHaveBeenCalled()
  })

  it('resets connectedAt to now on a new connection (false→true)', () => {
    sessionStorage.setItem(STORAGE_KEY, String(Date.now() - 2 * ONE_HOUR))
    const stale = sessionStorage.getItem(STORAGE_KEY)

    connect()

    const fresh = sessionStorage.getItem(STORAGE_KEY)
    expect(fresh).not.toBe(stale)
    expect(Number(fresh)).toBe(Date.now())
  })

  it('does NOT disconnect on a background/visibility change during the post-connect handshake', () => {
    // Stale baseline + the tab backgrounding (wallet app foregrounds) then
    // returning — the full mobile handshake choreography.
    sessionStorage.setItem(STORAGE_KEY, String(Date.now() - 2 * ONE_HOUR))

    connect()

    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(5_000) // a few seconds in the wallet app
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(disconnectMock).not.toHaveBeenCalled()
  })

  it('still disconnects after a genuine 1h of inactivity (security intent preserved)', () => {
    connect()
    expect(disconnectMock).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(ONE_HOUR + 1_000)
    })

    expect(disconnectMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the session alive across the 1h boundary when the user stays active', () => {
    connect()

    act(() => {
      vi.advanceTimersByTime(40 * 60 * 1000) // 40 min
      window.dispatchEvent(new Event('click')) // user interacts → resets idle timer
      vi.advanceTimersByTime(40 * 60 * 1000) // another 40 min (80 total, 40 since activity)
    })

    expect(disconnectMock).not.toHaveBeenCalled()
  })

  it('holds the idle boundary: connected at 59m, disconnects just after 60m', () => {
    connect()

    act(() => {
      vi.advanceTimersByTime(59 * 60 * 1000) // 59 min idle — still under the cap
    })
    expect(disconnectMock).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000) // cross 60 min
    })
    expect(disconnectMock).toHaveBeenCalledTimes(1)
  })

  it('survives sessionStorage throwing (private mode) without crashing or losing the idle timer', () => {
    // Safari private mode / disabled storage: setItem throws. The guard must not
    // crash, and the in-memory idle timer must still disconnect after 1h.
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      expect(() => connect()).not.toThrow()
      expect(disconnectMock).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(ONE_HOUR + 1_000)
      })
      expect(disconnectMock).toHaveBeenCalledTimes(1)
    } finally {
      setSpy.mockRestore()
    }
  })
})
