/**
 * useOrderNotifications — Browser push notifications for order events
 *
 * Uses the Notification API to alert the user when orders are filled,
 * partially filled, or encounter errors — even if the tab is in the background.
 *
 * Also plays an audio cue on fills.
 */

'use client'

import { useEffect, useCallback, useRef, useState } from 'react'

// ── Types (compatible with all order engine events) ──
interface OrderEvent {
  type: string
  orderId?: string
  orderHash?: string
  txHash?: string
  error?: string
  executionNumber?: number
}

type NotificationPermission = 'default' | 'granted' | 'denied'

// Safari compat: webkitAudioContext fallback
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext }

// ── Notification sound (base64 inline — short "coin" chime) ──
// We generate it with the Web Audio API to avoid external files.
function playFillSound() {
  try {
    const ctx = new (window.AudioContext || (window as WebkitWindow).webkitAudioContext!)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)       // A5
    osc.frequency.setValueAtTime(1318.5, ctx.currentTime + 0.08) // E6
    osc.frequency.setValueAtTime(1760, ctx.currentTime + 0.16)   // A6

    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)

    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.4)

    // Cleanup
    osc.onended = () => { gain.disconnect(); ctx.close() }
  } catch {
    // AudioContext may be blocked before user interaction — fail silently
  }
}

// ── Storage key for user preference ──
const NOTIF_PREF_KEY = 'teraswap_notifications_enabled'

function loadNotifPref(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const val = localStorage.getItem(NOTIF_PREF_KEY)
    return val !== 'false' // default = enabled
  } catch { return true }
}

function saveNotifPref(enabled: boolean) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(NOTIF_PREF_KEY, String(enabled)) } catch {}
}

// ── Hook ──

export function useOrderNotifications(latestEvent: OrderEvent | null) {
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [enabled, setEnabled] = useState(true)
  const lastEventRef = useRef<string | null>(null)

  // Load saved preference + check current permission
  useEffect(() => {
    setEnabled(loadNotifPref())

    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPermission(Notification.permission as NotificationPermission)
    }
  }, [])

  // Request permission (call from UI)
  const requestPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied' as const
    try {
      const result = await Notification.requestPermission()
      setPermission(result as NotificationPermission)
      return result
    } catch {
      return 'denied' as const
    }
  }, [])

  // Toggle notifications on/off
  const toggleEnabled = useCallback((val: boolean) => {
    setEnabled(val)
    saveNotifPref(val)
  }, [])

  // Fire notification on relevant events
  useEffect(() => {
    if (!latestEvent || !enabled) return

    // Deduplicate — don't fire twice for the same event
    const eventKey = `${latestEvent.type}-${latestEvent.orderId || ''}-${latestEvent.txHash || ''}`
    if (eventKey === lastEventRef.current) return
    lastEventRef.current = eventKey

    // Only notify on fills, DCA executions, and errors
    const { type } = latestEvent

    if (type === 'order_filled') {
      playFillSound()
      sendNotification(
        'Order Filled!',
        latestEvent.txHash
          ? `Your order has been executed. Tx: ${latestEvent.txHash.slice(0, 10)}...`
          : 'Your order has been executed successfully.',
        'success'
      )
    } else if (type === 'dca_execution') {
      sendNotification(
        `DCA Buy #${latestEvent.executionNumber ?? ''}`,
        'A DCA buy has been executed autonomously.',
        'info'
      )
    } else if (type === 'order_error') {
      sendNotification(
        'Order Failed',
        latestEvent.error || 'An order encountered an error.',
        'error'
      )
    }
  }, [latestEvent, enabled])

  return {
    permission,
    enabled,
    requestPermission,
    toggleEnabled,
    /** True if notifications are supported and permitted */
    isActive: permission === 'granted' && enabled,
  }
}

// ── Internal: send a browser notification ──
function sendNotification(title: string, body: string, level: 'success' | 'info' | 'error') {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return

  // Don't notify if the tab is already focused (user sees the toast)
  if (document.hasFocus()) return

  try {
    const icon = level === 'success'
      ? '/icons/check-circle.svg'
      : level === 'error'
        ? '/icons/x-circle.svg'
        : '/icons/info.svg'

    const n = new Notification(`TeraSwap — ${title}`, {
      body,
      icon: icon,
      badge: '/favicon.ico',
      tag: `teraswap-${Date.now()}`, // unique tag to allow stacking
      requireInteraction: false,
    })

    // Focus the tab when clicked
    n.onclick = () => {
      window.focus()
      n.close()
    }

    // Auto-close after 8s
    setTimeout(() => n.close(), 8000)
  } catch {
    // Notification may fail in some environments — fail silently
  }
}

// ── Standalone permission request component hook ──
export function useNotificationPrompt() {
  const [dismissed, setDismissed] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission>('default')

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPermission(Notification.permission as NotificationPermission)
    }
    // Check if user already dismissed the prompt
    try {
      if (localStorage.getItem('teraswap_notif_prompt_dismissed') === 'true') {
        setDismissed(true)
      }
    } catch {}
  }, [])

  const dismiss = useCallback(() => {
    setDismissed(true)
    try { localStorage.setItem('teraswap_notif_prompt_dismissed', 'true') } catch {}
  }, [])

  const request = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    const result = await Notification.requestPermission()
    setPermission(result as NotificationPermission)
    dismiss()
  }, [dismiss])

  return {
    shouldShow: !dismissed && permission === 'default' && typeof window !== 'undefined' && 'Notification' in window,
    permission,
    request,
    dismiss,
  }
}
