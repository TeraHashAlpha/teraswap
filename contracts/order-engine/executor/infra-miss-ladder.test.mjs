// [fix/infra-failures-dont-burn-orders / ADR-026 §2–4] Only `order` misses advance the ladder.
//
//   auth outage 20 cycles ⇒ counter unchanged, order alive, resumes once healthy, exactly one
//   execution per due interval · a sent-and-reverted tx ⇒ +1 · 8 order misses ⇒ failed as before ·
//   a mixed sequence fails on the 8th ORDER miss, never on the Nth attempt · while paused nothing is
//   attempted · the infra columns are tolerated when absent.
//
// Same technique as retry-cap-restart.test.mjs: the DECISION is exercised through the pure module
// with a small model of the keeper loop (and of the contract's dcaLastExecution + dcaInterval gate,
// TeraSwapOrderExecutorV3.sol:387/:482/:586) that applies each plan's PATCH to a row exactly as
// Supabase would; the executor.js WIRING is pinned by source anchors.
// Run: node --test contracts/order-engine/executor/infra-miss-ladder.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { HttpRequestError } from "viem"

import {
  MISS_CAUSE,
  INFRA_MISS_COLUMNS,
  FAILURE_REASON,
  planFailureHandling,
  readPersistedRetryState,
  isInBackoffWindow,
  resetRetryStateFields,
  stripInfraMissColumns,
  isInfraMissColumnRejection,
  buildInfraMissPatch,
  backoffMs,
} from "./retry-policy.js"

const CAP = 8
const POLL = 30_000
const INTERVAL_SEC = 3_600
const T0 = Date.parse("2026-10-30T15:00:00.000Z")
const iso = (ms) => new Date(ms).toISOString()
const sec = (ms) => Math.floor(ms / 1000)
const URL_ = "https://base-mainnet.g.alchemy.com/v2/TESTKEY"
const AUTH = () => new HttpRequestError({ url: URL_, status: 403, body: { method: "eth_call" }, details: "Unspecified origin not on whitelist." })
const OUTAGE = () => new HttpRequestError({ url: URL_, status: 503, body: { method: "eth_call" }, details: "Service Unavailable" })

/** A DCA row as `select=*` returns it: 10 chunks, hourly, nothing executed yet, created at T0. */
function row(over = {}) {
  return {
    id: "dca-0001",
    order_type: "dca",
    status: "active",
    created_at: iso(T0),
    expiry: sec(T0) + 30 * 86_400,
    dca_interval: INTERVAL_SEC,
    dca_total: 10,
    dca_executed: 0,
    dca_last_exec: null,
    consecutive_failures: 0,
    last_attempt_at: null,
    last_infra_miss_at: null,
    last_infra_miss_reason: null,
    ...over,
  }
}

/**
 * The keeper loop reduced to what touches the ladder, plus the CONTRACT's own due gate:
 *   cycle(r, t, rpc)  one poll — 'healthy' | 'auth' | 'outage'; mirrors executeCycle's order:
 *                     paused gate → status → backoff → attempt (miss or canExecute → one executeOrder)
 *   miss()            handleExecutionFailure: plan from the ROW, apply the patch, refresh the cache
 *   fill()            a confirmed execution (resets the count)
 *   restart()         process memory gone; the row and the chain are not
 */
