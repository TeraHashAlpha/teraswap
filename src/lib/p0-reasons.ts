/**
 * Shared P0 (critical) reason detection.
 *
 * Used by both the state machine (to block auto-recovery) and the
 * alert wrapper (to bypass grace period and dedup). A single source
 * of truth prevents the prefix-match vs exact-match divergence that
 * caused C-01.
 *
 * Reasons are matched via startsWith — callers may append descriptive
 * suffixes (e.g., 'tls-fingerprint-change: Issuer changed from X to Y').
 */

export const P0_REASONS = [
  'kill-switch-triggered',
  'tls-fingerprint-change',
  'dns-record-change',
  'kv-store-failure',
  'quorum-correlated-anomaly',
  'operator-lock',
] as const

export type P0Reason = (typeof P0_REASONS)[number]

export function isP0Reason(reason?: string | null): boolean {
  if (!reason) return false
  return P0_REASONS.some(prefix => reason.startsWith(prefix))
}
