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
  recordInfraMiss,
  clearInfraMisses,
  RETRY_BACKOFF_MAX_MS,
  INFRA_ALERT_STREAK,
  INFRA_ALERT_AFTER_MS,
  INFRA_ALERT_COOLDOWN_MS,
  UNRECOGNISED_INFRA_REASONS,
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
  let infra = new Map() // executor.js orderInfraMisses — the floor backoff for infra misses [A73 S-1]
  const chain = { lastExec: 0 } // dcaLastExecution[hash] — 0 until the first chunk
  const m = {
    restart() {
      cache = new Map()
      infra = new Map()
    },
    inBackoff(r, nowMs) {
      const s = cache.get(r.id) || readPersistedRetryState(r)
      if (isInBackoffWindow({ count: s.count, lastAttempt: s.lastAttempt, nowMs })) return true
      const i = infra.get(r.id) // mirrors the executor's gate: the infra streak backs off at the ladder's cadence
      return !!i && isInBackoffWindow({ count: i.streak, lastAttempt: i.lastAttempt, nowMs })
    },
    infraStreak(r) {
      return infra.get(r.id)?.streak ?? 0
    },
    miss(r, nowMs, failure) {
      const plan = planFailureHandling({ dbOrder: r, ...failure, paused: paused(), nowSec: sec(nowMs), nowIso: iso(nowMs) })
      Object.assign(r, plan.patch)
      if (plan.clearRetries) cache.delete(r.id)
      else cache.set(r.id, { count: plan.failures, lastAttempt: nowMs })
      if (plan.kind === "infra") recordInfraMiss(infra, r.id, { reason: plan.causeReason, nowMs })
      else clearInfraMisses(infra, r.id)
      return plan
    },
    fill(r, nowMs) {
      chain.lastExec = sec(nowMs)
      cache.delete(r.id)
      clearInfraMisses(infra, r.id)
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
    // [A73 S-1] the floor backoff: attempts follow the ladder's cadence (30 s, 60 s, 120 s, 240 s, 480 s …),
    // never every tick — 5 attempts in 20 polls (10 min), the ladder counter still untouched.
    const attempts = outage.filter((c) => c.attempted)
    assert.equal(attempts.length, 5, "ladder cadence, not every tick")
    assert.ok(attempts.every((c) => c.plan.kind === "infra"))
    assert.equal(k.infraStreak(r), 5)
    assert.equal(r.status, "active")
    assert.equal(r.consecutive_failures, 0, "20 misses, counter untouched")
    assert.equal(r.last_infra_miss_reason, "rpc-auth")
    assert.equal(r.last_infra_miss_at, iso(T0 + 450_000), "the 5th attempt (0 + 30 + 60 + 120 + 240 s)")
    assert.equal(r.last_attempt_at, iso(T0 + 450_000))
    assert.equal(r.error, undefined, "no reason code — the order did not fail")
    clock.t = T0 + 450_000 + backoffMs(5) // the 5th miss's window elapses; the provider is back
    const healthy = polls(k, r, clock, 3, "healthy")
    assert.deepEqual(healthy.map((c) => c.executed === true || c.why), [true, "not-due", "not-due"], "resumes: exactly ONE chunk, then the contract gate holds")
    assert.equal(k.infraStreak(r), 0, "a fill clears the infra streak")
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
    const attempted = outage.filter((c) => c.attempted).length
    assert.ok(attempted >= 8 && attempted <= 12, `ladder cadence capped at ${RETRY_BACKOFF_MAX_MS / 60_000} min: ~10 attempts in 2.5 h, got ${attempted}`)
    assert.equal(r.consecutive_failures, 0)
    assert.equal(r.status, "active")
    assert.equal(r.last_infra_miss_reason, "rpc-transport")
    // recovery: 2 intervals were missed, but the schedule allows ONE chunk now (lastExec + interval ≤ now)…
    while (k.inBackoff(r, clock.t)) clock.t += POLL // the last infra window (≤ 30 min) elapses
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

// ─── [A73 S-1] The floor backoff: infra misses space out at the ladder's cadence, counting nothing ─

describe("recordInfraMiss / clearInfraMisses — in-memory infra streak, ladder cadence, no counting", () => {
  test("each infra miss raises the streak and the backoff follows backoffMs(streak), capped at the ladder's max", () => {
    const map = new Map()
    const seen = []
    for (let i = 1; i <= 12; i++) seen.push(recordInfraMiss(map, "o-1", { reason: "rpc-transport", nowMs: T0 + i * 1000 }))
    assert.deepEqual(seen.map((s) => s.streak), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.deepEqual(seen.map((s) => s.backoffMs), seen.map((_, i) => backoffMs(i + 1)))
    assert.equal(seen[11].backoffMs, RETRY_BACKOFF_MAX_MS)
    assert.equal(map.get("o-1").lastAttempt, T0 + 12_000)
    assert.equal(map.get("o-1").reason, "rpc-transport")
  })
  test("the streak is per order and clearInfraMisses drops exactly that order", () => {
    const map = new Map()
    recordInfraMiss(map, "a", { reason: "rpc-auth", nowMs: T0 })
    recordInfraMiss(map, "b", { reason: "rpc-auth", nowMs: T0 })
    recordInfraMiss(map, "a", { reason: "rpc-auth", nowMs: T0 + 1 })
    assert.equal(map.get("a").streak, 2)
    assert.equal(map.get("b").streak, 1)
    clearInfraMisses(map, "a")
    assert.equal(map.has("a"), false)
    assert.equal(map.get("b").streak, 1)
    clearInfraMisses(map, "never-seen") // tolerant
  })
  test("an ORDER miss resets the infra streak (consecutive infra misses only), as does a fill", () => {
    const k = keeperModel()
    const r = row()
    k.miss(r, T0, { err: OUTAGE() })
    k.miss(r, T0 + 60_000, { err: OUTAGE() })
    assert.equal(k.infraStreak(r), 2)
    k.miss(r, T0 + 200_000, { minedRevert: true })
    assert.equal(k.infraStreak(r), 0, "an order miss ends the infra streak")
    assert.equal(r.consecutive_failures, 1)
    k.miss(r, T0 + 300_000, { err: OUTAGE() })
    assert.equal(k.infraStreak(r), 1)
    k.fill(r, T0 + 400_000)
    assert.equal(k.infraStreak(r), 0)
  })
  test("the gate honours the infra window: with count 0 the 2nd poll after an infra miss is skipped, the ladder window still applies on top", () => {
    const k = keeperModel()
    const r = row()
    k.miss(r, T0, { err: OUTAGE() }) // streak 1 ⇒ 30 s
    assert.equal(k.inBackoff(r, T0 + 1), true)
    assert.equal(k.inBackoff(r, T0 + backoffMs(1)), false)
    k.miss(r, T0 + backoffMs(1), { err: OUTAGE() }) // streak 2 ⇒ 60 s
    assert.equal(k.inBackoff(r, T0 + backoffMs(1) + backoffMs(2) - 1), true)
    assert.equal(k.inBackoff(r, T0 + backoffMs(1) + backoffMs(2)), false)
    assert.equal(r.consecutive_failures, 0, "no counting")
  })
  test("executor.js wiring: the cycle gate reads orderInfraMisses next to orderRetries; handleExecutionFailure records / clears it", () => {
    const src = executorSource()
    assert.ok(src.includes("const orderInfraMisses = new Map()"))
    const gate = sliceBetween(src, "const retryState = orderRetries.get(dbOrder.id) || readPersistedRetryState(dbOrder)", "// Atomic lock")
    assert.ok(gate.includes("const infraState = orderInfraMisses.get(dbOrder.id)"))
    assert.ok(gate.includes("isInBackoffWindow({ count: infraState.streak, lastAttempt: infraState.lastAttempt, nowMs: Date.now() })"))
    const handler = sliceBetween(src, "async function handleExecutionFailure(", "\nasync function unlockStaleOrders")
    assert.ok(handler.includes("recordInfraMiss(orderInfraMisses, dbOrder.id, { reason: plan.causeReason, nowMs: Date.now() })"))
    assert.ok(handler.includes("clearInfraMisses(orderInfraMisses, dbOrder.id)"))
    const fill = sliceBetween(src, "// [DCA-OBS] A successful execution clears the consecutive-failure signal.", "const now = new Date().toISOString()")
    assert.ok(fill.includes("clearInfraMisses(orderInfraMisses, dbOrder.id)"), "a fill clears the infra streak too")
  })
})

// ─── [A73 C(3) / C(1)] An UNRECOGNISED infra streak pages ops; the order is still never burned ──
// `unclassified` (a throw no rule recognised), `swap-api:misroute` and `keeper-config` are not an
// outage that heals by itself — they are most likely OUR bug or config. Per order, in memory: at N
// consecutive such misses (≈20, or ~10 min under the floor backoff) ONE high-urgency alertOps naming
// the order and the reason, then at most once per hour while it persists. Any other infra reason,
// an order miss or a fill resets the streak.

describe("recordInfraMiss — the unrecognised-infra streak alert [A73 C(3) / C(1)]", () => {
  const MIN = 60_000
  test("the constants and the reason set", () => {
    assert.equal(INFRA_ALERT_STREAK, 20)
    assert.equal(INFRA_ALERT_AFTER_MS, 10 * MIN)
    assert.equal(INFRA_ALERT_COOLDOWN_MS, 60 * MIN)
    assert.deepEqual([...UNRECOGNISED_INFRA_REASONS], ["unclassified", "swap-api:misroute", "keeper-config"])
  })
  test("20 consecutive unclassified misses in quick succession ⇒ alert exactly on the 20th; then silent for an hour; then once more", () => {
    const map = new Map()
    const alerts = []
    for (let i = 1; i <= 25; i++) {
      const r = recordInfraMiss(map, "o-1", { reason: "unclassified", nowMs: T0 + i * 1000 })
      if (r.alert) alerts.push(i)
      assert.equal(r.unrecognisedStreak, i)
    }
    assert.deepEqual(alerts, [20], "one alert at N, none for the 21st–25th (cooldown)")
    const alertedAt = T0 + 20_000
    assert.equal(recordInfraMiss(map, "o-1", { reason: "unclassified", nowMs: alertedAt + INFRA_ALERT_COOLDOWN_MS - 1 }).alert, false)
    assert.equal(recordInfraMiss(map, "o-1", { reason: "unclassified", nowMs: alertedAt + INFRA_ALERT_COOLDOWN_MS }).alert, true, "re-armed after the cooldown while it persists")
  })
  test("under the floor backoff the time rule fires first: ladder-spaced unclassified misses alert once ~10 min have passed (the 6th, at 15.5 min)", () => {
    const map = new Map()
    let t = T0
    const outcomes = []
    for (let i = 1; i <= 8; i++) {
      const r = recordInfraMiss(map, "o-1", { reason: "keeper-config", nowMs: t })
      outcomes.push([Math.round((t - T0) / 1000), r.alert])
      t += r.backoffMs
    }
    // misses at 0, 30, 90, 210, 450, 930, 1890 … s — the first ≥ 600 s after the streak began is the 6th
    assert.deepEqual(outcomes, [[0, false], [30, false], [90, false], [210, false], [450, false], [930, true], [1890, false], [3690, false]])
  })
  test("a recognised infra reason never alerts and RESETS the unrecognised streak; misroute and keeper-config count like unclassified", () => {
    const map = new Map()
    for (let i = 1; i <= 50; i++) assert.equal(recordInfraMiss(map, "o-1", { reason: "rpc-transport", nowMs: T0 + i }).alert, false)
    assert.equal(map.get("o-1").unrecognisedStreak, 0)
    for (let i = 1; i <= 19; i++) recordInfraMiss(map, "o-1", { reason: i % 2 ? "swap-api:misroute" : "keeper-config", nowMs: T0 + 100 + i })
    assert.equal(map.get("o-1").unrecognisedStreak, 19)
    recordInfraMiss(map, "o-1", { reason: "rpc-auth", nowMs: T0 + 200 }) // a real outage in between
    assert.equal(map.get("o-1").unrecognisedStreak, 0, "the unrecognised run is broken")
    assert.equal(map.get("o-1").streak, 70, "the floor-backoff streak keeps counting every infra miss")
    assert.equal(recordInfraMiss(map, "o-1", { reason: "unclassified", nowMs: T0 + 201 }).alert, false, "starts again at 1")
  })
  test("an order miss or a fill resets everything; the order was never burned", () => {
    const k = keeperModel()
    const r = row()
    let t = T0
    for (let i = 0; i < 20; i++) k.miss(r, (t += 1000), { err: new TypeError("Cannot read properties of undefined (reading 'x')") })
    assert.equal(k.infraStreak(r), 20)
    assert.equal(r.consecutive_failures, 0)
    assert.equal(r.status, "active")
    k.miss(r, (t += 1000), { minedRevert: true })
    assert.equal(k.infraStreak(r), 0)
    assert.equal(r.consecutive_failures, 1)
  })
  test("executor.js wiring: the handler sends ONE high-urgency alertOps naming order + reason when recordInfraMiss says so", () => {
    const src = executorSource()
    assert.ok(src.includes('import { computeFreezeScore, scoreTier, TIER_WARN_THRESHOLD, TIER_CRITICAL_THRESHOLD } from "./freeze-score.js"'), "high urgency = the critical tier")
    const handler = sliceBetween(src, "async function handleExecutionFailure(", "\nasync function unlockStaleOrders")
    assert.ok(handler.includes("if (infra.alert) {"))
    assert.ok(handler.includes('kind: "infra-miss-streak"'))
    assert.ok(handler.includes("TIER_CRITICAL_THRESHOLD,"))
    assert.ok(/detail: `Order \$\{dbOrder\.id\}[^`]*\$\{plan\.causeReason\}/.test(handler), "names the order and the reason")
    assert.ok(/detail: `[^`]*NOT counted/.test(handler), "says the order is not burned")
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
    // [A73 S-5] the partial index is mirrored in schema.sql, and the OPS note tells the owner to build it
    // CONCURRENTLY on the live table (outside a transaction).
    assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_orders_last_infra_miss_at\s+ON orders \(chain_id, last_infra_miss_at\)\s+WHERE last_infra_miss_at IS NOT NULL;/)
    assert.match(sql, /CREATE INDEX CONCURRENTLY/, "the OPS comment names the CONCURRENTLY form")
    assert.match(sql, /outside a transaction|cannot run inside a transaction/i)
  })
})

describe("executor.js wiring — /health counts infra misses and paused cycles (ADR-026 §5)", () => {
  test("stats.infraMisses / stats.pausedCycles exist, are incremented at the two sites, and are served on /health", () => {
    const src = executorSource()
    const stats = sliceBetween(src, "const stats = {", "\n}")
    assert.ok(stats.includes("infraMisses: 0,"))
    assert.ok(stats.includes("pausedCycles: 0,"))
    const handler = sliceBetween(src, "async function handleExecutionFailure(", "\nasync function unlockStaleOrders")
    assert.ok(handler.includes("stats.infraMisses++"))
    const gate = sliceBetween(src, "const pausedState = rpcAuthMonitor ? rpcAuthMonitor.state().paused : null", "return orders.length")
    assert.ok(gate.includes("stats.pausedCycles++"))
    const health = sliceBetween(src, 'if (req.url === "/health"', 'else if (req.url === "/")')
    assert.ok(health.includes("infraMisses: stats.infraMisses,"))
    assert.ok(health.includes("pausedCycles: stats.pausedCycles,"))
  })
})
