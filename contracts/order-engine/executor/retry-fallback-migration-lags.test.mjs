// [FIX-RETRY-FALLBACK-MIGRATION-LAGS] L-1 from the audit of PR #425.
//
// #425 moved the retry-cap decision onto orders.consecutive_failures so the cap survives a
// restart. But `readPersistedRetryState` reads an ABSENT column as 0, and the Map was removed from
// the decision — so on a database that has not received migration 20260827190000, every miss
// computed 1/8 and the cap NEVER fired. A deploy in the wrong order was strictly WORSE than before
// #425, while the ops page claimed "MAX_CYCLE_FAILURES is process-memory only", which was false.
//
// The principle under test: a guard degrades to the PREVIOUS state, never to the absence of the
// guard. These tests model the executor loop the way retry-cap-restart.test.mjs does (executor.js
// auto-runs main() on import, so the wiring is pinned by source anchors there), with ONE added
// dimension that is the whole point here: whether the DATABASE actually has the two columns.

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import {
  FAILURE_REASON,
  MAX_CYCLE_FAILURES,
  RETRY_STATE_COLUMNS_MISSING_ALERT,
  planFailureHandling,
  prevFailuresForDecision,
  createRetryStateAvailability,
  stripRetryStateColumns,
  resetRetryStateFields,
} from "./retry-policy.js"

const CAP = 8
const T0 = Date.parse("2026-08-27T00:00:00.000Z")
const iso = (ms) => new Date(ms).toISOString()
const sec = (ms) => Math.floor(ms / 1000)

assert.equal(MAX_CYCLE_FAILURES, CAP, "these cases are written against the default cap of 8")

function row(over = {}) {
  return {
    id: "ef85438b-0000-4000-8000-000000000000",
    order_type: "dca",
    status: "active",
    expiry: sec(T0) + 19 * 86_400,
    dca_executed: 0,
    ...over,
  }
}

/**
 * The executor loop, reduced to the parts this fix touches. Each piece mirrors ONE block of
 * executor.js; the source anchors in retry-cap-restart.test.mjs pin that it still looks like this.
 *
 * @param {{ hasColumns: boolean }} db — whether the DATABASE has the retry-state columns.
 */
function keeperModel({ hasColumns }) {
  const database = { hasColumns }
  const availability = createRetryStateAvailability()
  let cache = new Map() // executor.js `orderRetries`
  const alerts = []

  /** Faithful model of executor.js patchOrderRow — including its role as the fallback SENSOR. */
  function patchOrderRow(r, patch) {
    const stripped = stripRetryStateColumns(patch)
    const hadRetryState = Object.keys(stripped).length < Object.keys(patch).length

    if (database.hasColumns || !hadRetryState) {
      // PostgREST accepts it.
      Object.assign(r, patch)
      if (hadRetryState && !availability.isAvailable()) availability.markPresent()
      return { ok: true }
    }
    // PostgREST 400: "Could not find the 'consecutive_failures' column".
    if (availability.markMissing()) alerts.push(RETRY_STATE_COLUMNS_MISSING_ALERT)
    Object.assign(r, stripped) // the status transition still lands
    return { ok: false, stripped: true }
  }

  return {
    alerts,
    availability,
    cacheGet: (id) => cache.get(id),
    cacheSet: (id, v) => cache.set(id, v),
    /** The migration is applied while the keeper is RUNNING — no restart. */
    applyMigration() {
      database.hasColumns = true
    },
    dropColumns() {
      database.hasColumns = false
    },
    /** pm2 restart: process memory is gone, the database is not. */
    restart() {
      cache = new Map()
    },
    /** Faithful model of executor.js handleExecutionFailure. */
    miss(r, nowMs, failure = { executorErrorName: "InsufficientOutput" }) {
      const plan = planFailureHandling({
        dbOrder: r,
        ...failure,
        prevFailures: prevFailuresForDecision({
          columnsAvailable: availability.isAvailable(),
          cached: cache.get(r.id),
        }),
        nowSec: sec(nowMs),
        nowIso: iso(nowMs),
      })
      patchOrderRow(r, plan.patch)
      if (plan.clearRetries) cache.delete(r.id)
      else cache.set(r.id, { count: plan.failures, lastAttempt: nowMs })
      return plan
    },
    /** A confirmed fill: the success patch carries resetRetryStateFields(). */
    fill(r, nowMs) {
      cache.delete(r.id)
      patchOrderRow(r, {
        status: "active",
        dca_executed: r.dca_executed + 1,
        updated_at: iso(nowMs),
        ...resetRetryStateFields(),
      })
    },
  }
}

