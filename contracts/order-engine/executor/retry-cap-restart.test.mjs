// [FIX-RETRY-CAP-RESTART] Acceptance tests for "the cap must survive a process restart"
// (INC-2026-08-07-001 follow-up: order ef85438b reverted 516× under MAX_CYCLE_FAILURES=8 because
// the consecutive-miss count lived only in executor.js's in-memory Map and the keeper restarted
// 228 times — see docs/feedback/fix-keeper-retry-cap-survives-restart.md, Task 1).
//
// executor.js auto-runs main() on import, so — as every other keeper test does — the DECISION is
// exercised through the pure module (retry-policy.js / pinned-route.js) with a tiny model of the
// keeper loop that applies each plan's PATCH to a row object exactly as Supabase would, while the
// executor.js WIRING is pinned by source anchors (same technique as env-order.test.mjs /
// arbitrum-plumbing.test.mjs). A restart is modelled as what it really is: the process memory
// (the Map) is gone, the row is not.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  FAILURE_REASON,
  backoffMs,
  planFailureHandling,
  readPersistedRetryState,
  isInBackoffWindow,
  resetRetryStateFields,
} from "./retry-policy.js"
import { planPinnedRouteRevert, MAX_CONSECUTIVE_ROUTE_REVERTS } from "./pinned-route.js"

const CAP = 8
const T0 = Date.parse("2026-08-07T00:00:00.000Z")
const iso = (ms) => new Date(ms).toISOString()
const sec = (ms) => Math.floor(ms / 1000)

/** A fresh orders row as the keeper's `select=*` returns it — the migration columns at their defaults. */
function row(over = {}) {
  return {
    id: "ef85438b-0000-4000-8000-000000000000",
    order_type: "dca",
    status: "active",
    expiry: sec(T0) + 19 * 86_400, // the incident's order still had ~19 days of expiry left
    dca_executed: 0,
    dca_total: 3,
    consecutive_failures: 0,
    last_attempt_at: null,
    ...over,
  }
}

/**
 * The keeper loop, reduced to the four things that touch retry state — each mirrors ONE block of
 * executor.js (cited inline) and nothing else:
 *   miss()          handleExecutionFailure: plan from the ROW, apply the patch, refresh the cache
 *   pinnedRevert()  the ADR-014 (a) branch: cache only + updateOrderStatus(…,'active')
 *   defer()         gas-tier / deviation / oracle-floor / submission defers: updateOrderStatus only
 *   fill()          a confirmed execution: the success patch resets the count
 *   restart()       process memory gone; the row untouched
 */
function keeperModel() {
  let cache = new Map() // executor.js orderRetries — a same-process backoff cache
  const statusOnly = (r, status, nowMs) => Object.assign(r, { status, updated_at: iso(nowMs) }) // updateOrderStatus's exact shape
  return {
    restart() {
      cache = new Map()
    },
    miss(r, nowMs, failure = { executorErrorName: "InsufficientOutput" }) {
      const plan = planFailureHandling({ dbOrder: r, ...failure, nowSec: sec(nowMs), nowIso: iso(nowMs) })
      Object.assign(r, plan.patch)
      if (plan.clearRetries) cache.delete(r.id)
      else cache.set(r.id, { count: plan.failures, lastAttempt: nowMs })
      return plan
    },
    pinnedRevert(r, nowMs) {
      const consecutiveReverts = (cache.get(r.id)?.count || 0) + 1
      const plan = planPinnedRouteRevert({ consecutiveReverts })
      cache.set(r.id, { count: consecutiveReverts, lastAttempt: nowMs })
      statusOnly(r, "active", nowMs)
      return plan
    },
    defer(r, nowMs) {
      statusOnly(r, "active", nowMs)
    },
    fill(r, nowMs) {
      cache.delete(r.id)
      Object.assign(r, { status: "active", dca_executed: r.dca_executed + 1, dca_last_exec: iso(nowMs), updated_at: iso(nowMs), ...resetRetryStateFields() })
    },
    inBackoff(r, nowMs) {
      const s = cache.get(r.id) || readPersistedRetryState(r)
      return isInBackoffWindow({ count: s.count, lastAttempt: s.lastAttempt, nowMs })
    },
  }
}

/** Advance the clock past whatever backoff the order is under, then miss once. */
function missWhenDue(k, r, clock) {
  while (k.inBackoff(r, clock.t)) clock.t += 30_000 // the 30 s poll
  const plan = k.miss(r, clock.t)
  clock.t += 30_000
  return plan
}

// ─── Acceptance 1 — the cap holds ACROSS a restart ────────────────────────────────────────────

