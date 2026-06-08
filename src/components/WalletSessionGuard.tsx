'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useAccount, useDisconnect } from 'wagmi'

/**
 * Auto-disconnect the wallet after 1 hour of INACTIVITY, for security.
 * Resets the timer on user interaction (click, keypress, scroll, touch).
 * Shows no UI — purely a security guard component.
 *
 * [SPRINT-9Z] Mobile-lifecycle fix. On mobile, tapping a wallet backgrounds the
 * tab during the WalletConnect deep-link handshake; on return `isConnected` flips
 * false→true. The previous guard READ a stale `connectedAt` on that transition
 * and disconnected the brand-new connection ("expired while inactive"), counting
 * the handshake backgrounding as idle — so real users "connected, came back, and
 * were not connected."
 *
 * Fix, keeping the security intent: on every (re)connect we RE-ARM the idle timer
 * from NOW (and never read a stale baseline to disconnect), so a fresh connect /
 * handshake backgrounding can't drop the session. The 1h idle timer — reset on
 * user interaction — is preserved: genuine inactivity still disconnects.
 *
 * NOTE (auth tradeoff, for the Auditor): the idle baseline resets on every
 * (re)connect, including wagmi's automatic reconnect on reload, so the control is
 * "1h since the last connect/interaction," not an absolute session cap. That is
 * the deliberate price of not severing the mobile handshake; the previous
 * absolute "expired while inactive on reload" disconnect was the fragile behavior
 * causing the prod bug and is intentionally removed. See SPRINT-9Z FEEDBACK.
 */

const SESSION_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour of inactivity
const STORAGE_KEY = 'teraswap_wallet_connected_at'

// [SPRINT-9Z] sessionStorage can THROW (Safari private mode, storage disabled,
// some SSR/embedded webviews). A throw here must never crash the guard and leave
// the wallet connected with no idle timeout — fail soft, the in-memory timer is
// the source of truth.
function safeSetItem(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* storage unavailable — in-memory timer still governs the session */
  }
}
function safeRemoveItem(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* no-op */
  }
}

export default function WalletSessionGuard() {
  const { isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      console.log('[SESSION] Wallet disconnected — 1h idle session expired')
      disconnect()
      safeRemoveItem(STORAGE_KEY)
    }, SESSION_TIMEOUT_MS)
    // Record the new idle baseline (also a last-activity marker).
    safeSetItem(STORAGE_KEY, String(Date.now()))
  }, [disconnect])

  useEffect(() => {
    if (!isConnected) {
      if (timerRef.current) clearTimeout(timerRef.current)
      return
    }

    // [SPRINT-9Z] Connected — this fires on the false→true transition, i.e. every
    // NEW connection, INCLUDING the mobile WC deep-link return. Re-arm the idle
    // timer from NOW so a fresh connect can never inherit a stale baseline and the
    // handshake backgrounding can't count as idle. (The effect only re-runs when
    // `isConnected` changes, so this is exactly "on every new connection".)
    resetTimer()

    // Reset the idle timer on user activity.
    const events = ['click', 'keydown', 'scroll', 'touchstart'] as const
    const handler = () => resetTimer()
    for (const event of events) {
      window.addEventListener(event, handler, { passive: true })
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      for (const event of events) {
        window.removeEventListener(event, handler)
      }
    }
  }, [isConnected, disconnect, resetTimer])

  return null // No UI
}