function keeperModel({ paused = () => null } = {}) {
  let cache = new Map()
  const chain = { lastExec: 0 } // dcaLastExecution[hash] — 0 until the first chunk
  const m = {
    restart() {
      cache = new Map()
    },
    inBackoff(r, nowMs) {
      const s = cache.get(r.id) || readPersistedRetryState(r)
      return isInBackoffWindow({ count: s.count, lastAttempt: s.lastAttempt, nowMs })
    },
    miss(r, nowMs, failure) {
      const plan = planFailureHandling({ dbOrder: r, ...failure, paused: paused(), nowSec: sec(nowMs), nowIso: iso(nowMs) })
      Object.assign(r, plan.patch)
      if (plan.clearRetries) cache.delete(r.id)
      else cache.set(r.id, { count: plan.failures, lastAttempt: nowMs })
      return plan
    },
    fill(r, nowMs) {
      chain.lastExec = sec(nowMs)
      cache.delete(r.id)
      const n = r.dca_executed + 1
      Object.assign(r, { status: n >= r.dca_total ? "executed" : "active", dca_executed: n, dca_last_exec: iso(nowMs), updated_at: iso(nowMs), ...resetRetryStateFields() })
    },
    cycle(r, nowMs, rpc = "healthy") {
      if (paused()) return { attempted: false, why: "paused" } // executor.js: the loop is skipped entirely
      if (r.status !== "active") return { attempted: false, why: r.status }
      if (m.inBackoff(r, nowMs)) return { attempted: false, why: "backoff" }
      if (rpc === "auth") return { attempted: true, plan: m.miss(r, nowMs, { err: AUTH() }) }
      if (rpc === "outage") return { attempted: true, plan: m.miss(r, nowMs, { err: OUTAGE() }) }
      // healthy: the CONTRACT decides whether a chunk is due (canExecute → dcaLastExecution + interval)
      if (sec(nowMs) < chain.lastExec + INTERVAL_SEC) return { attempted: true, why: "not-due" }
      m.fill(r, nowMs)
      return { attempted: true, executed: true }
    },
    chain,
  }
  return m
}

/** Run `n` polls from `clock.t`, advancing 30 s each; returns every cycle result. */
function polls(k, r, clock, n, rpc) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(k.cycle(r, clock.t, rpc))
    clock.t += POLL
  }
  return out
}

// ─── The plan for an infra miss ───────────────────────────────────────────────────────────────

describe("planFailureHandling — an `infra` miss never touches the counter", () => {
  test("kind 'infra': status stays active, last_attempt_at + last_infra_miss_* written, consecutive_failures NOT in the patch", () => {
    const NOW = iso(T0)
    const plan = planFailureHandling({ dbOrder: row({ consecutive_failures: 3 }), err: AUTH(), nowSec: sec(T0), nowIso: NOW })
    assert.equal(plan.kind, "infra")
    assert.deepEqual(plan.patch, { status: "active", updated_at: NOW, last_attempt_at: NOW, last_infra_miss_at: NOW, last_infra_miss_reason: "rpc-auth" })
    assert.equal(plan.failures, 3, "the count the row already had — unchanged")
    assert.equal(plan.clearRetries, false)
    assert.equal(plan.alert, false)
    assert.equal(plan.reason, null)
    assert.deepEqual([plan.cause, plan.causeReason], [MISS_CAUSE.INFRA, "rpc-auth"])
    assert.equal(plan.backoffMs, backoffMs(3), "an order already on the ladder keeps its backoff")
  })
  test("count 0 ⇒ no backoff: the next healthy cycle retries at once", () => {
    const plan = planFailureHandling({ dbOrder: row(), err: OUTAGE(), nowSec: sec(T0), nowIso: iso(T0) })
    assert.equal(plan.kind, "infra")
    assert.equal(plan.failures, 0)
    assert.equal(plan.backoffMs, 0)
  })
  test("expiry still wins over an infra miss (an expired order can never fill)", () => {
    const plan = planFailureHandling({ dbOrder: row({ expiry: sec(T0) - 1 }), err: AUTH(), paused: "rpc-auth", nowSec: sec(T0), nowIso: iso(T0) })
    assert.equal(plan.kind, "expired")
  })
  test("buildInfraMissPatch is the exact shape; INFRA_MISS_COLUMNS names what a pre-migration DB rejects", () => {
    assert.deepEqual(INFRA_MISS_COLUMNS, ["last_infra_miss_at", "last_infra_miss_reason"])
    assert.deepEqual(buildInfraMissPatch("2026-11-04T12:00:00.000Z", "rpc-transport"), {
      status: "active",
      updated_at: "2026-11-04T12:00:00.000Z",
      last_attempt_at: "2026-11-04T12:00:00.000Z",
      last_infra_miss_at: "2026-11-04T12:00:00.000Z",
      last_infra_miss_reason: "rpc-transport",
    })
  })
})

// ─── Acceptance: the owner's test list ────────────────────────────────────────────────────────