describe("acceptance 1 — N failures, restart, N more: the order fails at the cap, not at 2N", () => {
  test("4 InsufficientOutput reverts, restart, keep reverting ⇒ FAILED on the 8th attempt overall", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    const outcomes = []

    for (let i = 0; i < 4; i++) outcomes.push(missWhenDue(k, r, clock).kind)
    assert.deepEqual(outcomes, ["retry", "retry", "retry", "retry"])
    assert.equal(r.consecutive_failures, 4, "the row carries the count the previous process built up")

    k.restart() // pm2 restart #k of 228: the Map is empty, the row is not

    for (let i = 0; i < 3; i++) outcomes.push(missWhenDue(k, r, clock).kind)
    assert.deepEqual(outcomes.slice(4), ["retry", "retry", "retry"], "attempts 5–7 still retry")
    assert.equal(r.status, "active")

    const eighth = missWhenDue(k, r, clock)
    assert.equal(eighth.kind, "fail", "the 8th attempt overall trips the cap — restart or not")
    assert.equal(r.status, "failed")
    assert.equal(r.consecutive_failures, CAP)
    assert.equal(r.error, FAILURE_REASON.MIN_OUTPUT_UNREACHABLE, "and it is named for what it is")
    assert.equal(eighth.alert, true)
    assert.equal(r.dca_executed, 0, "completed chunks untouched; no funds moved; nothing cancelled")
    assert.equal(outcomes.length + 1, CAP, "exactly CAP attempts were made in total, not 2N")
  })

  test("the cap holds for EVERY restart point 1..7 — and for several restarts in a row", () => {
    for (let restartAfter = 1; restartAfter < CAP; restartAfter++) {
      const k = keeperModel()
      const r = row()
      const clock = { t: T0 }
      let attempts = 0
      let plan
      do {
        if (attempts === restartAfter) k.restart()
        if (attempts === restartAfter + 1) k.restart() // and again on the very next cycle
        plan = missWhenDue(k, r, clock)
        attempts++
      } while (plan.kind === "retry" && attempts < 3 * CAP)
      assert.equal(plan.kind, "fail", `restart after ${restartAfter}: must still fail`)
      assert.equal(attempts, CAP, `restart after ${restartAfter}: failed at attempt ${attempts}, expected ${CAP}`)
    }
  })

  test("the 228-restart incident replayed: a restart before EVERY cycle still fails at 8, never 516", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    let attempts = 0
    let plan
    do {
      k.restart()
      plan = missWhenDue(k, r, clock)
      attempts++
    } while (plan.kind === "retry" && attempts < 516)
    assert.equal(plan.kind, "fail")
    assert.equal(attempts, CAP)
  })

  test("REGRESSION PIN — the pre-fix model (count from process memory only) never reaches the cap across a restart", () => {
    // What executor.js did before this change: prevFailures came from the Map, and the row had no
    // column to read. This is the bug, modelled explicitly, so the test above is provably
    // discriminating and not vacuous.
    let legacyCache = new Map()
    const r = row()
    delete r.consecutive_failures // pre-migration row
    delete r.last_attempt_at
    const legacyMiss = (nowMs) => {
      const prev = legacyCache.get(r.id)
      const plan = planFailureHandling({
        dbOrder: r,
        executorErrorName: "InsufficientOutput",
        prevFailures: prev ? prev.count : 0,
        nowSec: sec(nowMs),
        nowIso: iso(nowMs),
      })
      Object.assign(r, { status: plan.patch.status, updated_at: plan.patch.updated_at }) // legacy patch shape
      legacyCache.set(r.id, { count: plan.failures, lastAttempt: nowMs })
      return plan
    }
    let t = T0
    for (let i = 0; i < 4; i++) assert.equal(legacyMiss((t += 60_000)).kind, "retry")
    legacyCache = new Map() // restart
    for (let i = 0; i < 4; i++) assert.equal(legacyMiss((t += 60_000)).kind, "retry")
    assert.equal(r.status, "active", "8 attempts, still active — this is exactly how 516 happened")
  })

  test("backoff survives the restart too: the restarted keeper does NOT hammer the order on its first poll", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    for (let i = 0; i < 3; i++) missWhenDue(k, r, clock)
    const lastAttempt = Date.parse(r.last_attempt_at)
    k.restart()
    assert.equal(k.inBackoff(r, lastAttempt + 1_000), true, "1 s after the 3rd miss: still backing off")
    assert.equal(k.inBackoff(r, lastAttempt + backoffMs(3) - 1), true)
    assert.equal(k.inBackoff(r, lastAttempt + backoffMs(3)), false, "the window elapsed: attempt")
  })

  test("a successful fill resets the persisted count — the ladder is consecutive, not cumulative", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    for (let i = 0; i < 6; i++) missWhenDue(k, r, clock)
    assert.equal(r.consecutive_failures, 6)
    k.fill(r, clock.t)
    assert.equal(r.consecutive_failures, 0)
    k.restart()
    assert.equal(k.inBackoff(r, clock.t + 1), false)
    assert.equal(missWhenDue(k, r, clock).failures, 1, "after a fill, the next miss is 1/8 again")
  })
})

