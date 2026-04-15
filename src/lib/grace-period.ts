/**
 * Shared grace period check.
 *
 * Used by the alert wrapper (to suppress non-P0 alerts) and the
 * heartbeat endpoint (to report healthy during maintenance).
 * Single source of truth — no duplicated env parsing.
 */

export function isInGracePeriod(): boolean {
  const graceUntil = process.env.MONITOR_GRACE_UNTIL
  if (!graceUntil) return false

  const graceTs = new Date(graceUntil).getTime()
  if (Number.isNaN(graceTs)) {
    console.warn(`[GRACE] Invalid MONITOR_GRACE_UNTIL value: "${graceUntil}"`)
    return false
  }

  return Date.now() < graceTs
}
