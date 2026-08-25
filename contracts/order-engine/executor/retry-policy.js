// retry-policy.js — pure failure-classification + retry-decision helpers for the
// keeper. Decides whether an execution miss is TRANSIENT (keep the order active,
// retry a later cycle with backoff) or PERMANENT (mark it 'failed' with a
// SPECIFIC reason), and builds the exact Supabase patch to persist.
//
// Why this module exists: executor.js auto-runs main() on import, so this logic
// is factored out here (side-effect-free) to be unit-tested directly — same
// pattern as record-execution.js / swap-route.js / revert-decode.js.
//
// Root cause this fixes: the old executor counted EVERY thrown error toward a
// single MAX_RETRIES=3 cap and marked the order 'failed' with NO reason. So a
// routable DCA that merely hit a transient "no route this cycle" (or an API
// hiccup / momentary slippage) got PERMANENTLY failed after ~35s and shown as
// the generic "swap route unavailable" — too fragile for a recurring DCA, and
// the generic message masked the real cause (e.g. an expiry). This module
// separates transient from permanent and surfaces the actual terminal reason.

// ─── Canonical terminal reason codes ──────────────────────────────────────
// These exact snake_case strings are the shared contract with the UI: the
// keeper writes them to orders.error and src/lib/order-engine/failed-reason.ts
// maps them to a human message. Keep the two in sync.
export const FAILURE_REASON = {
  EXPIRED: "expired",
  NO_ROUTE_AFTER_RETRIES: "no_route_after_retries",
  INSUFFICIENT_BALANCE: "insufficient_balance",
  INSUFFICIENT_ALLOWANCE: "insufficient_allowance",
  NONCE_INVALID: "nonce_invalid",
  CANCELLED: "cancelled",
}

// Max CONSECUTIVE transient cycle-failures for ONE order before we give up and
// mark it failed (no_route_after_retries) + ALERT. A recurring DCA gets far more
// chances than the old MAX_RETRIES=3 fast cap. Override via MAX_CYCLE_FAILURES.
// [KEEPER-ENV-ORDER] Module-scope env reads here (and below) resolve correctly
// because every entrypoint imports ./env.js FIRST — pinned by env-order.test.mjs.
export const MAX_CYCLE_FAILURES = Math.max(
  1,
  parseInt(process.env.MAX_CYCLE_FAILURES || "8", 10) || 8,
)

// Backoff spreads transient retries ACROSS cycles instead of hammering every
// poll. Base 30s, doubling, capped at 30min — so a transient route/API outage
// has time to recover before the cap is reached. Overridable via env.
export const RETRY_BACKOFF_BASE_MS = Math.max(
  1_000,
  parseInt(process.env.RETRY_BACKOFF_BASE_MS || "30000", 10) || 30_000,
)
export const RETRY_BACKOFF_MAX_MS = Math.max(
  RETRY_BACKOFF_BASE_MS,
  parseInt(process.env.RETRY_BACKOFF_MAX_MS || "1800000", 10) || 1_800_000,
)

// Permanent-failure signatures. Each entry: a reason code + the regexes that, if
// they match the (lowercased) error text, mean retrying CANNOT help. Ordered
// most-specific-first; the first match wins. Anything that matches NOTHING here
// is treated as transient (safer to retry-then-fail-honestly than to guess).
const PERMANENT_SIGNATURES = [
  {
    reason: FAILURE_REASON.INSUFFICIENT_ALLOWANCE,
    patterns: [
      /exceeds allowance/,
      /insufficient allowance/,
      /allowanceexpired/,
      /insufficientallowance/,
    ],
  },
  {
    reason: FAILURE_REASON.INSUFFICIENT_BALANCE,
    patterns: [/exceeds balance/, /insufficient balance/, /insufficientbalance/],
  },
  {
    reason: FAILURE_REASON.NONCE_INVALID,
    patterns: [
      /invalidnonce/,
      /invalid nonce/,
      /nonce already used/,
      /noncealreadyused/,
      /already executed/,
      /orderalreadyexecuted/,
    ],
  },
]

/**
 * Flatten a viem-style error (or string) into ONE lowercase string for matching.
 * Walks message / shortMessage / details / metaMessages and the .cause chain.
 * Never throws; tolerant of cycles, null, and plain strings.
 * @param {unknown} err
 * @returns {string}
 */
export function collectErrorText(err) {
  if (err == null) return ""
  if (typeof err === "string") return err.toLowerCase()
  const parts = []
  const seen = new Set()
  let e = err
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e)
    for (const k of ["shortMessage", "message", "details", "reason"]) {
      if (typeof e[k] === "string") parts.push(e[k])
    }
    if (Array.isArray(e.metaMessages)) {
      for (const m of e.metaMessages) if (typeof m === "string") parts.push(m)
    }
    e = e.cause
  }
  return parts.join(" ").toLowerCase()
}

/**
 * Classify an execution failure as terminal (permanent) or transient.
 * @param {{ err?: unknown, swapReason?: string|null }} input
 *   err        — the thrown viem/RPC error (if any)
 *   swapReason — decoded SwapFailed inner reason from revert-decode.js (if any)
 * @returns {{ terminal: boolean, reason: string|null }}
 *   terminal=true  → mark failed NOW with `reason`
 *   terminal=false → transient; retry a later cycle (reason is null)
 */
export function classifyFailure({ err, swapReason } = {}) {
  const text = `${swapReason ? String(swapReason) : ""} ${collectErrorText(err)}`.toLowerCase()
  for (const sig of PERMANENT_SIGNATURES) {
    if (sig.patterns.some((re) => re.test(text))) {
      return { terminal: true, reason: sig.reason }
    }
  }
  return { terminal: false, reason: null }
}

