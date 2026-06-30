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

import {
  FAILURE_REASON,
  MAX_CYCLE_FAILURES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  collectErrorText,
  classifyFailure,
  nextRetryDecision,
  backoffMs,
  buildOrderFailurePatch,
  buildOrderActivePatch,
  planFailureHandling,
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
    assert.deepEqual(plan.patch, { status: "active", updated_at: NOW })
    assert.equal(plan.failures, 3)
    assert.equal(plan.clearRetries, false)
    assert.equal(plan.alert, false)
    assert.ok(plan.backoffMs > 0)
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