// ─── Acceptance 2 — the pinned-route protection (ADR-014 a) is intact ─────────────────────────

describe("acceptance 2 — a pinned-route revert still never walks the ladder to 'failed'", () => {
  test("50 consecutive pinned reverts on a Limit order: always active, persisted count stays 0, alert at the threshold", () => {
    const k = keeperModel()
    const r = row({ order_type: "limit", dca_executed: undefined, dca_total: undefined })
    let t = T0
    for (let i = 1; i <= 50; i++) {
      const plan = k.pinnedRevert(r, (t += 60_000))
      assert.equal(plan.keepActive, true)
      assert.equal(r.status, "active")
      assert.equal(plan.alert, i >= MAX_CONSECUTIVE_ROUTE_REVERTS)
    }
    assert.equal(readPersistedRetryState(r).count, 0, "the pinned path never writes the ladder's column")
    assert.equal(r.error, undefined)
  })

  test("…and after a restart, a later NON-market error starts the ladder at 1, not at 51", () => {
    const k = keeperModel()
    const r = row({ order_type: "limit" })
    let t = T0
    for (let i = 0; i < 50; i++) k.pinnedRevert(r, (t += 60_000))
    k.restart()
    const plan = k.miss(r, (t += 60_000), { err: new Error("HTTP request failed: 503 Service Unavailable") })
    assert.equal(plan.kind, "retry")
    assert.equal(plan.failures, 1)
    assert.equal(r.status, "active")
  })

  test("the pinned branch is still DCA-excluded and still bypasses handleExecutionFailure (source anchor)", () => {
    const src = executorSource()
    const branch = sliceBetween(src, 'if (dbOrder.order_type !== "dca" && isMarketRevert({ swapReason, executorErrorName })) {', "\n        continue\n      }")
    assert.ok(branch.includes('updateOrderStatus(dbOrder.id, "active")'), "stays fillable via the status-only patch")
    for (const forbidden of ["handleExecutionFailure(", "planFailureHandling(", "patchOrderRow(", "consecutive_failures", "buildOrderFailurePatch"]) {
      assert.equal(branch.includes(forbidden), false, `pinned branch must not contain ${forbidden}`)
    }
    assert.ok(src.includes("const pinnedRouteReverts = new Map()"), "the separate pinned-revert tracker (executor.js:279) is untouched")
  })
})

// ─── Acceptance 3 — a defer counts as ZERO failures ───────────────────────────────────────────

describe("acceptance 3 — gas-price / delay-not-drain defers count as zero failures", () => {
  test("20 defers leave the persisted count at 0, no backoff, and the next real miss is 1/8", () => {
    const k = keeperModel()
    const r = row()
    let t = T0
    for (let i = 0; i < 20; i++) k.defer(r, (t += 30_000))
    assert.equal(readPersistedRetryState(r).count, 0)
    assert.equal(r.last_attempt_at, null)
    assert.equal(k.inBackoff(r, t + 1), false)
    k.restart()
    assert.equal(k.miss(r, t + 30_000).failures, 1)
  })

  test("every defer site in executor.js unlocks with updateOrderStatus only and never touches the ladder (source anchors)", () => {
    const src = executorSource()
    const sites = {
      "gas-tier defer": sliceBetween(src, "if (!gasTier.execute) {", "\n      }"),
      "DCA deviation defer": sliceBetween(src, 'if (decision.action === "defer") {', "\n          continue"),
      "oracle-floor delay-not-drain": sliceBetween(src, "// DELAY, never drain.", "\n            continue"),
      "submission refused": sliceBetween(src, "if (!submission.ok) {", "\n        continue"),
    }
    for (const [name, block] of Object.entries(sites)) {
      assert.ok(block.includes('updateOrderStatus(dbOrder.id, "active")'), `${name}: must unlock via updateOrderStatus`)
      for (const forbidden of ["handleExecutionFailure(", "planFailureHandling(", "orderRetries.set(", "consecutive_failures", "patchOrderRow("]) {
        assert.equal(block.includes(forbidden), false, `${name}: must not contain ${forbidden}`)
      }
    }
  })

  test("updateOrderStatus writes status + updated_at ONLY — so no defer can ever persist a count (source anchor)", () => {
    const body = sliceBetween(executorSource(), "async function updateOrderStatus(orderId, status) {", "\n}")
    assert.ok(body.includes("body: JSON.stringify({ status, updated_at: new Date().toISOString() })"))
    assert.equal(body.includes("consecutive_failures"), false)
    assert.equal(body.includes("last_attempt_at"), false)
  })
})

