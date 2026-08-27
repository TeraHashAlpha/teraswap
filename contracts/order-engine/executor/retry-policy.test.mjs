// Tests for retry-policy.js — the pure failure-classification + retry-decision
// helpers that decide whether a keeper execution miss is TRANSIENT (keep the
// order active, retry a later cycle with backoff) or PERMANENT (mark it failed
// with a SPECIFIC reason), and build the exact orders patch to persist.
//
// Pattern mirrors record-execution.test.mjs / revert-decode.test.mjs: import the
// pure functions, assert on returned values. No network, no Supabase, no provider
// — so executor.js (which auto-runs main() on import) is never imported.
//
// Root cause this fixes: the old executor counted EVERY thrown error toward a
// single MAX_RETRIES=3 cap and marked the order 'failed' with NO reason — so a
// routable DCA that merely hit a transient "no route this cycle" got permanently
// failed and shown as the generic "swap route unavailable", masking the real cause.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  FAILURE_REASON,
  MAX_CYCLE_FAILURES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  RETRY_STATE_COLUMNS,
  collectErrorText,
  classifyFailure,
  nextRetryDecision,
  backoffMs,
  buildOrderFailurePatch,
  buildOrderActivePatch,
  planFailureHandling,
  readPersistedRetryState,
  isInBackoffWindow,
  resetRetryStateFields,
  stripRetryStateColumns,
  isFloorRevert,
} from "./retry-policy.js"

const NOW = "2026-06-30T12:00:00.000Z"
const NOW_SEC = 1782820800 // arbitrary fixed "now" in seconds

// A minimal DCA order row that is NOT expired (expiry far in the future).
function dcaOrder(over = {}) {
  return {
    id: "abcd1234-0000-0000-0000-000000000000",
    order_type: "dca",
    expiry: NOW_SEC + 86_400, // +1 day
    dca_executed: 1,
    dca_total: 3,
    ...over,
  }
}

