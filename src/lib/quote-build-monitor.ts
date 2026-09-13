/**
 * [fix/zerox-quote-hygiene T1] Telemetry for the FIRM swap-build step
 * (adapter.fetchSwapData, invoked from api.ts's fetchSwapFromSource — the
 * "/quote" endpoint on 0x's side, gated on a Swap click or an authenticated
 * /v1/swap POST). Distinct from the existing quotes table (log-quote route),
 * which records the /price META-FAN-OUT (every source, every poll tick) —
 * this answers "attempts vs confirmed per source per day", the ratio 0x's
 * 2026-09-12 warning is actually about.
 *
 * Fire-and-forget, server-only, fail-open: a logging failure must never
 * affect the swap-build result it's describing.
 */
import { getSupabaseLogger } from './supabase'
import { quantizeAmount } from './quote-cache'
import type { AggregatorName } from './constants'

export type QuoteBuildOutcome = 'built' | 'sim-failed' | 'upstream-error' | '429'

export interface QuoteBuildAttempt {
  source: AggregatorName
  chainId: number
  sellToken: string
  buyToken: string
  /** Raw (wei) sell amount — bucketed via quantizeAmount before storage, same
   *  4-sig-fig bucketing the meta-quote cache key already uses, so this table
   *  groups by "trade size class" rather than leaking the exact amount. */
  amount: string
  outcome: QuoteBuildOutcome
  requestId: string
  /** [no PII beyond what log-swap already stores] Optional wallet — only
   *  present when the caller supplied one (the `from` address on a real
   *  swap-build call); never any other identifier. */
  wallet?: string
}

/**
 * Classify a fetchSwapFromSource outcome into the 4-value taxonomy Task 1
 * asks for, reusing the SAME transient/deterministic split
 * swap-build-retry.ts already uses to decide whether to retry:
 *   - no error                                → 'built'
 *   - HTTP 429 (or our own pre-emptive skip, T3) → '429'
 *   - transient (timeout/network/5xx/non-JSON) → 'upstream-error'
 *   - anything else deterministic (no route, insufficient liquidity, 4xx
 *     other than 429, unknown source) → 'sim-failed' — the adapter/upstream
 *     answered but the build could not be completed for THIS request, as
 *     opposed to the upstream being unreachable.
 * [T3] The per-IP 0x-build cap skip (api.ts) reports '429' too — it's the
 * same self-protective throttle, just applied pre-emptively before ever
 * calling 0x, so it belongs in the same bucket as a live 429 response.
 */
export function classifyQuoteBuildOutcome(err: unknown): QuoteBuildOutcome {
  if (err == null) return 'built'
  const msg = (err instanceof Error ? err.message : String(err))
  if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg)) return '429'
  const lower = msg.toLowerCase()
  const isTransient = (
    lower.includes('timeout')
    || lower.includes('failed to fetch')
    || lower.includes('networkerror')
    || lower.includes('network error')
    || lower.includes('econnreset')
    || lower.includes('etimedout')
    || lower.includes('non-json')
    || lower.includes('invalid response')
    || lower.includes('502')
    || lower.includes('503')
    || lower.includes('504')
  )
  return isTransient ? 'upstream-error' : 'sim-failed'
}

/** Fire-and-forget insert into `quote_build_attempts` (see the migration in
 *  supabase/migrations/ for the table + the read-side daily-stats view).
 *  Never throws — a logging failure must never surface as a swap-build error. */
export function recordQuoteBuildAttempt(attempt: QuoteBuildAttempt): void {
  try {
    if (typeof window !== 'undefined') return // server-only telemetry
    const supabase = getSupabaseLogger()
    if (!supabase) return
    // Promise.resolve(...) wraps the Supabase query builder (thenable, not a
    // real Promise) so .then/.catch behave predictably — same pattern as
    // wallet-activity-server.ts's trackWalletAction.
    Promise.resolve(
      supabase.from('quote_build_attempts').insert({
        source: attempt.source,
        chain_id: attempt.chainId,
        sell_token: attempt.sellToken.toLowerCase(),
        buy_token: attempt.buyToken.toLowerCase(),
        amount_bucket: quantizeAmount(attempt.amount),
        outcome: attempt.outcome,
        request_id: attempt.requestId,
        wallet: attempt.wallet?.toLowerCase() ?? null,
      }),
    ).then(({ error }) => {
      if (error) console.warn('[quote-build-monitor] insert failed:', error.message)
    }).catch(() => { /* best-effort — never block or fail the swap-build path */ })
  } catch {
    // silently ignore — telemetry must never throw into the caller
  }
}