describe("acceptance — auth outage 20 cycles: counter unchanged, order alive, resumes once healthy", () => {
  test("20 rpc-auth misses before the monitor pauses ⇒ consecutive_failures 0, active, reason recorded; then healthy ⇒ one fill", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    const outage = polls(k, r, clock, 20, "auth")
    assert.equal(outage.filter((c) => c.attempted).length, 20, "every cycle attempted (count 0 ⇒ no backoff)")
    assert.ok(outage.every((c) => c.plan.kind === "infra"))
    assert.equal(r.status, "active")
    assert.equal(r.consecutive_failures, 0, "20 misses, counter untouched")
    assert.equal(r.last_infra_miss_reason, "rpc-auth")
    assert.equal(r.last_infra_miss_at, iso(clock.t - POLL))
    assert.equal(r.last_attempt_at, iso(clock.t - POLL))
    assert.equal(r.error, undefined, "no reason code — the order did not fail")
    const healthy = polls(k, r, clock, 3, "healthy")
    assert.deepEqual(healthy.map((c) => c.executed === true || c.why), [true, "not-due", "not-due"], "resumes: exactly ONE chunk, then the contract gate holds")
    assert.equal(r.dca_executed, 1)
    assert.equal(r.consecutive_failures, 0)
  })

  test("while PAUSED (rpc-auth) nothing is attempted: no plan, no patch, the row is byte-identical", () => {
    let paused = "rpc-auth"
    const k = keeperModel({ paused: () => paused })
    const r = row({ consecutive_failures: 2, last_attempt_at: iso(T0 - 86_400_000) })
    const before = JSON.stringify(r)
    const clock = { t: T0 }
    const out = polls(k, r, clock, 20, "auth")
    assert.ok(out.every((c) => c.attempted === false && c.why === "paused"))
    assert.equal(JSON.stringify(r), before)
    paused = null // the balance read answered: the monitor cleared the pause
    assert.equal(k.cycle(r, clock.t, "healthy").executed, true, "the first healthy cycle fills")
  })

  test("a provider outage (503) spanning 2.5 DCA intervals: no counter, and NO back-fill — one chunk on recovery, the next only at lastExec + interval", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    k.cycle(r, clock.t, "healthy") // chunk 1 at T0
    clock.t += POLL
    assert.equal(r.dca_executed, 1)
    const outageCycles = Math.round((2.5 * INTERVAL_SEC * 1000) / POLL) // 300 polls
    const outage = polls(k, r, clock, outageCycles, "outage")
    assert.equal(outage.filter((c) => c.attempted).length, outageCycles)
    assert.equal(r.consecutive_failures, 0)
    assert.equal(r.status, "active")
    assert.equal(r.last_infra_miss_reason, "rpc-transport")
    // recovery: 2 intervals were missed, but the schedule allows ONE chunk now (lastExec + interval ≤ now)…
    const first = k.cycle(r, clock.t, "healthy")
    assert.equal(first.executed, true)
    assert.equal(r.dca_executed, 2)
    const executedAt = clock.t
    clock.t += POLL
    // …and nothing more until a full interval after THAT execution — never two for one interval.
    const untilDue = Math.round((INTERVAL_SEC * 1000) / POLL) - 1
    const held = polls(k, r, clock, untilDue, "healthy")
    assert.ok(held.every((c) => c.why === "not-due"), "the contract gate holds for the whole interval")
    assert.equal(r.dca_executed, 2)
    assert.equal(clock.t, executedAt + INTERVAL_SEC * 1000)
    assert.equal(k.cycle(r, clock.t, "healthy").executed, true, "chunk 3 exactly one interval after chunk 2")
    assert.equal(r.dca_executed, 3)
  })
})