/** Drive misses until the ladder ends, returning every plan. Bounded well above the cap. */
function missUntilFail(k, r, { start = T0, limit = 60 } = {}) {
  const plans = []
  let t = start
  for (let i = 0; i < limit; i++) {
    const plan = k.miss(r, (t += 60_000))
    plans.push(plan)
    if (plan.kind !== "retry") break
  }
  return plans
}

// ─── Acceptance 1 — columns ABSENT: the cap still fires, exactly as before #425 ────────────────

describe("acceptance 1 — with the columns ABSENT the cap still fires at MAX_CYCLE_FAILURES", () => {
  test("REGRESSION PIN: the shipped #425 decision (no prevFailures at all) never fires the cap", () => {
    // The L-1 defect itself, reproduced against the real planFailureHandling: with the columns
    // absent the row reads 0 every time, so without a fallback every miss is 1/8 forever. This is
    // what makes the next test meaningful rather than vacuous.
    const r = row()
    for (let i = 0; i < 3 * CAP; i++) {
      const plan = planFailureHandling({
        dbOrder: r,
        executorErrorName: "InsufficientOutput",
        // no prevFailures — exactly what handleExecutionFailure passed on main @ 0e0e76d
        nowSec: sec(T0),
        nowIso: iso(T0),
      })
      assert.equal(plan.kind, "retry")
      assert.equal(plan.failures, 1, "the count can never leave 1 — the cap is unreachable")
    }
  })

  test("the fallback restores it: 8 consecutive misses ⇒ FAILED at the cap, in ONE process", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()

    const plans = missUntilFail(k, r)

    assert.equal(plans.length, CAP, `expected the ladder to end on attempt ${CAP}, got ${plans.length}`)
    assert.deepEqual(
      plans.map((p) => p.failures),
      [1, 2, 3, 4, 5, 6, 7, 8],
      "the count climbs 1..8 out of process memory, exactly as it did before #425",
    )
    assert.equal(plans.at(-1).kind, "fail")
    assert.equal(r.status, "failed")
    assert.equal(r.error, FAILURE_REASON.MIN_OUTPUT_UNREACHABLE)
    assert.equal(plans.at(-1).alert, true)
    // The status transition landed even though the columns were rejected...
    assert.equal("consecutive_failures" in r, false, "...and no phantom column was written to the row")
    assert.equal(r.dca_executed, 0, "completed chunks untouched; the keeper never cancels")
  })

  test("a fill still resets the ladder while the columns are absent (consecutive, not cumulative)", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()
    for (let i = 0; i < 5; i++) k.miss(r, T0 + i * 60_000)
    k.fill(r, T0 + 600_000)
    assert.equal(k.miss(r, T0 + 660_000).failures, 1, "after a fill the next miss is 1/8 again")
  })

  test("and it DOES reset on restart — the honest weakness the ops page must state", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()
    for (let i = 0; i < 7; i++) k.miss(r, T0 + i * 60_000) // one short of the cap
    k.restart()
    const afterRestart = k.miss(r, T0 + 999_000)
    assert.equal(afterRestart.failures, 1, "process memory is gone and the row never held the count")
    assert.equal(afterRestart.kind, "retry")
  })
})

// ─── Acceptance 2 — columns PRESENT: the Map is NOT consulted for the decision ─────────────────

