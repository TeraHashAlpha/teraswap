// ══════════════════════════════════════════════════════════
//  CLIENT-SIDE WALLET ACTIVITY TRACKER
//
//  Singleton utility that any hook/component can import.
//  Tracks per-wallet actions (swaps, approvals, quotes, errors)
//  for debugging and support.
//
//  All calls are fire-and-forget — never blocks UI.
//  Uses batched sending: flush every 5s or at 10 events.
// ══════════════════════════════════════════════════════════

export interface WalletEvent {
  category: 'swap' | 'approval' | 'quote' | 'order' | 'ui' | 'error'
  action: string
  source?: string
  token_in?: string
  token_out?: string
  amount_usd?: number
  success?: boolean
  error_code?: string
  error_msg?: string
  tx_hash?: string
  order_id?: string
  duration_ms?: number
  metadata?: Record<string, unknown>
}

// ── Session ID (reuses the same key as UsageTracker) ──
function getSessionId(): string {
  if (typeof window === 'undefined') return ''
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
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon('/api/log-activity', new Blob([payload], { type: 'application/json' }))
  } else {
    fetch('/api/log-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  }
}

// ── Buffered event queue (flush every 5s or at 10 events) ──
let buffer: Record<string, unknown>[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush() {
  if (buffer.length === 0) return
  sendEvents([...buffer])
  buffer = []
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flush, 5000)
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

/**
 * Track a wallet activity event.
 * Call from any hook or component — non-blocking, batched.
 */
export function trackWalletActivity(wallet: string, event: WalletEvent): void {
  if (!wallet || typeof window === 'undefined') return

  buffer.push({
    wallet: wallet.toLowerCase(),
    session_id: getSessionId(),
    category: event.category,
    action: event.action,
    source: event.source ?? null,
    token_in: event.token_in ?? null,
    token_out: event.token_out ?? null,
    amount_usd: event.amount_usd ?? null,
    success: event.success ?? null,
    error_code: event.error_code ?? null,
    error_msg: event.error_msg ?? null,
    tx_hash: event.tx_hash ?? null,
    order_id: event.order_id ?? null,
    duration_ms: event.duration_ms ?? null,
    metadata: event.metadata ?? {},
  })

  if (buffer.length >= 10) {
    flush()
  } else {
    scheduleFlush()
  }
}
