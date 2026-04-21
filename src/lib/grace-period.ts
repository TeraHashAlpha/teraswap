/**
 * Shared grace period check.
 *
 * Two sources:
 *   1. process.env.MONITOR_GRACE_UNTIL — deploy-time, set in .env
 *   2. KV key teraswap:monitor:graceUntil — runtime, set via /grace bot command
 *
 * isInGracePeriod()      — sync, env var only (safe for contexts without KV)
 * isInGracePeriodAsync() — async, checks BOTH sources, uses whichever is further
 *                          in the future. Falls back to env var if KV fails.
 *
 * Used by the alert wrapper (to suppress non-P0 alerts) and the
 * heartbeat endpoint (to report healthy during maintenance).
 */

import { kv } from '@/lib/kv'

/** Parse an ISO timestamp, return epoch ms or 0 if invalid/empty. */
function parseGraceTs(value?: string | null): number {
  if (!value) return 0
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

/**
 * Sync grace period check — reads env var only.
 * Safe for non-async callers. Does NOT check KV.
 */
export function isInGracePeriod(): boolean {
  const graceTs = parseGraceTs(process.env.MONITOR_GRACE_UNTIL)
  if (!graceTs) return false
  return Date.now() < graceTs
}

/**
 * Async grace period check — reads BOTH env var AND KV key.
 * Uses whichever deadline is further in the future. Falls back
 * to env var only if KV read fails (never breaks alerts on KV failure).
 */
export async function isInGracePeriodAsync(): Promise<boolean> {
  const envTs = parseGraceTs(process.env.MONITOR_GRACE_UNTIL)

  let kvTs = 0
  try {
    const kvValue = await kv.get<string>('teraswap:monitor:graceUntil')
    kvTs = parseGraceTs(kvValue)
  } catch {
    // KV failure → fall back to env var only
  }

  const deadline = Math.max(envTs, kvTs)
  if (!deadline) return false
  return Date.now() < deadline
}