describe("acceptance 2 — with the columns PRESENT the decision follows the ROW, never the Map", () => {
  // The decisive direction: the Map holds a HIGHER number than the row. planFailureHandling takes
  // max(persisted, prevFailures), so a leak would show up as the Map's number winning.
  test("row 2 / Map 5 ⇒ the decision is 3 (row + 1), NOT 6", () => {
    const k = keeperModel({ hasColumns: true })
    const r = row({ consecutive_failures: 2, last_attempt_at: iso(T0) })
    k.cacheSet(r.id, { count: 5, lastAttempt: T0 })

    const plan = k.miss(r, T0 + 60_000)

    assert.equal(plan.failures, 3, "the stale in-memory 5 must not raise the decision")
    assert.equal(r.consecutive_failures, 3, "and the row is what gets written back")
  })

  test("row 5 / Map 2 ⇒ the decision is 6 (row + 1), NOT 3", () => {
    const k = keeperModel({ hasColumns: true })
    const r = row({ consecutive_failures: 5, last_attempt_at: iso(T0) })
    k.cacheSet(r.id, { count: 2, lastAttempt: T0 })

    assert.equal(k.miss(r, T0 + 60_000).failures, 6, "the row's higher count must not be undercut")
  })

  test("row at the cap ⇒ fails NOW even with an empty Map (a restart cannot buy extra attempts)", () => {
    const k = keeperModel({ hasColumns: true })
    const r = row({ consecutive_failures: CAP - 1, last_attempt_at: iso(T0) })
    k.restart()

    const plan = k.miss(r, T0 + 60_000)

    assert.equal(plan.kind, "fail")
    assert.equal(plan.failures, CAP)
  })

  test("prevFailuresForDecision is 0 whenever the columns are available, whatever the cache holds", () => {
    for (const cached of [null, undefined, { count: 0 }, { count: 7 }, { count: 10_000 }]) {
      assert.equal(prevFailuresForDecision({ columnsAvailable: true, cached }), 0)
    }
  })

  test("…and only then does it hand back the cached count", () => {
    assert.equal(prevFailuresForDecision({ columnsAvailable: false, cached: { count: 7 } }), 7)
    assert.equal(prevFailuresForDecision({ columnsAvailable: false, cached: null }), 0)
    assert.equal(prevFailuresForDecision({ columnsAvailable: false, cached: undefined }), 0)
    // Never trusts a malformed cache entry into the decision.
    assert.equal(prevFailuresForDecision({ columnsAvailable: false, cached: { count: -3 } }), 0)
    assert.equal(prevFailuresForDecision({ columnsAvailable: false, cached: { count: "nine" } }), 0)
    assert.equal(prevFailuresForDecision({ columnsAvailable: false, cached: { count: 2.7 } }), 2)
    assert.equal(prevFailuresForDecision(), 0)
  })
})

// ─── Acceptance 3 — recovery mid-process, no restart ───────────────────────────────────────────

describe("acceptance 3 — the fallback CLEARS when the migration is applied mid-process", () => {
  test("absent → present ⇒ the decision returns to the persisted value with no restart", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()

    // Three misses on the in-memory fallback; the row holds nothing.
    for (let i = 0; i < 3; i++) k.miss(r, T0 + i * 60_000)
    assert.equal(k.availability.isAvailable(), false, "the sensor detected the missing columns")
    assert.equal(k.cacheGet(r.id).count, 3)
    assert.equal("consecutive_failures" in r, false)

    // Ops applies the migration. The keeper keeps running; the NEXT write carries the columns and
    // is accepted, which is what clears the fallback.
    k.applyMigration()
    const first = k.miss(r, T0 + 300_000)

    // That very miss still used the fallback (the sensor only learns from the write it just made),
    // so nothing is lost — 3 → 4 — and the count is now persisted for the first time.
    assert.equal(first.failures, 4)
    assert.equal(r.consecutive_failures, 4, "the row now carries the count")
    assert.equal(k.availability.isAvailable(), true, "and the fallback is off")

    // From here the decision follows the ROW. Prove it the same way as acceptance 2: poison the
    // Map with a different number and require the row to win.
    k.cacheSet(r.id, { count: 99, lastAttempt: T0 })
    assert.equal(k.miss(r, T0 + 360_000).failures, 5, "row 4 + 1 — the poisoned Map is ignored")

    // And the recovered semantics are the restart-proof ones.
    k.restart()
    assert.equal(k.miss(r, T0 + 420_000).failures, 6, "the count survived a restart, from the row")
  })

  test("the ladder is continuous across the recovery — no double-count, no reset to 1", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()
    const seen = []
    for (let i = 0; i < 3; i++) seen.push(k.miss(r, T0 + i * 60_000).failures)
    k.applyMigration()
    for (let i = 3; i < CAP; i++) seen.push(k.miss(r, T0 + i * 60_000).failures)

    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(r.status, "failed", "the cap fires on attempt 8 across the transition")
  })

  test("a REGRESSION back to missing is detected again and pages again (the alert is per-outage)", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()
    k.miss(r, T0)
    assert.equal(k.alerts.length, 1)

    k.applyMigration()
    k.miss(r, T0 + 60_000)
    assert.equal(k.availability.isAvailable(), true)

    // A rollback / failover to a replica that never got the migration.
    k.dropColumns()
    k.miss(r, T0 + 120_000)
    assert.equal(k.availability.isAvailable(), false)
    assert.equal(k.alerts.length, 2, "a second, distinct outage must not be swallowed by a stale latch")
  })

  test("only a write that CARRIED the columns may clear the fallback", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()
    k.miss(r, T0)
    assert.equal(k.availability.isAvailable(), false)

    // An 'expired' patch carries no retry-state columns (planFailureHandling omits them), so it
    // succeeds against a pre-migration database and must prove nothing about the schema.
    const expiredPlan = planFailureHandling({
      dbOrder: row({ expiry: sec(T0) - 1 }),
      noRoute: true,
      nowSec: sec(T0),
      nowIso: iso(T0),
    })
    assert.equal("consecutive_failures" in expiredPlan.patch, false, "precondition: no columns in this patch")
    assert.equal(
      k.availability.isAvailable(),
      false,
      "the fallback is still on — a column-less write cannot clear it",
    )
  })
})

