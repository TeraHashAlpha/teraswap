/**
 * [AUDIT-W7 / W7-L-01] CoW partner-fee zeroing monitor (SERVER-ONLY).
 *
 * `cow.ts` fails SOFT when CoW rejects our `partnerFee` appData schema: it
 * re-quotes WITHOUT the 0.1% fee so quoting never breaks (by design — that
 * fail-soft is deliberate and unchanged). The blind spot it leaves is REVENUE:
 * if a schema rejection becomes systematic (CoW changed/deprecated the appData
 * shape), every CoW fill silently drops the fee and nobody notices.
 *
 * This module counts fee-zeroing events in a rolling window and, once they
 * cross a threshold, raises ONE alert through the existing alert fan-out
 * (Telegram/Email/Discord — the serverless equivalent of the keeper's #201
 * alert path) so an operator can realign the appData schema. It is a metric +
 * alert only; it never changes quoting.
 *
 * Server-only: it imports the KV client and the alert wrapper. `cow.ts` is
 * also bundled client-side (for `submitCowOrder`), so it invokes this via a
 * `typeof window === 'undefined'`-guarded dynamic import — the client bundle
 * never pulls these deps. Every path fails OPEN: monitoring must never break
 * a swap quote.
 */
import { kv } from '@/lib/kv'
import { emitTransitionAlert } from '@/lib/alert-wrapper'

/** Rolling window for the fee-zeroing counter (aligned with the alert window). */
export const COW_FEE_ZERO_WINDOW_SECONDS = 15 * 60
/**
 * Fee-zeroings within the window past which we treat the rate as SYSTEMATIC.
 * A partnerFee-schema rejection is not a per-user/transient fault (it's our
 * appData vs CoW's schema), so a handful in 15 min already means "every CoW
 * quote is dropping the fee". `emitTransitionAlert` dedups repeats downstream,
 * so re-crossing the threshold within the window won't spam.
 */
export const COW_FEE_ZERO_ALERT_THRESHOLD = 5
/** Synthetic source id for the alert fan-out (not a real state-machine source). */
export const COW_FEE_ZERO_SOURCE_ID = 'cowswap-partner-fee'
const COUNTER_KEY = 'teraswap:cow:fee-zero:count'

/**
 * Record one CoW fee-zeroing event and alert if the windowed rate is
 * systematic. Fail-open: any KV/alert error is swallowed (never breaks the
 * quote path that called this).
 *
 * @param status  the CoW HTTP status that triggered the fail-soft (for context)
 * @param reason  the CoW error description (truncated in the alert)
 */
export async function recordCowFeeZeroing(status: number, reason: string): Promise<void> {
  try {
    // INCR + a first-write TTL = a simple fixed-window counter.
    const count = await kv.incr(COUNTER_KEY)
    if (count === 1) await kv.expire(COUNTER_KEY, COW_FEE_ZERO_WINDOW_SECONDS)

    if (count >= COW_FEE_ZERO_ALERT_THRESHOLD) {
      const mins = Math.round(COW_FEE_ZERO_WINDOW_SECONDS / 60)
      // Informational alert — from='active' to='active' is the established
      // non-transition convention (see source-state-machine's kv-failure alert),
      // which also avoids the [Reactivate] operator keyboard.
      await emitTransitionAlert(
        COW_FEE_ZERO_SOURCE_ID,
        'active',
        'active',
        `CoW rejected the partnerFee appData schema — the 0.1% fee is being DROPPED on CoW quotes ` +
          `(fail-soft). ${count} fee-zeroings in the last ${mins} min (last status ${status}). ` +
          `Revenue loss until the appData schema is realigned. Reason: ${String(reason).slice(0, 160)}`,
      )
    }
  } catch (err) {
    // Fail OPEN — monitoring must never break CoW quoting.
    console.warn('[cow-fee-monitor] record failed (ignored):', err instanceof Error ? err.message : err)
  }
}
