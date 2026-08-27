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
  // [FIX-RETRY-CAP-RESTART] The cap was reached on the executor's OWN InsufficientOutput — the
  // per-chunk floor (max(oracleFloor, scaledMin), TeraSwapOrderExecutorV3.sol:526/:610) could not
  // be met by the built route MAX_CYCLE_FAILURES times in a row. That is not a routing problem:
  // the user's action is to cancel and re-create at a realistic minimum (INC-2026-08-07-001,
  // order ef85438b: a signed floor ~1.59x above market, 516 reverts). The keeper stops trying
  // and records why; it NEVER cancels and never moves funds.
  MIN_OUTPUT_UNREACHABLE: "min_output_unreachable",
}

// ─── Persisted retry state (orders.consecutive_failures / orders.last_attempt_at) ──────────
// [FIX-RETRY-CAP-RESTART] Why these live on the ROW: the consecutive-miss count used to live only
// in executor.js's in-memory Map, so every keeper restart reset it to 0 — order ef85438b reverted
// 516 times under a cap of 8 because the keeper restarted 228 times (each lifetime was shorter
// than the ~62 min the backoff ladder needs to count to 8). The DECISION now reads the row; the
// Map is only a same-process backoff cache. Migration:
// supabase/migrations/20260827190000_add_orders_retry_state.sql (mirrored in
// contracts/order-engine/schema.sql).
export const RETRY_STATE_COLUMNS = Object.freeze(["consecutive_failures", "last_attempt_at"])

/**
 * Read the persisted retry state off a Supabase `orders` row. A pre-migration row (columns
 * absent/null) reads as { count: 0, lastAttempt: null } — identical to the pre-fix behaviour, so
 * the keeper degrades to "count from zero" rather than crashing if the migration lags a deploy.
 * @param {object|null|undefined} dbOrder
 * @returns {{ count: number, lastAttempt: number|null }} count = consecutive misses so far;
 *   lastAttempt = epoch ms of the last miss (null = never / unknown)
 */
export function readPersistedRetryState(dbOrder) {
  const raw = dbOrder ? dbOrder.consecutive_failures : undefined
  const n = typeof raw === "number" ? raw : parseInt(raw, 10)
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  const t = dbOrder && dbOrder.last_attempt_at != null ? Date.parse(dbOrder.last_attempt_at) : NaN
  return { count, lastAttempt: Number.isFinite(t) ? t : null }
}

/**
 * Is the order still inside its exponential backoff window? Pure counterpart of the executor's
 * cycle gate, so the same ladder applies whether the state came from the in-memory cache or —
 * after a restart — from the row.
 * @param {{ count: number, lastAttempt: number|null, nowMs: number, base?: number, max?: number }} p
 */
export function isInBackoffWindow({ count, lastAttempt, nowMs, base = RETRY_BACKOFF_BASE_MS, max = RETRY_BACKOFF_MAX_MS }) {
  const n = Math.max(0, Number(count) || 0)
  if (n === 0 || lastAttempt == null || !Number.isFinite(lastAttempt)) return false
  return nowMs - lastAttempt < backoffMs(n, base, max)
}

/** Fields to spread into a SUCCESS patch: a fill resets the ladder (consecutive, not cumulative). */
export function resetRetryStateFields() {
  return { consecutive_failures: 0 }
}

/**
 * The same patch without the retry-state columns. Used ONLY as the executor's fallback when
 * PostgREST rejects the columns (migration not yet applied): the status transition must still land
 * — an order that should be 'failed' must not sit in 'executing' until the stale-unlock returns it
 * to 'active' and it is retried forever. Never mutates its input.
 * @param {object} patch
 */
export function stripRetryStateColumns(patch) {
  const out = { ...patch }
  for (const col of RETRY_STATE_COLUMNS) delete out[col]
  return out
}

/**
 * Was this revert the executor's OWN floor check (`InsufficientOutput()`)? Deliberately narrow: a
 * ROUTER min-out revert wrapped in SwapFailed ("Too little received", INSUFFICIENT_OUTPUT_AMOUNT…)
 * is slippage on keeper-built calldata — a market/route condition, not the signed floor — and stays
 * on the generic ladder. PriceConditionNotMet is a price trigger, not a floor.
 * @param {{ executorErrorName?: string|null, err?: unknown }} [p]
 */
