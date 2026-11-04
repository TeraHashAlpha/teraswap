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

import { classifyRpcError, RPC_AUTH } from "./rpc-auth.js"

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

// ─── Miss CAUSE: infra vs order ───────────────────────────────────────────────────────────────
// [fix/infra-failures-dont-burn-orders / ADR-026] Owner decision: a failure caused by OUR
// infrastructure must not count against a user's order. Every miss is therefore tagged with WHY the
// keeper did not fill it, and only an `order` miss advances the ladder (consecutive_failures →
// MAX_CYCLE_FAILURES → 'failed'). INC-2026-10-30-001: a ~20 h RPC allowlist outage would have burnt
// every active order's 8 misses and marked it 'failed' with no_route_after_retries — a lie.
//
//   infra — the keeper itself could not complete the attempt (no tx sent): RPC auth/allowlist
//           (rpc-auth.js classifyRpcError, reused), RPC transport / timeout / 5xx / 429, the keeper
//           paused, Supabase or /api/swap unreachable, the keeper wallet out of gas, a keeper config
//           gap, or a SENT tx whose receipt could not be fetched (the chain decides; the next cycle
//           re-reads it through canExecute).
//   order — the ORDER is why it did not fill: a revert (mined or simulated) attributable to the
//           order (slippage / minOut / floor, allowance, balance, nonce), expiry, or our API
//           answered and there is no acceptable route for this pair.
// Ambiguous: infra ONLY when no tx was sent; any sent-and-reverted tx is order. `order` needs
// POSITIVE evidence; a miss with no evidence at all keeps today's counting (order:unknown) so an
// untouched call site can never silently stop counting.
export const MISS_CAUSE = Object.freeze({ INFRA: "infra", ORDER: "order" })

/** Error-chain metadata for the cause rules below. Never throws; cycle-safe; depth-bounded. */
function collectErrorMeta(err) {
  const names = []
  const statuses = []
  const codes = []
  const parts = []
  const seen = new Set()
  let e = err
  for (let depth = 0; e != null && depth < 10; depth++) {
    if (typeof e !== "object") {
      parts.push(String(e))
      break
    }
    if (seen.has(e)) break
    seen.add(e)
    if (typeof e.name === "string") names.push(e.name)
    if (typeof e.status === "number") statuses.push(e.status)
    if (typeof e.code === "string" || typeof e.code === "number") codes.push(String(e.code))
    for (const k of ["shortMessage", "message", "details", "reason"]) if (typeof e[k] === "string") parts.push(e[k])
    if (Array.isArray(e.metaMessages)) for (const m of e.metaMessages) if (typeof m === "string") parts.push(m)
    e = e.cause
  }
  return { names, statuses, codes, text: parts.join(" \n ").toLowerCase() }
}

const REVERT_NAME = /Revert|ContractFunctionExecutionError|CallExecutionError|EstimateGasExecutionError/
const REVERT_TEXT = /execution reverted|\breverted\b/
// The KEEPER wallet cannot pay for gas (viem InsufficientFundsError / the node's words). Distinct
// from the USER's ERC20 balance ("transfer amount exceeds balance"), which is a revert ⇒ order.
const KEEPER_GAS_TEXT = /insufficient funds for (?:gas|transfer)|exceeds transaction sender account balance|exceeds the balance of the account/
const TRANSPORT_NAME = /^(?:HttpRequestError|TimeoutError|WebSocketRequestError|SocketClosedError|RpcRequestError|InternalRpcError|LimitExceededRpcError|ResourceUnavailableRpcError|UnknownRpcError|TransactionReceiptNotFoundError|WaitForTransactionReceiptTimeoutError)$/
const TRANSPORT_TEXT = /fetch failed|econnrefused|econnreset|etimedout|enotfound|eai_again|ehostunreach|epipe|socket hang up|network error|timed out|timeout|und_err_/
const TRANSPORT_CODE = /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|UND_ERR_|ERR_NETWORK)/

/**
 * Why /api/swap gave the keeper no route this cycle.
 * @param {{ configMissing?: boolean, networkError?: boolean, status?: number|null, misroute?: boolean, missingData?: boolean }} [p]
 * @returns {{ cause: 'infra'|'order', reason: string }}
 *   infra: our API unreachable / 5xx / 429 (swap-api:<status|network>), the keeper's own config
 *          (keeper-config), or the API answering with calldata for the WRONG router (swap-api:misroute);
 *   order: the API answered and there is no acceptable route for this pair (no-route[:<4xx|no-tx-data>]).
 */
export function classifySwapApiMiss({ configMissing = false, networkError = false, status = null, misroute = false, missingData = false } = {}) {
  if (configMissing) return { cause: MISS_CAUSE.INFRA, reason: "keeper-config" }
  if (networkError) return { cause: MISS_CAUSE.INFRA, reason: "swap-api:network" }
  if (misroute) return { cause: MISS_CAUSE.INFRA, reason: "swap-api:misroute" }
  const st = Number(status)
  if (Number.isFinite(st) && st > 0) {
    if (st >= 500 || st === 429) return { cause: MISS_CAUSE.INFRA, reason: `swap-api:${st}` }
    return { cause: MISS_CAUSE.ORDER, reason: `no-route:${st}` }
  }
  if (missingData) return { cause: MISS_CAUSE.ORDER, reason: "no-route:no-tx-data" }
  return { cause: MISS_CAUSE.ORDER, reason: "no-route" }
}