describe("FAILURE_REASON — canonical terminal reason codes (shared with the UI)", () => {
  test("exposes the exact snake_case codes the UI's failedOrderReason maps", () => {
    assert.equal(FAILURE_REASON.EXPIRED, "expired")
    assert.equal(FAILURE_REASON.NO_ROUTE_AFTER_RETRIES, "no_route_after_retries")
    assert.equal(FAILURE_REASON.INSUFFICIENT_BALANCE, "insufficient_balance")
    assert.equal(FAILURE_REASON.INSUFFICIENT_ALLOWANCE, "insufficient_allowance")
    assert.equal(FAILURE_REASON.NONCE_INVALID, "nonce_invalid")
    assert.equal(FAILURE_REASON.CANCELLED, "cancelled")
    // [FIX-RETRY-CAP-RESTART] A floor the market can never clear is NOT a routing problem — the
    // user's action differs (cancel + re-create at a realistic minimum), so it gets its own code.
    assert.equal(FAILURE_REASON.MIN_OUTPUT_UNREACHABLE, "min_output_unreachable")
  })

  // [FIX-RETRY-CAP-RESTART] Keeper-side half of the sync contract with the UI. The app-side half
  // (src/lib/order-engine/failed-reason.test.ts) imports this module directly; this half parses the
  // TS source so the keeper suite — which runs in its own CI workflow — ALSO fails when the two
  // drift, whichever side is edited.
  test("every FAILURE_REASON code has a label key in src/lib/order-engine/failed-reason.ts, and vice-versa", () => {
    const src = readFileSync(new URL("../../../src/lib/order-engine/failed-reason.ts", import.meta.url), "utf-8")
    const start = src.indexOf("export const FAILURE_REASON_LABELS")
    assert.ok(start >= 0, "FAILURE_REASON_LABELS must exist in failed-reason.ts")
    const block = src.slice(start, src.indexOf("\n}\n", start))
    // Object-literal keys sit at exactly 2-space indent: `  code:` (value on the same or next line).
    const uiKeys = [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort()
    const keeperCodes = Object.values(FAILURE_REASON).sort()
    assert.ok(uiKeys.length > 0, "parser found no label keys — the file's formatting changed; fix the parser, not the contract")
    assert.deepEqual(uiKeys, keeperCodes, "FAILURE_REASON (keeper) and FAILURE_REASON_LABELS (UI) have diverged")
  })
})

describe("collectErrorText — flattens a viem error chain into one lowercase string", () => {
  test("walks message + shortMessage + details + the .cause chain", () => {
    const err = {
      shortMessage: "Execution reverted",
      message: "outer",
      details: "DETAIL",
      cause: { message: "ERC20: transfer amount exceeds ALLOWANCE" },
    }
    const text = collectErrorText(err)
    assert.match(text, /execution reverted/)
    assert.match(text, /detail/)
    assert.match(text, /exceeds allowance/)
    assert.equal(text, text.toLowerCase(), "must be lowercased")
  })

  test("tolerates a plain string, null, and cycles without throwing", () => {
    assert.equal(collectErrorText("Nonce already USED"), "nonce already used")
    assert.equal(collectErrorText(null), "")
    const a = { message: "a" }
    a.cause = a // self-cycle
    assert.doesNotThrow(() => collectErrorText(a))
  })
})

describe("classifyFailure — terminal (permanent) vs transient", () => {
  test("ERC20 'transfer amount exceeds allowance' → terminal insufficient_allowance", () => {
    const r = classifyFailure({ err: new Error("execution reverted: ERC20: transfer amount exceeds allowance") })
    assert.deepEqual(r, { terminal: true, reason: FAILURE_REASON.INSUFFICIENT_ALLOWANCE })
  })

  test("Permit2 'AllowanceExpired' → terminal insufficient_allowance", () => {
    const r = classifyFailure({ err: { message: "AllowanceExpired(uint256 deadline)" } })
    assert.equal(r.terminal, true)
    assert.equal(r.reason, FAILURE_REASON.INSUFFICIENT_ALLOWANCE)
  })

  test("ERC20 'transfer amount exceeds balance' → terminal insufficient_balance", () => {
    const r = classifyFailure({ swapReason: "Error(string): ERC20: transfer amount exceeds balance" })
    assert.deepEqual(r, { terminal: true, reason: FAILURE_REASON.INSUFFICIENT_BALANCE })
  })

  test("nonce reuse / already-executed → terminal nonce_invalid", () => {
    assert.equal(classifyFailure({ err: new Error("InvalidNonce()") }).reason, FAILURE_REASON.NONCE_INVALID)
    assert.equal(classifyFailure({ swapReason: "order already executed" }).reason, FAILURE_REASON.NONCE_INVALID)
  })

  test("a momentary slippage revert is TRANSIENT (retry next cycle, do not fail)", () => {
    const r = classifyFailure({ swapReason: "Error(string): Too little received" })
    assert.deepEqual(r, { terminal: false, reason: null })
  })

  test("an RPC/timeout error is TRANSIENT", () => {
    const r = classifyFailure({ err: new Error("HTTP request failed: 503 Service Unavailable") })
    assert.deepEqual(r, { terminal: false, reason: null })
  })

  test("an empty-revert SwapFailed (router rejected calldata) is TRANSIENT — may be a routing blip", () => {
    const r = classifyFailure({ swapReason: "empty revert — the router rejected the calldata" })
    assert.equal(r.terminal, false)
  })

  test("an ambiguous TRANSFER_FROM_FAILED is TRANSIENT (never guess balance vs allowance)", () => {
    const r = classifyFailure({ swapReason: "Error(string): TRANSFER_FROM_FAILED" })
    assert.deepEqual(r, { terminal: false, reason: null })
  })

  test("no input at all → transient", () => {
    assert.deepEqual(classifyFailure({}), { terminal: false, reason: null })
  })
})

describe("nextRetryDecision — fail-now vs retry-later, and the one-shot cap alert", () => {
  test("a terminal failure fails immediately with its specific reason, no alert", () => {
    const d = nextRetryDecision({ failures: 1, terminal: true, reason: FAILURE_REASON.INSUFFICIENT_BALANCE })
    assert.deepEqual(d, { action: "fail", reason: FAILURE_REASON.INSUFFICIENT_BALANCE, alert: false })
  })

  test("a transient miss below the cap retries (stays active), no alert", () => {
    const d = nextRetryDecision({ failures: 1, terminal: false, reason: null, maxFailures: 3 })
    assert.deepEqual(d, { action: "retry", reason: null, alert: false })
  })

  test("the Nth consecutive transient miss (cap reached) fails with no_route_after_retries AND alerts once", () => {
    const d = nextRetryDecision({ failures: 3, terminal: false, reason: null, maxFailures: 3 })
    assert.deepEqual(d, { action: "fail", reason: FAILURE_REASON.NO_ROUTE_AFTER_RETRIES, alert: true })
  })

  test("just under the cap still retries; never alerts before the cap", () => {
    const d = nextRetryDecision({ failures: 2, terminal: false, reason: null, maxFailures: 3 })
    assert.equal(d.action, "retry")
    assert.equal(d.alert, false)
  })

  test("defaults to MAX_CYCLE_FAILURES when maxFailures is omitted", () => {
    assert.equal(nextRetryDecision({ failures: MAX_CYCLE_FAILURES, terminal: false }).action, "fail")
    assert.equal(nextRetryDecision({ failures: MAX_CYCLE_FAILURES - 1, terminal: false }).action, "retry")
  })

  // [FIX-RETRY-CAP-RESTART] Task 3 — name the state honestly.
  test("cap reached on a FLOOR revert fails with min_output_unreachable (not no_route_after_retries) + alert", () => {
    const d = nextRetryDecision({ failures: 3, terminal: false, reason: null, maxFailures: 3, floorRevert: true })
    assert.deepEqual(d, { action: "fail", reason: FAILURE_REASON.MIN_OUTPUT_UNREACHABLE, alert: true })
  })

  test("a floor revert below the cap still retries — the floor may be merely tight, not unreachable", () => {
    const d = nextRetryDecision({ failures: 2, terminal: false, reason: null, maxFailures: 3, floorRevert: true })
    assert.deepEqual(d, { action: "retry", reason: null, alert: false })
  })

  test("a terminal cause still wins over the floor flag (never mask a permanent reason)", () => {
    const d = nextRetryDecision({ failures: 9, terminal: true, reason: FAILURE_REASON.NONCE_INVALID, floorRevert: true })
    assert.deepEqual(d, { action: "fail", reason: FAILURE_REASON.NONCE_INVALID, alert: false })
  })
})

describe("isFloorRevert — the executor's OWN InsufficientOutput is the signed/oracle floor, nothing else", () => {
  test("executorErrorName 'InsufficientOutput' ⇒ floor revert", () => {
    assert.equal(isFloorRevert({ executorErrorName: "InsufficientOutput" }), true)
  })

  test("the ABI-decoded error text 'InsufficientOutput()' also counts (belt and braces when the selector was not decoded)", () => {
    assert.equal(isFloorRevert({ err: new Error('The contract function "executeOrder" reverted.\n\nError: InsufficientOutput()') }), true)
  })

  test("a ROUTER min-out revert inside SwapFailed is NOT the signed floor (that is slippage on keeper-built calldata)", () => {
    assert.equal(isFloorRevert({ err: new Error("SwapFailed: UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT") }), false)
    assert.equal(isFloorRevert({ err: new Error("Error(string): Too little received") }), false)
  })

  test("PriceConditionNotMet, RPC errors, and nothing at all are not floor reverts", () => {
    assert.equal(isFloorRevert({ executorErrorName: "PriceConditionNotMet" }), false)
    assert.equal(isFloorRevert({ err: new Error("HTTP request failed: 503") }), false)
    assert.equal(isFloorRevert({}), false)
    assert.equal(isFloorRevert(), false)
  })
})

describe("backoffMs — exponential growth, capped (spreads transient retries across cycles)", () => {
  test("first attempt waits the base interval", () => {
    assert.equal(backoffMs(1, 30_000, 1_800_000), 30_000)
  })

  test("doubles each consecutive miss", () => {
    assert.equal(backoffMs(2, 30_000, 1_800_000), 60_000)
    assert.equal(backoffMs(3, 30_000, 1_800_000), 120_000)
    assert.equal(backoffMs(4, 30_000, 1_800_000), 240_000)
  })

  test("never exceeds the cap (so we still retry roughly once per long cycle)", () => {
    assert.equal(backoffMs(99, 30_000, 1_800_000), 1_800_000)
  })

  test("uses the module defaults when base/max omitted", () => {
    assert.equal(backoffMs(1), RETRY_BACKOFF_BASE_MS)
    assert.ok(backoffMs(99) <= RETRY_BACKOFF_MAX_MS)
  })
})

describe("buildOrderFailurePatch / buildOrderActivePatch — exact Supabase patches", () => {
  test("failure patch persists status='failed' + the SPECIFIC reason in orders.error", () => {
    const patch = buildOrderFailurePatch(FAILURE_REASON.NO_ROUTE_AFTER_RETRIES, NOW)
    assert.deepEqual(patch, {
      status: "failed",
      error: "no_route_after_retries",
      updated_at: NOW,
    })
  })

  test("failure patch NEVER touches dca_executed — partial DCA progress is preserved", () => {
    const patch = buildOrderFailurePatch(FAILURE_REASON.INSUFFICIENT_BALANCE, NOW)
    assert.equal("dca_executed" in patch, false)
    assert.equal("dca_last_exec" in patch, false)
  })

  test("active patch just unlocks the order for a later retry (no reason, no exec change)", () => {
    const patch = buildOrderActivePatch(NOW)
    assert.deepEqual(patch, { status: "active", updated_at: NOW })
    assert.equal("dca_executed" in patch, false)
  })

  // [FIX-RETRY-CAP-RESTART] The count now lives on the row. Both ladder patches carry it, so a
  // restarted keeper reads exactly where the previous process left off.
  test("active patch WITH retry state persists consecutive_failures + last_attempt_at (the restart-proof count)", () => {
    const patch = buildOrderActivePatch(NOW, { failures: 3 })
    assert.deepEqual(patch, { status: "active", updated_at: NOW, consecutive_failures: 3, last_attempt_at: NOW })
  })

  test("failure patch WITH retry state records the final count alongside the reason", () => {
    const patch = buildOrderFailurePatch(FAILURE_REASON.MIN_OUTPUT_UNREACHABLE, NOW, { failures: 8 })
    assert.deepEqual(patch, {
      status: "failed",
      error: "min_output_unreachable",
      updated_at: NOW,
      consecutive_failures: 8,
      last_attempt_at: NOW,
    })
  })
})

describe("readPersistedRetryState — the row IS the counter", () => {
  test("a pre-migration row (no columns) reads as zero failures, no last attempt", () => {
    assert.deepEqual(readPersistedRetryState({ id: "x" }), { count: 0, lastAttempt: null })
    assert.deepEqual(readPersistedRetryState(null), { count: 0, lastAttempt: null })
  })

  test("reads consecutive_failures and last_attempt_at (ISO → epoch ms)", () => {
    const s = readPersistedRetryState({ consecutive_failures: 5, last_attempt_at: NOW })
    assert.equal(s.count, 5)
    assert.equal(s.lastAttempt, Date.parse(NOW))
  })

  test("tolerates a numeric string (PostgREST can serialise ints as strings) and garbage", () => {
    assert.equal(readPersistedRetryState({ consecutive_failures: "7" }).count, 7)
    assert.equal(readPersistedRetryState({ consecutive_failures: "seven" }).count, 0)
    assert.equal(readPersistedRetryState({ consecutive_failures: -3 }).count, 0)
    assert.equal(readPersistedRetryState({ last_attempt_at: "not a date" }).lastAttempt, null)
    assert.equal(readPersistedRetryState({ last_attempt_at: null }).lastAttempt, null)
  })
})

describe("isInBackoffWindow — persisted backoff so a restart cannot skip the ladder", () => {
  const T0 = Date.parse(NOW)

  test("zero failures ⇒ never in backoff (a fresh or just-filled order is attempted immediately)", () => {
    assert.equal(isInBackoffWindow({ count: 0, lastAttempt: T0, nowMs: T0 + 1 }), false)
  })

  test("no last attempt ⇒ never in backoff (nothing to back off from)", () => {
    assert.equal(isInBackoffWindow({ count: 3, lastAttempt: null, nowMs: T0 }), false)
  })

  test("inside the exponential window ⇒ skip; at/after it ⇒ attempt", () => {
    const base = 30_000
    assert.equal(isInBackoffWindow({ count: 2, lastAttempt: T0, nowMs: T0 + 2 * base - 1, base, max: 1_800_000 }), true)
    assert.equal(isInBackoffWindow({ count: 2, lastAttempt: T0, nowMs: T0 + 2 * base, base, max: 1_800_000 }), false)
  })

  test("uses the same backoffMs ladder as the in-memory cache did", () => {
    for (const n of [1, 2, 3, 7, 40]) {
      const w = backoffMs(n)
      assert.equal(isInBackoffWindow({ count: n, lastAttempt: T0, nowMs: T0 + w - 1 }), true)
      assert.equal(isInBackoffWindow({ count: n, lastAttempt: T0, nowMs: T0 + w }), false)
    }
  })
})

describe("resetRetryStateFields / stripRetryStateColumns / RETRY_STATE_COLUMNS", () => {
  test("a successful fill resets the persisted count to 0 (consecutive, not cumulative)", () => {
    assert.deepEqual(resetRetryStateFields(), { consecutive_failures: 0 })
  })

  test("the column list names exactly the two migration columns", () => {
    assert.deepEqual([...RETRY_STATE_COLUMNS].sort(), ["consecutive_failures", "last_attempt_at"])
  })

  test("strip removes only the retry-state columns and never mutates the input", () => {
    const patch = { status: "failed", error: "x", updated_at: NOW, consecutive_failures: 8, last_attempt_at: NOW }
    const stripped = stripRetryStateColumns(patch)
    assert.deepEqual(stripped, { status: "failed", error: "x", updated_at: NOW })
    assert.equal("consecutive_failures" in patch, true, "input must not be mutated")
    assert.deepEqual(stripRetryStateColumns({ status: "active" }), { status: "active" })
  })
})

describe("planFailureHandling — the whole per-order decision (expiry → classify → retry/fail)", () => {
  test("EXPIRED wins over everything: an expired order is recorded 'expired', never a route 'failed'", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder({ expiry: NOW_SEC - 1 }),
      noRoute: true,
      prevFailures: 5,
      nowSec: NOW_SEC,
      nowIso: NOW,
    })
    assert.equal(plan.kind, "expired")
    assert.deepEqual(plan.patch, { status: "expired", updated_at: NOW })
    assert.equal(plan.alert, false)
    assert.equal(plan.clearRetries, true)
    assert.equal("dca_executed" in plan.patch, false)
  })

  test("expiry precedence holds even when the error looks permanent (don't mask an expiry)", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder({ expiry: NOW_SEC - 1 }),
      err: new Error("ERC20: transfer amount exceeds allowance"),
      prevFailures: 0,
      nowSec: NOW_SEC,
      nowIso: NOW,
    })
    assert.equal(plan.kind, "expired")
  })

  test("PERMANENT failure (allowance) → fail NOW with the specific reason, no alert", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder(),
      err: new Error("ERC20: transfer amount exceeds allowance"),
      prevFailures: 0,
      nowSec: NOW_SEC,
      nowIso: NOW,
    })
    assert.equal(plan.kind, "fail")
    assert.equal(plan.patch.status, "failed")
    assert.equal(plan.patch.error, FAILURE_REASON.INSUFFICIENT_ALLOWANCE)
    assert.equal(plan.alert, false)
    assert.equal(plan.clearRetries, true)
  })

  test("TRANSIENT miss below the cap → retry: status back to 'active', count incremented, no alert", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder(),
      noRoute: true,
      prevFailures: 2,
      nowSec: NOW_SEC,
      nowIso: NOW,
      maxFailures: 8,
    })
    assert.equal(plan.kind, "retry")
    // [FIX-RETRY-CAP-RESTART] The retry patch now carries the count so it survives a restart.
    assert.deepEqual(plan.patch, { status: "active", updated_at: NOW, consecutive_failures: 3, last_attempt_at: NOW })
    assert.equal(plan.failures, 3)
    assert.equal(plan.clearRetries, false)
    assert.equal(plan.alert, false)
    assert.ok(plan.backoffMs > 0)
  })

  // [FIX-RETRY-CAP-RESTART] The DECISION reads the row's persisted count.
  test("prevFailures omitted ⇒ the count comes from the ROW (orders.consecutive_failures), so a restart changes nothing", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder({ consecutive_failures: 7, last_attempt_at: NOW }),
      noRoute: true,
      nowSec: NOW_SEC,
      nowIso: NOW,
      maxFailures: 8,
    })
    assert.equal(plan.kind, "fail")
    assert.equal(plan.failures, 8)
    assert.equal(plan.patch.consecutive_failures, 8)
  })

  test("an explicit prevFailures can only RAISE the base, never undercut the row (max of the two)", () => {
    const fromRow = planFailureHandling({ dbOrder: dcaOrder({ consecutive_failures: 5 }), noRoute: true, prevFailures: 1, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(fromRow.failures, 6)
    const fromArg = planFailureHandling({ dbOrder: dcaOrder({ consecutive_failures: 1 }), noRoute: true, prevFailures: 5, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(fromArg.failures, 6)
  })

  test("a pre-migration row (column absent) behaves exactly as before: counts from zero", () => {
    const plan = planFailureHandling({ dbOrder: dcaOrder(), noRoute: true, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "retry")
    assert.equal(plan.failures, 1)
  })

  test("the FAIL patch also carries the final count (an auditor can read 8/8 off the row)", () => {
    const plan = planFailureHandling({ dbOrder: dcaOrder({ consecutive_failures: 7 }), noRoute: true, nowSec: NOW_SEC, nowIso: NOW, maxFailures: 8 })
    assert.equal(plan.patch.status, "failed")
    assert.equal(plan.patch.consecutive_failures, 8)
    assert.equal(plan.patch.last_attempt_at, NOW)
  })

  test("the EXPIRED patch carries no retry state — expiry is not a miss", () => {
    const plan = planFailureHandling({ dbOrder: dcaOrder({ expiry: NOW_SEC - 1, consecutive_failures: 3 }), noRoute: true, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "expired")
    assert.equal("consecutive_failures" in plan.patch, false)
    assert.equal("last_attempt_at" in plan.patch, false)
  })

  // [FIX-RETRY-CAP-RESTART] Task 3 — the incident's exact shape: the executor's own
  // InsufficientOutput (signed floor scaled per chunk, TeraSwapOrderExecutorV3.sol:526/:610),
  // repeated to the cap. Named honestly, never auto-cancelled.
  test("INCIDENT SHAPE: 8 consecutive InsufficientOutput reverts on a DCA ⇒ failed with min_output_unreachable + alert", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder({ consecutive_failures: 7 }),
      err: new Error('The contract function "executeOrder" reverted.'),
      executorErrorName: "InsufficientOutput",
      nowSec: NOW_SEC,
      nowIso: NOW,
      maxFailures: 8,
    })
    assert.equal(plan.kind, "fail")
    assert.equal(plan.reason, FAILURE_REASON.MIN_OUTPUT_UNREACHABLE)
    assert.equal(plan.patch.error, FAILURE_REASON.MIN_OUTPUT_UNREACHABLE)
    assert.equal(plan.patch.status, "failed", "the keeper stops trying and records why — it never cancels")
    assert.equal(plan.alert, true)
    assert.equal("dca_executed" in plan.patch, false)
  })

  test("a floor revert BELOW the cap is an ordinary transient retry (the floor may be merely tight)", () => {
    const plan = planFailureHandling({ dbOrder: dcaOrder({ consecutive_failures: 2 }), executorErrorName: "InsufficientOutput", nowSec: NOW_SEC, nowIso: NOW, maxFailures: 8 })
    assert.equal(plan.kind, "retry")
    assert.equal(plan.failures, 3)
  })

  test("a no-route miss at the cap keeps the routing reason (no_route_after_retries)", () => {
    const plan = planFailureHandling({ dbOrder: dcaOrder({ consecutive_failures: 7 }), noRoute: true, nowSec: NOW_SEC, nowIso: NOW, maxFailures: 8 })
    assert.equal(plan.reason, FAILURE_REASON.NO_ROUTE_AFTER_RETRIES)
  })

  test("TRANSIENT miss that REACHES the cap → fail with no_route_after_retries + alert once", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder(),
      noRoute: true,
      prevFailures: 7,
      nowSec: NOW_SEC,
      nowIso: NOW,
      maxFailures: 8,
    })
    assert.equal(plan.kind, "fail")
    assert.equal(plan.patch.error, FAILURE_REASON.NO_ROUTE_AFTER_RETRIES)
    assert.equal(plan.alert, true)
    assert.equal(plan.clearRetries, true)
  })

  test("a FAIL plan's patch NEVER carries dca_executed — completed DCA chunks are preserved", () => {
    for (const plan of [
      planFailureHandling({ dbOrder: dcaOrder(), err: new Error("exceeds balance"), prevFailures: 0, nowSec: NOW_SEC, nowIso: NOW }),
      planFailureHandling({ dbOrder: dcaOrder(), noRoute: true, prevFailures: 7, nowSec: NOW_SEC, nowIso: NOW, maxFailures: 8 }),
    ]) {
      assert.equal(plan.kind, "fail")
      assert.equal("dca_executed" in plan.patch, false)
      assert.equal("dca_last_exec" in plan.patch, false)
    }
  })

  test("no expiry info (expiry=0) does not falsely expire; proceeds to classify", () => {
    const plan = planFailureHandling({
      dbOrder: dcaOrder({ expiry: 0 }),
      noRoute: true,
      prevFailures: 0,
      nowSec: NOW_SEC,
      nowIso: NOW,
    })
    assert.equal(plan.kind, "retry")
  })
})
