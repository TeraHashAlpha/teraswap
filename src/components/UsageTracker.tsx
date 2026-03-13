'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

// ── Session ID (persists per browser tab) ──
function getSessionId(): string {
  const KEY = 'teraswap_session_id'
  let id = sessionStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(KEY, id)
  }
  return id
}

// ── Beacon / fetch helper ──
function sendEvents(events: Record<string, unknown>[]) {
  const payload = JSON.stringify({ events })
  // Prefer sendBeacon for unload events, fallback to fetch
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/log-event', new Blob([payload], { type: 'application/json' }))
  } else {
    fetch('/api/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  }
}

// ── Buffered click queue (flush every 5s or at 10 events) ──
let clickBuffer: Record<string, unknown>[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flushClicks() {
  if (clickBuffer.length === 0) return
  sendEvents([...clickBuffer])
  clickBuffer = []
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flushClicks, 5000)
}

/**
 * UsageTracker — invisible component that tracks:
 * 1. Page views (on every route change)
 * 2. Meaningful clicks (buttons, links, interactive elements)
 * 3. Time on page (sent on route change and on tab close)
 *
 * Zero-UI component — renders nothing.
 */
export default function UsageTracker() {
  const pathname = usePathname()
  const pageEnteredAt = useRef(Date.now())
  const currentPage = useRef(pathname)
  const sessionId = useRef('')

  // Initialise session id (client-only)
  useEffect(() => {
    sessionId.current = getSessionId()
  }, [])

  // ── Page view tracking ──
  useEffect(() => {
    if (!sessionId.current) return

    // If page changed, send duration for old page first
    if (currentPage.current !== pathname) {
      const duration = Date.now() - pageEnteredAt.current
      sendEvents([{
        session_id: sessionId.current,
        event_type: 'session_end',
        page: currentPage.current,
        duration_ms: duration,
        screen_w: window.innerWidth,
        user_agent: navigator.userAgent,
      }])
    }

    // Record the new page view
    currentPage.current = pathname
    pageEnteredAt.current = Date.now()

    sendEvents([{
      session_id: sessionId.current,
      event_type: 'page_view',
      page: pathname,
      referrer: document.referrer || null,
      screen_w: window.innerWidth,
      user_agent: navigator.userAgent,
    }])
  }, [pathname])

  // ── Click tracking ──
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (!target || !sessionId.current) return

      // Only track meaningful clicks: buttons, links, and elements with click handlers
      const el = target.closest('button, a, [role="button"], [data-track]') as HTMLElement | null
      if (!el) return

      const label =
        el.getAttribute('aria-label') ||
        el.getAttribute('data-track') ||
        (el.textContent || '').trim().slice(0, 80) ||
        null

      clickBuffer.push({
        session_id: sessionId.current,
        event_type: 'click',
        page: currentPage.current,
        click_target: label,
        click_tag: el.tagName,
        click_id: el.id || null,
        click_class: el.className ? String(el.className).split(' ')[0].slice(0, 80) : null,
        screen_w: window.innerWidth,
        user_agent: navigator.userAgent,
      })

      if (clickBuffer.length >= 10) {
        flushClicks()
      } else {
        scheduleFlush()
      }
    }

    document.addEventListener('click', handleClick, { capture: true })
    return () => document.removeEventListener('click', handleClick, { capture: true })
  }, [])

  // ── Session end on tab close / unload ──
  useEffect(() => {
    function handleUnload() {
      // Flush any buffered clicks
      flushClicks()

      // Send duration for current page
      if (sessionId.current) {
        const duration = Date.now() - pageEnteredAt.current
        sendEvents([{
          session_id: sessionId.current,
          event_type: 'session_end',
          page: currentPage.current,
          duration_ms: duration,
          screen_w: window.innerWidth,
          user_agent: navigator.userAgent,
        }])
      }
    }

    // visibilitychange is more reliable than beforeunload on mobile
    function handleVisibility() {
      if (document.visibilityState === 'hidden') handleUnload()
    }

    window.addEventListener('beforeunload', handleUnload)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.removeEventListener('beforeunload', handleUnload)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  return null // Zero-UI
}
