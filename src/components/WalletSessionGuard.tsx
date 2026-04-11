'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useAccount, useDisconnect } from 'wagmi'

/**
 * Auto-disconnect wallet after 1 hour of inactivity for security.
 * Resets the timer on user interaction (click, keypress, scroll).
 * Shows no UI — purely a security guard component.
 */

const SESSION_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour
const STORAGE_KEY = 'teraswap_wallet_connected_at'

export default function WalletSessionGuard() {
  const { isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      console.log('[SESSION] Wallet disconnected — 1h session expired')
      disconnect()
      sessionStorage.removeItem(STORAGE_KEY)
    }, SESSION_TIMEOUT_MS)
    // Track last activity
    sessionStorage.setItem(STORAGE_KEY, String(Date.now()))
  }, [disconnect])

  useEffect(() => {
    if (!isConnected) {
      if (timerRef.current) clearTimeout(timerRef.current)
      return
    }

    // Check if session already expired (e.g. tab was backgrounded)
    const connectedAt = sessionStorage.getItem(STORAGE_KEY)
    if (connectedAt) {
      const elapsed = Date.now() - Number(connectedAt)
      if (elapsed >= SESSION_TIMEOUT_MS) {
        console.log('[SESSION] Wallet disconnected — session expired while tab was inactive')
        disconnect()
        sessionStorage.removeItem(STORAGE_KEY)
        return
      }
    }

    // Start timer
    resetTimer()

    // Reset on user activity
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