export function isFloorRevert({ executorErrorName = null, err = null } = {}) {
  if (executorErrorName === "InsufficientOutput") return true
  // Belt and braces: viem's ABI-decoded message names the custom error as `InsufficientOutput()`
  // (with the parens — a router's INSUFFICIENT_OUTPUT_AMOUNT never carries them).
  return /insufficientoutput\(\)/.test(collectErrorText(err))
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
 * @param {{ failures: number, terminal: boolean, reason?: string|null, maxFailures?: number, floorRevert?: boolean }} p
 *   floorRevert — the miss that is being counted was the executor's own InsufficientOutput
 *                 (isFloorRevert). Only changes the NAME of the cap failure, never the cap.
 * @returns {{ action: 'fail'|'retry', reason: string|null, alert: boolean }}
 *   - terminal               → fail now with the specific reason (no alert)
 *   - transient, < cap        → retry (keep active), no alert
 *   - transient, cap reached → fail with min_output_unreachable (floor) or
 *                              no_route_after_retries (anything else) + alert ONCE
 */
export function nextRetryDecision({ failures, terminal, reason = null, maxFailures = MAX_CYCLE_FAILURES, floorRevert = false }) {
  if (terminal) {
    return { action: "fail", reason: reason || null, alert: false }
  }
  if (failures >= maxFailures) {
    return {
      action: "fail",
      reason: floorRevert ? FAILURE_REASON.MIN_OUTPUT_UNREACHABLE : FAILURE_REASON.NO_ROUTE_AFTER_RETRIES,
      alert: true,
    }
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
 * [FIX-RETRY-CAP-RESTART] The persisted-count fields for a ladder patch. `failures` is the NEW
 * consecutive count (including the miss just observed); `nowIso` doubles as last_attempt_at.
 * @param {{ failures: number }|undefined} retryState
 * @param {string} nowIso
 */
function retryStateFields(retryState, nowIso) {
  if (!retryState || !Number.isFinite(Number(retryState.failures))) return {}
  return { consecutive_failures: Math.max(0, Math.floor(Number(retryState.failures))), last_attempt_at: nowIso }
}

/**
 * The exact Supabase `orders` patch for a PERMANENT failure: status='failed' +
 * the specific reason in orders.error. Deliberately omits dca_executed /
 * dca_last_exec so a partially-completed DCA keeps its completed chunks.
 * @param {string} reason a FAILURE_REASON code
 * @param {string} nowIso ISO timestamp
 * @param {{ failures: number }} [retryState] when given, also records the final
 *   consecutive_failures + last_attempt_at on the row (restart-proof count)
 */
export function buildOrderFailurePatch(reason, nowIso, retryState) {
  return { status: "failed", error: reason, updated_at: nowIso, ...retryStateFields(retryState, nowIso) }
}

/**
 * The exact Supabase `orders` patch to UNLOCK an order back to 'active' for a
 * later retry. No reason, no exec-count change.
 * @param {string} nowIso ISO timestamp
 * @param {{ failures: number }} [retryState] when given, persists the new
 *   consecutive_failures + last_attempt_at so the count survives a keeper restart
 */
export function buildOrderActivePatch(nowIso, retryState) {
  return { status: "active", updated_at: nowIso, ...retryStateFields(retryState, nowIso) }
}

/**
 * The WHOLE per-order failure decision as ONE pure function: expiry precedence →
 * transient/permanent classification → retry-or-fail (+ one-shot cap alert), plus
 * the exact Supabase patch to apply and how to update the consecutive-miss count.
 * The keeper (executor.js) just EXECUTES this plan (writes patch / fires alert /
 * updates the in-memory Map), so this full behavior is unit-testable here.
 *
 * [FIX-RETRY-CAP-RESTART] The consecutive-miss base is read from the ROW
 * (dbOrder.consecutive_failures via readPersistedRetryState) so the decision survives a keeper
 * restart. `prevFailures` is still accepted (tests / callers holding a same-process count) but can
 * only RAISE the base — max(row, arg) — never undercut what the row already recorded.
 *
 * @param {{
 *   dbOrder: object,            // the Supabase order row (needs .expiry, .id; reads .consecutive_failures)
 *   err?: unknown,              // thrown viem/RPC error (if any)
 *   swapReason?: string|null,   // decoded SwapFailed inner reason (if any)
 *   executorErrorName?: string|null, // decoded executor custom error (revert-decode.js), e.g. "InsufficientOutput"
 *   noRoute?: boolean,          // true ⇒ "no route this cycle" (always transient)
 *   prevFailures?: number,      // OPTIONAL same-process count; max()'d with the row's persisted count
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
  executorErrorName = null,
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

  // 2. Classify (no route this cycle is always transient). A floor revert is transient too — the
  //    floor may be merely tight — it only changes the NAME the cap failure gets (Task 3).
  const { terminal, reason } = noRoute
    ? { terminal: false, reason: null }
    : classifyFailure({ err, swapReason })
  const floorRevert = !noRoute && isFloorRevert({ executorErrorName, err })

  // 3. Increment the consecutive-miss count and decide. The base is the ROW's persisted count
  //    (restart-proof); an explicit prevFailures can only raise it.
  const persisted = readPersistedRetryState(dbOrder).count
  const base = Math.max(persisted, Math.max(0, Number(prevFailures) || 0))
  const failures = base + 1
  const decision = nextRetryDecision({ failures, terminal, reason, maxFailures, floorRevert })

  if (decision.action === "fail") {
    return {
      kind: "fail",
      patch: buildOrderFailurePatch(decision.reason, nowIso, { failures }),
      reason: decision.reason,
      alert: decision.alert,
      failures,
      clearRetries: true,
    }
  }

  return {
    kind: "retry",
    patch: buildOrderActivePatch(nowIso, { failures }),
    reason: null,
    alert: false,
    failures,
    clearRetries: false,
    backoffMs: backoffMs(failures),
  }
}
