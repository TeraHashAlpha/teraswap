'use client'

import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

/**
 * [B7 C3] Keyboard through a list of rows: ArrowDown / ArrowUp move focus to the next / previous row control matching `selector`
 * (wrapping), Home / End to the first / last. Tab keeps its native order — this only adds the arrows. A key pressed inside a text
 * field, or on an element that is not one of the rows, is left alone.
 */
export function rowNavKeyDown(selector: string) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector))
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (i < 0 || items.length === 0) return
    e.preventDefault()
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[next]?.focus()
  }
}

/**
 * [B7 C3] Focus after the cancel review sheet closes. The Sheet hands focus back to the control that opened it; when the cancel went
 * through, that row leaves the list (Active → Cancelled) a moment later and focus would drop to <body>. While a restore is armed, any
 * render that finds focus on <body> moves it to the row the cancel came from (`[data-order-toggle="<id>"]`, if still listed) or to
 * `fallback` (the selected filter tab / the list). Focus the user moved elsewhere disarms it.
 */
export function useCancelFocusRestore(open: { orderId: string | null } | null, rootRef: RefObject<HTMLElement | null>, fallback: string) {
  const armed = useRef<string | null>(null)
  useEffect(() => {
    if (open) {
      armed.current = open.orderId ?? 'all'
      return
    }
    if (!armed.current) return
    const root = rootRef.current
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body) {
      // focus is somewhere real: still inside the list → stay armed (the row may leave on the next poll); elsewhere → the user moved on
      if (!root?.contains(active)) armed.current = null
      return
    }
    const target = (armed.current !== 'all' && root?.querySelector<HTMLElement>(`[data-order-toggle="${armed.current}"]`)) || root?.querySelector<HTMLElement>(fallback) || root
    target?.focus()
    armed.current = null
  })
}
