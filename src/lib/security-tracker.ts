import { getSupabase } from './supabase'

// ══════════════════════════════════════════════════════════
//  SERVER-SIDE SECURITY EVENT TRACKER
//
//  IMPORTANT: This module runs ONLY on the server (API routes).
//  Never import from client components — events are recorded
//  automatically by log-swap and log-quote routes.
//
//  All inserts are fire-and-forget (non-blocking).
// ══════════════════════════════════════════════════════════

export type SecurityEventType =
  | 'oracle_deviation_warn'     // 2-3% price deviation from Chainlink
  | 'oracle_deviation_block'    // ≥3% deviation — swap blocked
  | 'oracle_unavailable'        // No Chainlink feed for token
  | 'oracle_unavailable_block'  // Large swap blocked — no oracle
  | 'quote_failure'             // Aggregator source failed to return quote
  | 'swap_failed'               // On-chain swap transaction reverted
  | 'large_trade'               // Trade above $50k (monitoring only)

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Fire-and-forget insert into security_events (server-side only) */
function recordEvent(
  type: SecurityEventType,
  severity: 'info' | 'warn' | 'critical',
  message: string,
  fields?: {
    wallet?: string
    tokenIn?: string
    tokenOut?: string
    amountUsd?: number
    deviation?: number
    source?: string
    metadata?: Record<string, unknown>
  },
): void {
  const sb = getSupabase()
  if (!sb) return

  // Non-blocking — we don't await this. Wrapped in Promise.resolve()
  // because Supabase returns PromiseLike (no .catch()).
  Promise.resolve(
    sb.from('security_events').insert({
      id: generateId(),
      type,
      severity,
      timestamp: new Date().toISOString(),
      wallet: fields?.wallet ?? null,
      token_in: fields?.tokenIn ?? null,
      token_out: fields?.tokenOut ?? null,
      amount_usd: fields?.amountUsd ?? null,
      deviation: fields?.deviation ?? null,
      source: fields?.source ?? null,
      message,
      metadata: fields?.metadata ?? null,
    })
  ).then(({ error }) => {
    if (error) console.error('[security-tracker] Insert error:', error.message)
  }).catch(() => {
    // Silently fail — monitoring should never break the main flow
  })
}

// ── Convenience helpers (called from API routes) ──────────

export function trackOracleDeviation(params: {
  wallet: string
  tokenIn: string
  tokenOut: string
  deviation: number
  amountUsd: number
  blocked: boolean
}): void {
  const type: SecurityEventType = params.blocked ? 'oracle_deviation_block' : 'oracle_deviation_warn'
  const severity = params.blocked ? 'critical' as const : 'warn' as const
  recordEvent(type, severity,
    `Price deviation ${(params.deviation * 100).toFixed(1)}% on ${params.tokenIn}→${params.tokenOut}${params.blocked ? ' — BLOCKED' : ''}`,
    { wallet: params.wallet, tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountUsd: params.amountUsd, deviation: params.deviation },
  )
}

export function trackOracleUnavailable(params: {
  wallet: string
  tokenIn: string
  tokenOut: string
  amountUsd: number
  blocked: boolean
}): void {
  const type: SecurityEventType = params.blocked ? 'oracle_unavailable_block' : 'oracle_unavailable'
  const severity = params.blocked ? 'critical' as const : 'warn' as const
  recordEvent(type, severity,
    `No Chainlink oracle for ${params.tokenIn} — $${params.amountUsd.toLocaleString()} swap${params.blocked ? ' BLOCKED' : ''}`,
    { wallet: params.wallet, tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountUsd: params.amountUsd },
  )
}

export function trackQuoteFailure(params: {
  source: string
  tokenIn: string
  tokenOut: string
  error?: string
}): void {
  recordEvent('quote_failure', 'info',
    `${params.source} quote failed for ${params.tokenIn}→${params.tokenOut}: ${params.error || 'unknown'}`,
    { source: params.source, tokenIn: params.tokenIn, tokenOut: params.tokenOut, metadata: { error: params.error } },
  )
}

export function trackLargeTrade(params: {
  wallet: string
  tokenIn: string
  tokenOut: string
  amountUsd: number
  source: string
}): void {
  recordEvent('large_trade', 'info',
    `$${params.amountUsd.toLocaleString()} ${params.tokenIn}→${params.tokenOut} via ${params.source}`,
    { wallet: params.wallet, tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountUsd: params.amountUsd, source: params.source },
  )
}

export function trackSwapFailed(params: {
  wallet: string
  tokenIn: string
  tokenOut: string
  amountUsd: number
  source: string
  error?: string
}): void {
  recordEvent('swap_failed', 'warn',
    `Swap failed: ${params.tokenIn}→${params.tokenOut} via ${params.source}${params.error ? ` (${params.error})` : ''}`,
    { wallet: params.wallet, tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountUsd: params.amountUsd, source: params.source, metadata: { error: params.error } },
  )
}
