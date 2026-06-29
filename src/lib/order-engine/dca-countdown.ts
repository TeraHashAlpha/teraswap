/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] Pure next-buy countdown math for the DCA Positions dashboard.
 *
 * The keeper runs a DCA chunk once `now >= lastExecution + dcaInterval`. So the next buy is the last
 * fill's `created_at` + interval; with ZERO fills the clock starts at the schedule start (order
 * creation) + interval. At/after the target the keeper executes within ~30s, so we treat it as "due".
 *
 * These are pure (no timers, no Date.now) so the 1s tick is jank-free — the component recomputes the
 * remaining ms from the target each tick (no drift) and only formats here.
 */

/** Timestamp (ms) of the next scheduled buy. `lastFillAtMs` null ⇒ no fills yet ⇒ schedule start. */
export function nextBuyAtMs(opts: {
  lastFillAtMs: number | null
  scheduleStartMs: number
  intervalSec: number
}): number {
  const base = opts.lastFillAtMs ?? opts.scheduleStartMs
  return base + opts.intervalSec * 1000
}

/** True once the target has arrived/passed — the keeper will execute imminently. */
export function isDue(msRemaining: number): boolean {
  return msRemaining <= 0
}

/**
 * Format remaining ms as HH:MM:SS (hours NOT capped at 24, for multi-day intervals). Floors to whole
 * seconds so sub-second ms never cause flicker, and clamps ≤0 to "00:00:00".
 */
export function formatHMS(msRemaining: number): string {
  const totalSec = Math.max(0, Math.floor(msRemaining / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}