/**
 * Decide what to do after a failure, given how many CONSECUTIVE cycle-failures
 * this order has now accumulated.
 * @param {{ failures: number, terminal: boolean, reason?: string|null, maxFailures?: number }} p
 * @returns {{ action: 'fail'|'retry', reason: string|null, alert: boolean }}
 *   - terminal               → fail now with the specific reason (no alert)
 *   - transient, < cap        → retry (keep active), no alert
 *   - transient, cap reached → fail with no_route_after_retries + alert ONCE
 */
export function nextRetryDecision({ failures, terminal, reason = null, maxFailures = MAX_CYCLE_FAILURES }) {
  if (terminal) {
    return { action: "fail", reason: reason || null, alert: false }
  }
  if (failures >= maxFailures) {
    return { action: "fail", reason: FAILURE_REASON.NO_ROUTE_AFTER_RETRIES, alert: true }
  }
  return { action: "retry", reason: null, alert: false }
}

/**
 * Exponential backoff (ms) for the Nth consecutive miss, capped.
 * @param {number} count 1-based consecutive-failure count
 * @param {number} [base] base interval (ms)
 * @param {number} [max] ceiling (ms)
 */
export function backoffMs(count, base = RETRY_BACKOFF_BASE_MS, max = RETRY_BACKOFF_MAX_MS) {
  const n = Math.max(1, Number(count) || 1)
  const grown = base * Math.pow(2, n - 1)
  return Math.min(grown, max)
}

/**
 * The exact Supabase `orders` patch for a PERMANENT failure: status='failed' +
 * the specific reason in orders.error. Deliberately omits dca_executed /
 * dca_last_exec so a partially-completed DCA keeps its completed chunks.
 * @param {string} reason a FAILURE_REASON code
 * @param {string} nowIso ISO timestamp
 */
export function buildOrderFailurePatch(reason, nowIso) {
  return { status: "failed", error: reason, updated_at: nowIso }
}

/**
 * The exact Supabase `orders` patch to UNLOCK an order back to 'active' for a
 * later retry. No reason, no exec-count change.
 * @param {string} nowIso ISO timestamp
 */
export function buildOrderActivePatch(nowIso) {
  return { status: "active", updated_at: nowIso }
}

/**
 * The WHOLE per-order failure decision as ONE pure function: expiry precedence →
 * transient/permanent classification → retry-or-fail (+ one-shot cap alert), plus
 * the exact Supabase patch to apply and how to update the consecutive-miss count.
 * The keeper (executor.js) just EXECUTES this plan (writes patch / fires alert /
 * updates the in-memory Map), so this full behavior is unit-testable here.
 *
 * @param {{
 *   dbOrder: object,            // the Supabase order row (needs .expiry, .id)
 *   err?: unknown,              // thrown viem/RPC error (if any)
 *   swapReason?: string|null,   // decoded SwapFailed inner reason (if any)
 *   noRoute?: boolean,          // true ⇒ "no route this cycle" (always transient)
 *   prevFailures?: number,      // consecutive misses BEFORE this one
 *   nowSec: number,             // current unix seconds (for expiry compare)
 *   nowIso: string,             // current ISO timestamp (for the patch)
 *   maxFailures?: number,
 * }} p
 * @returns {{
 *   kind: 'expired'|'fail'|'retry',
 *   patch: object,              // the Supabase orders patch to PATCH
 *   reason: string|null,        // terminal reason code (null on retry)
 *   alert: boolean,             // fire the one-shot #201 alert before failing
 *   failures: number,           // new consecutive-miss count
 *   clearRetries: boolean,      // true ⇒ drop this order from the retry Map
 *   backoffMs?: number,         // wait before the next retry (retry kind only)
 * }}
 */
export function planFailureHandling({
  dbOrder,
  err = null,
  swapReason = null,
  noRoute = false,
  prevFailures = 0,
  nowSec,
  nowIso,
  maxFailures = MAX_CYCLE_FAILURES,
} = {}) {
  // 1. Expiry precedence — an expired order can never make progress, so it is
  //    recorded as 'expired' (its own status), NEVER masked as a route 'failed'.
  const expiryTs = Number(dbOrder?.expiry)
  if (Number.isFinite(expiryTs) && expiryTs > 0 && Number.isFinite(nowSec) && expiryTs < nowSec) {
    return {
      kind: "expired",
      patch: { status: "expired", updated_at: nowIso },
      reason: FAILURE_REASON.EXPIRED,
      alert: false,
      failures: 0,
      clearRetries: true,
    }
  }

  // 2. Classify (no route this cycle is always transient).
  const { terminal, reason } = noRoute
    ? { terminal: false, reason: null }
    : classifyFailure({ err, swapReason })

  // 3. Increment the consecutive-miss count and decide.
  const failures = Math.max(0, Number(prevFailures) || 0) + 1
  const decision = nextRetryDecision({ failures, terminal, reason, maxFailures })

  if (decision.action === "fail") {
    return {
      kind: "fail",
      patch: buildOrderFailurePatch(decision.reason, nowIso),
      reason: decision.reason,
      alert: decision.alert,
      failures,
      clearRetries: true,
    }
  }

  return {
    kind: "retry",
    patch: buildOrderActivePatch(nowIso),
    reason: null,
    alert: false,
    failures,
    clearRetries: false,
    backoffMs: backoffMs(failures),
  }
}