/**
 * The cause table (ADR-026 §2), as ONE pure function. Rules are applied top-down; the first that
 * has positive evidence wins.
 * @param {{
 *   err?: unknown,                 // the thrown viem/RPC/fetch error, if any
 *   swapReason?: string|null,      // decoded SwapFailed inner reason (revert-decode.js)
 *   executorErrorName?: string|null, // decoded executor custom error (InsufficientOutput, …)
 *   noRoute?: boolean,             // fetchSwapRoute gave nothing this cycle
 *   noRouteCause?: { cause: string, reason: string }|null, // from classifySwapApiMiss
 *   minedRevert?: boolean,         // the tx was SENT and its receipt says reverted
 *   txSent?: boolean,              // a tx hash exists for this attempt (writeContract returned)
 *   paused?: string|null,          // the keeper's paused state (rpc-auth.js), if any
 * }} [p]
 * @returns {{ cause: 'infra'|'order', reason: string }}
 */
export function classifyMissCause({
  err = null,
  swapReason = null,
  executorErrorName = null,
  noRoute = false,
  noRouteCause = null,
  minedRevert = false,
  txSent = false,
  paused = null,
} = {}) {
  const infra = (reason) => ({ cause: MISS_CAUSE.INFRA, reason })
  const order = (reason) => ({ cause: MISS_CAUSE.ORDER, reason })
  // 1. The keeper is paused: it must not be attempting at all (executor.js skips the loop); a miss
  //    that still reaches here is ours.
  if (paused) return infra(`paused:${paused}`)
  // 2. Sent and reverted: the chain judged the order. Positive, final evidence.
  if (minedRevert) return order("reverted")
  // 3. No route this cycle: the swap-API miss carries its own verdict.
  if (noRoute) {
    if (noRouteCause && (noRouteCause.cause === MISS_CAUSE.INFRA || noRouteCause.cause === MISS_CAUSE.ORDER)) {
      return { cause: noRouteCause.cause, reason: String(noRouteCause.reason || "no-route") }
    }
    return order("no-route")
  }
  // 4. RPC auth / allowlist — the same classification rpc-auth.js pauses the keeper on. A contract
  //    revert whose text says "not on whitelist" is transient there (never auth) and falls through.
  if (err != null && classifyRpcError(err).kind === RPC_AUTH) return infra("rpc-auth")
  // 5. A tx was sent but its outcome could not be read (receipt timeout / RPC error after send).
  //    The chain decides; the next cycle re-reads it through canExecute. Never counted.
  if (txSent) return infra("receipt-unavailable")
  const meta = err == null ? null : collectErrorMeta(err)
  // 6. The KEEPER wallet is out of gas — ours, not the user's balance.
  if (meta && (meta.names.includes("InsufficientFundsError") || KEEPER_GAS_TEXT.test(meta.text))) return infra("keeper-gas")
  // 7. A permanent cause decoded from the revert (allowance / balance / nonce) — order, by code.
  const permanent = classifyFailure({ err, swapReason })
  if (permanent.terminal) return order(permanent.reason)
  // 8. A decoded executor / router revert — order, named.
  if (executorErrorName) return order(`revert:${executorErrorName}`)
  if (swapReason) return order("revert:swap-failed")
  if (meta && (meta.names.some((n) => REVERT_NAME.test(n)) || REVERT_TEXT.test(meta.text))) return order("revert")
  // 9. The provider / network could not be reached or answered with an HTTP error.
  if (meta && (meta.statuses.length > 0 || meta.names.some((n) => TRANSPORT_NAME.test(n)) || meta.codes.some((c) => TRANSPORT_CODE.test(c)) || TRANSPORT_TEXT.test(meta.text))) {
    return infra("rpc-transport")
  }
  // 10. No evidence at all: keep today's counting (an untouched call site must not stop counting).
  if (meta == null) return order("unknown")
  // 11. Something threw before any tx was sent and nothing above recognised it: the keeper did not
  //     complete the attempt — ours by the ambiguity rule.
  return infra("unclassified")
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

// ─── Degrade to the PREVIOUS state, never to the absence of the guard ──────────────────────────
// [FIX-RETRY-FALLBACK-MIGRATION-LAGS] The FIX-RETRY-CAP-RESTART change removed the in-memory Map
// from the decision (`prevFailures: prev ? prev.count : 0` is gone) so the cap could survive a
// restart. That is right whenever the row can hold a count — but when the migration has NOT been
// applied yet, `readPersistedRetryState` reads an absent column as 0, so EVERY miss computes 1/8
// and the cap never fires at all. A deploy done in the wrong order was therefore strictly WORSE
// than before that change, not equal to it, while the ops alert claimed the opposite.
//
// The rule this restores: a guard degrades to the PREVIOUS state (the process-memory cap), never
// to no guard. The Map is consulted for the decision in EXACTLY ONE state — the persisted columns
// are unavailable — and stops being consulted the moment they are available again.

/**
 * The ops page for the one state where the cap is weaker than it should be. Exported as a constant
 * so the alert text and the test that pins it cannot drift, and so the claim it makes is the
 * behaviour `prevFailuresForDecision` actually implements: the cap DOES still fire within a single
 * process, and it DOES reset on restart.
 */
export const RETRY_STATE_COLUMNS_MISSING_ALERT =
  "orders.consecutive_failures / last_attempt_at are MISSING — apply " +
  "supabase/migrations/20260827190000_add_orders_retry_state.sql. The retry cap has FALLEN BACK to the " +
  "in-memory count: it still fires after MAX_CYCLE_FAILURES consecutive misses within a single keeper " +
  "process, but the count RESETS ON RESTART — the INC-2026-08-07-001 shape (516 reverts under a cap of 8 " +
  "across 228 restarts). It returns to the persisted count automatically, with no restart, on the first " +
  "successful write after the migration is applied."

/**
 * Tracks whether the persisted retry-state columns are usable, for ONE process.
 *
 * DETECTED from what PostgREST actually answers, never guessed: the executor's `patchOrderRow`
 * calls `markMissing()` on the specific HTTP 400 that names one of the two columns, and
 * `markPresent()` when a patch that CARRIED those columns is accepted.
 *
 * It must CLEAR, not latch: applying the migration while the keeper is running has to restore the
 * persisted (restart-proof) semantics on its own — a latch that never cleared would silently keep
 * the weak process-memory cap until someone happened to restart the keeper.
 *
 * Starts OPTIMISTIC (`available = true`): the migration is merged, so the overwhelmingly common
 * state is "present", and the first rejected write flips it within one cycle. The one miss that
 * happens before the flip is counted as 1 either way, so nothing is lost by starting optimistic.
 *
 * A factory rather than module state so tests get an isolated instance per case (executor.js holds
 * exactly one, since the schema is a property of the process's database, not of an order).
 */
export function createRetryStateAvailability() {
  let available = true
  let alertedThisOutage = false
  return {
    /** True while the row can carry the count — i.e. the decision must read the ROW. */
    isAvailable: () => available,
    /**
     * The columns were rejected by the database.
     * @returns {boolean} true if ops should be paged — once per OUTAGE (not once per process), so
     *   a second, later outage after a recovery is not swallowed by a stale one-shot latch.
     */
    markMissing() {
      const shouldAlert = !alertedThisOutage
      available = false
      alertedThisOutage = true
      return shouldAlert
    },
    /** A write carrying the columns was accepted — the migration is applied. Clears the fallback. */
    markPresent() {
      available = true
      alertedThisOutage = false
    },
  }
}

/**
 * The `prevFailures` to hand `planFailureHandling` — the ONE place the Map may enter the decision.
 *
 * Columns AVAILABLE  → 0. `planFailureHandling` takes `max(persisted, prevFailures)`, so 0 means
 *                      the decision provably follows the ROW and the Map cannot raise it.
 * Columns MISSING    → the same-process cached count, i.e. exactly the pre-FIX-RETRY-CAP-RESTART
 *                      behaviour, so the cap still fires at MAX_CYCLE_FAILURES within one process.
 *
 * @param {{ columnsAvailable: boolean, cached?: { count?: unknown } | null }} p
 * @returns {number}
 */
export function prevFailuresForDecision({ columnsAvailable, cached = null } = {}) {
  if (columnsAvailable) return 0
  const n = Number(cached ? cached.count : 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
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
 *   noRouteCause?: object|null, // [ADR-026] classifySwapApiMiss verdict for that no-route
 *   minedRevert?: boolean,      // [ADR-026] the tx was SENT and its receipt says reverted
 *   txSent?: boolean,           // [ADR-026] a tx hash exists for this attempt
 *   paused?: string|null,       // [ADR-026] the keeper's paused state (rpc-auth.js)
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
 *   cause: 'infra'|'order',     // [ADR-026] why the keeper did not fill (classifyMissCause)
 *   causeReason: string,        // [ADR-026] short, secret-free label for that cause
 * }}
 */
export function planFailureHandling({
  dbOrder,
  err = null,
  swapReason = null,
  executorErrorName = null,
  noRoute = false,
  noRouteCause = null,
  minedRevert = false,
  txSent = false,
  paused = null,
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
      cause: MISS_CAUSE.ORDER,
      causeReason: FAILURE_REASON.EXPIRED,
    }
  }

  // 1b. [ADR-026] Tag the miss with its cause (infra vs order). Every plan below carries it.
  const miss = classifyMissCause({ err, swapReason, executorErrorName, noRoute, noRouteCause, minedRevert, txSent, paused })

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
      cause: miss.cause,
      causeReason: miss.reason,
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
    cause: miss.cause,
    causeReason: miss.reason,
  }
}