// ─── Wiring — the executor really reads the row and really passes the floor signal ────────────

describe("executor.js wiring (source anchors) — the decision reads persisted state", () => {
  // [FIX-RETRY-FALLBACK-MIGRATION-LAGS] This anchor originally required the Map to be ABSENT from
  // handleExecutionFailure outright. That rule was too strong in one direction and left a hole in
  // the other: with the persisted columns missing, "never read the Map" meant the base was always
  // 0, so the cap never fired at all (strictly worse than before FIX-RETRY-CAP-RESTART). The rule
  // is now NARROWER, not weaker — the Map may reach the decision ONLY through
  // prevFailuresForDecision, whose `columnsAvailable` gate returns 0 whenever the row is usable
  // (proven behaviourally in the "columns PRESENT" suite above, not just structurally here).
  test("handleExecutionFailure plans from the ROW, and touches the cache ONLY through the gated helper", () => {
    const body = sliceBetween(executorSource(), "async function handleExecutionFailure(", "\nasync function unlockStaleOrders")
    assert.ok(
      body.includes("prevFailures: prevFailuresForDecision({"),
      "the cache may enter the decision only via the gated helper",
    )
    assert.ok(
      body.includes("columnsAvailable: retryStateAvailability.isAvailable()"),
      "and only when the persisted columns are unavailable",
    )
    // The pre-FIX-RETRY-CAP-RESTART shape must NOT come back: an ungated cache read that feeds the
    // decision directly is exactly the regression this anchor exists to catch.
    // `prev` is a prefix of `prevFailuresForDecision`, so the lookahead is load-bearing: without
    // it this would match the CORRECT gated call and never catch the shape it is aiming at.
    assert.equal(
      /prevFailures:\s*(?!prevFailuresForDecision\b)(prev\b|orderRetries\b)/.test(body),
      false,
      "the decision must never take an UNGATED count from the in-memory cache",
    )
    assert.ok(body.includes("executorErrorName"), "the floor signal reaches the plan (Task 3)")
    assert.ok(body.includes("patchOrderRow(dbOrder.id, plan.patch)"), "the patch — with the count — is what lands on the row")
  })

  test("patchOrderRow is the sensor: it marks the columns missing on the 400 and PRESENT on an accepted write", () => {
    const body = sliceBetween(executorSource(), "async function patchOrderRow(", "\n// [chore/dca-resilience] Single failure handler")
    assert.ok(body.includes("retryStateAvailability.markMissing()"), "the specific 400 flips the fallback on")
    assert.ok(body.includes("retryStateAvailability.markPresent()"), "an accepted write flips it back off")
    // markPresent must be gated on the patch having CARRIED the columns — a status-only patch (or
    // the stripped re-send) succeeding proves nothing about the schema and must not clear it.
    assert.ok(
      body.includes("if (hadRetryState && !retryStateAvailability.isAvailable())"),
      "only a patch that carried the columns may clear the fallback",
    )
    assert.ok(
      body.includes("detail: RETRY_STATE_COLUMNS_MISSING_ALERT"),
      "the ops page uses the pinned constant, so its text cannot drift from the behaviour",
    )
  })

  test("the catch site forwards executorErrorName to handleExecutionFailure", () => {
    assert.ok(executorSource().includes("await handleExecutionFailure(dbOrder, { err, swapReason, executorErrorName }, obsCtx)"))
  })

  test("the cycle's backoff gate falls back to the row when the cache is empty (i.e. after a restart)", () => {
    const src = executorSource()
    assert.ok(src.includes("orderRetries.get(dbOrder.id) || readPersistedRetryState(dbOrder)"))
    assert.ok(src.includes("isInBackoffWindow("))
  })

  test("both success patches (DCA chunk + Limit/SL fill) reset the persisted count", () => {
    const src = executorSource()
    const dcaPatch = sliceBetween(src, "const orderPatch = {", "\n          }")
    const limitPatch = sliceBetween(src, "// Limit / Stop-Loss: single execution", "\n          })")
    assert.ok(dcaPatch.includes("...resetRetryStateFields()"), "DCA chunk fill resets the count")
    assert.ok(limitPatch.includes("...resetRetryStateFields()"), "Limit/SL fill resets the count")
  })
})

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

function executorSource() {
  return readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
}

/** The first occurrence of `from` up to the next `to` after it — fails loudly if either is missing. */
function sliceBetween(src, from, to) {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `anchor not found in executor.js: ${JSON.stringify(from)}`)
  const b = src.indexOf(to, a + from.length)
  assert.ok(b >= 0, `end anchor not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`)
  return src.slice(a, b + to.length)
}