describe("acceptance — order misses count exactly as before", () => {
  test("a sent-and-reverted tx ⇒ counter +1", () => {
    const k = keeperModel()
    const r = row({ consecutive_failures: 4 })
    const plan = k.miss(r, T0, { minedRevert: true })
    assert.equal(plan.kind, "retry")
    assert.equal(r.consecutive_failures, 5)
    assert.equal(r.last_attempt_at, iso(T0))
    assert.deepEqual([plan.cause, plan.causeReason], [MISS_CAUSE.ORDER, "reverted"])
  })

  test("8 order misses ⇒ failed with no_route_after_retries + the one-shot alert, as before", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    const kinds = []
    for (let i = 0; i < CAP; i++) {
      while (k.inBackoff(r, clock.t)) clock.t += POLL
      kinds.push(k.miss(r, clock.t, { minedRevert: true }).kind)
      clock.t += POLL
    }
    assert.deepEqual(kinds, [...Array(CAP - 1).fill("retry"), "fail"])
    assert.equal(r.status, "failed")
    assert.equal(r.error, FAILURE_REASON.NO_ROUTE_AFTER_RETRIES)
    assert.equal(r.consecutive_failures, CAP)
  })

  test("MIXED: 3 order, 20 infra (auth), 4 order ⇒ still active at 7; the 8th ORDER miss fails it (28 attempts, not 8)", () => {
    const k = keeperModel()
    const r = row()
    const clock = { t: T0 }
    const orderMiss = () => {
      while (k.inBackoff(r, clock.t)) clock.t += POLL
      const plan = k.miss(r, clock.t, { minedRevert: true })
      clock.t += POLL
      return plan
    }
    for (let i = 0; i < 3; i++) assert.equal(orderMiss().kind, "retry")
    assert.equal(r.consecutive_failures, 3)
    let infraAttempts = 0
    for (let i = 0; i < 20; i++) {
      while (k.inBackoff(r, clock.t)) clock.t += POLL // count 3 ⇒ the ladder's own backoff still applies
      assert.equal(k.miss(r, clock.t, { err: AUTH() }).kind, "infra")
      infraAttempts++
      clock.t += POLL
    }
    assert.equal(infraAttempts, 20)
    assert.equal(r.consecutive_failures, 3, "20 infra misses did not move it")
    assert.equal(r.status, "active")
    for (let i = 0; i < 4; i++) assert.equal(orderMiss().kind, "retry")
    assert.equal(r.consecutive_failures, 7)
    assert.equal(r.status, "active")
    const last = orderMiss()
    assert.equal(last.kind, "fail")
    assert.equal(r.status, "failed")
    assert.equal(r.consecutive_failures, CAP)
    assert.equal(r.last_infra_miss_reason, "rpc-auth", "the infra trail stays readable on the failed row")
  })

  test("a fill resets the ladder but keeps the infra trail (the 24 h count reads it)", () => {
    const k = keeperModel()
    const r = row({ consecutive_failures: 5 })
    k.miss(r, T0, { err: OUTAGE() })
    assert.equal(r.consecutive_failures, 5)
    k.fill(r, T0 + POLL)
    assert.equal(r.consecutive_failures, 0)
    assert.equal(r.last_infra_miss_reason, "rpc-transport")
  })

  test("backoff after an infra miss: count ≥ 1 ⇒ the window runs from the LAST attempt (infra or order), ≤ 30 min; restart changes nothing", () => {
    const k = keeperModel()
    const r = row({ consecutive_failures: 3, last_attempt_at: iso(T0 - 86_400_000) })
    assert.equal(k.inBackoff(r, T0), false)
    k.miss(r, T0, { err: OUTAGE() })
    assert.equal(k.inBackoff(r, T0 + 1), true)
    assert.equal(k.inBackoff(r, T0 + backoffMs(3)), false)
    k.restart()
    assert.equal(k.inBackoff(r, T0 + 1), true, "the row carries last_attempt_at")
    assert.equal(k.inBackoff(r, T0 + backoffMs(3)), false)
  })
})

// ─── Pre-migration tolerance ──────────────────────────────────────────────────────────────────