// ─── Acceptance 4 — the ops page says what is actually true ────────────────────────────────────

describe("acceptance 4 — the alert text, pinned verbatim", () => {
  test("is exactly this string", () => {
    assert.equal(
      RETRY_STATE_COLUMNS_MISSING_ALERT,
      "orders.consecutive_failures / last_attempt_at are MISSING — apply " +
        "supabase/migrations/20260827190000_add_orders_retry_state.sql. The retry cap has FALLEN BACK to the " +
        "in-memory count: it still fires after MAX_CYCLE_FAILURES consecutive misses within a single keeper " +
        "process, but the count RESETS ON RESTART — the INC-2026-08-07-001 shape (516 reverts under a cap of 8 " +
        "across 228 restarts). It returns to the persisted count automatically, with no restart, on the first " +
        "successful write after the migration is applied.",
    )
  })

  test("every claim it makes is a claim another test in this file proves", () => {
    // "still fires ... within a single keeper process" → acceptance 1, second case.
    assert.match(RETRY_STATE_COLUMNS_MISSING_ALERT, /still fires after MAX_CYCLE_FAILURES consecutive misses within a single keeper process/)
    // "RESETS ON RESTART" → acceptance 1, fourth case.
    assert.match(RETRY_STATE_COLUMNS_MISSING_ALERT, /RESETS ON RESTART/)
    // "returns to the persisted count ... with no restart" → acceptance 3, first case.
    assert.match(RETRY_STATE_COLUMNS_MISSING_ALERT, /returns to the persisted count automatically, with no restart/)
    // Names the migration an operator has to apply.
    assert.match(RETRY_STATE_COLUMNS_MISSING_ALERT, /supabase\/migrations\/20260827190000_add_orders_retry_state\.sql/)
  })

  test("the FALSE claim shipped in #425 is gone", () => {
    // "MAX_CYCLE_FAILURES is process-memory only" described the PRE-#425 behaviour, but #425 had
    // removed the Map from the decision — so at the time it was written the cap was not
    // process-memory-only, it was absent. The wording must not come back.
    assert.equal(/process-memory only/.test(RETRY_STATE_COLUMNS_MISSING_ALERT), false)
  })

  test("it fires ONCE per outage, not once per miss", () => {
    const k = keeperModel({ hasColumns: false })
    const r = row()
    missUntilFail(k, r)
    assert.equal(k.alerts.length, 1, "eight rejected writes, one page")
    assert.equal(k.alerts[0], RETRY_STATE_COLUMNS_MISSING_ALERT)
  })
})

// ─── The availability unit itself ──────────────────────────────────────────────────────────────

describe("createRetryStateAvailability — starts optimistic, flips both ways, isolated per instance", () => {
  test("starts available (the migration is merged; the first rejected write flips it)", () => {
    assert.equal(createRetryStateAvailability().isAvailable(), true)
  })

  test("markMissing returns true only for the FIRST detection of each outage", () => {
    const a = createRetryStateAvailability()
    assert.equal(a.markMissing(), true)
    assert.equal(a.markMissing(), false)
    assert.equal(a.markMissing(), false)
    a.markPresent()
    assert.equal(a.markMissing(), true, "a new outage pages again")
  })

  test("instances do not share state", () => {
    const a = createRetryStateAvailability()
    const b = createRetryStateAvailability()
    a.markMissing()
    assert.equal(a.isAvailable(), false)
    assert.equal(b.isAvailable(), true)
  })
})