describe("the infra columns are tolerated when absent (migration 20261104120000 applied manually)", () => {
  test("stripInfraMissColumns removes exactly the two columns and never mutates its input", () => {
    const patch = buildInfraMissPatch(iso(T0), "rpc-auth")
    const stripped = stripInfraMissColumns(patch)
    assert.deepEqual(stripped, { status: "active", updated_at: iso(T0), last_attempt_at: iso(T0) })
    assert.equal("last_infra_miss_at" in patch, true)
  })
  test("isInfraMissColumnRejection matches PostgREST naming one of OUR columns, not the retry-state ones", () => {
    assert.equal(isInfraMissColumnRejection(`{"code":"PGRST204","message":"Could not find the 'last_infra_miss_at' column of 'orders' in the schema cache"}`), true)
    assert.equal(isInfraMissColumnRejection(`Could not find the 'last_infra_miss_reason' column`), true)
    assert.equal(isInfraMissColumnRejection(`Could not find the 'last_attempt_at' column of 'orders'`), false)
    assert.equal(isInfraMissColumnRejection(""), false)
    assert.equal(isInfraMissColumnRejection(null), false)
  })
})

// ─── executor.js wiring (source anchors) ──────────────────────────────────────────────────────

const executorSource = () => readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
const sliceBetween = (src, start, end) => {
  const a = src.indexOf(start)
  assert.notEqual(a, -1, `anchor not found: ${start}`)
  const b = src.indexOf(end, a)
  assert.notEqual(b, -1, `end anchor not found: ${end}`)
  return src.slice(a, b)
}

describe("executor.js wiring — paused gate, infra log, column tolerance, migration", () => {
  test("while paused the cycle attempts NOTHING: the gate sits between the order fetch and the loop, returns before any lock/tx", () => {
    const gate = sliceBetween(executorSource(), "const orders = await fetchActiveOrders()", "for (const dbOrder of orders) {")
    assert.ok(gate.includes("const pausedState = rpcAuthMonitor ? rpcAuthMonitor.state().paused : null"))
    assert.ok(gate.includes("if (pausedState) {"))
    assert.ok(gate.includes("NOT attempted"))
    assert.ok(gate.includes("return orders.length"))
    for (const forbidden of ["lockOrder(", "writeContract", "handleExecutionFailure(", "patchOrderRow("]) {
      assert.equal(gate.includes(forbidden), false, `the gate must not ${forbidden}`)
    }
  })
  test("handleExecutionFailure logs an infra miss as NOT counted", () => {
    const body = sliceBetween(executorSource(), "async function handleExecutionFailure(", "\nasync function unlockStaleOrders")
    assert.ok(body.includes('plan.kind === "infra"'))
    assert.ok(body.includes("NOT counted"))
  })
  test("patchOrderRow re-sends without the infra columns on the 400 that names them (and leaves the retry-state fallback alone)", () => {
    const body = sliceBetween(executorSource(), "async function patchOrderRow(", "\n// [chore/dca-resilience] Single failure handler")
    assert.equal(body.split("isInfraMissColumnRejection(body)").length - 1, 2, "checked on the first 400 AND after the retry-state re-send (both migrations missing: PostgREST names last_attempt_at first)")
    assert.ok(body.includes("stripInfraMissColumns("))
    assert.ok(body.includes("20261104120000_orders_infra_miss.sql"))
    assert.ok(body.includes("retryStateAvailability.markMissing()"), "the existing sensor is intact")
    assert.ok(body.includes("if (hadRetryState && !retryStateAvailability.isAvailable())"))
  })
  test("the migration exists, is additive + nullable, and schema.sql mirrors it", () => {
    const mig = new URL("../../../supabase/migrations/20261104120000_orders_infra_miss.sql", import.meta.url)
    assert.ok(existsSync(mig), "supabase/migrations/20261104120000_orders_infra_miss.sql")
    const sql = readFileSync(mig, "utf-8")
    assert.match(sql, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_infra_miss_at TIMESTAMPTZ;/)
    assert.match(sql, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_infra_miss_reason TEXT;/)
    const adds = sql.split("\n").filter((l) => /^ALTER TABLE orders ADD COLUMN/.test(l))
    assert.equal(adds.length, 2)
    assert.ok(adds.every((l) => !/NOT NULL|DEFAULT/.test(l)), "nullable, no default — a pre-migration row reads as never missed")
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf-8")
    assert.ok(schema.includes("last_infra_miss_at") && schema.includes("last_infra_miss_reason"))
  })
})
