// [PERF-KEEPER-IDLE-BACKOFF] Acceptance tests for the keeper's orders-driven idle backoff.
//
// Measured (Alchemy, August 2026): on a day with ZERO active orders the keeper still issued
// 5,760 eth_getBalance + 5,760 eth_getLogs + 2,880 eth_blockNumber + 2,880 eth_call — every 30s
// cycle did its full RPC work while fetchActiveOrders() returned 0 rows. Two levers live in
// idle-backoff.js (pure, exercised here through a model of the keeper loop that mirrors ONE block
// of executor.js each — the executor.js WIRING is pinned by source anchors below, the same
// technique as retry-cap-restart.test.mjs, since executor.js auto-runs main() on import):
//
//   Task 2 — cadence: a cycle that finds 0 orders puts the keeper in IDLE; the next RPC cycle (and
//            the event-watcher poll) runs after IDLE_POLL_INTERVAL_MS. The first cycle that finds
//            ≥1 order returns both to POLL_INTERVAL_MS. The Supabase probe (unlockStaleOrders +
//            fetchActiveOrders, exactly the DB calls every cycle makes today) stays at
//            POLL_INTERVAL_MS while idle, so a NEW order promotes the keeper within one poll —
//            RPC backs off, the DB read does not.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS, createIdleCadence } from "./idle-backoff.js"

// ─── Constants ────────────────────────────────────────────────────────────────────────────────

describe("constants", () => {
  test("POLL_INTERVAL_MS is the keeper's 30s; IDLE_POLL_INTERVAL_MS is 300s (the owner may lower it)", () => {
    assert.equal(POLL_INTERVAL_MS, 30_000)
    assert.equal(IDLE_POLL_INTERVAL_MS, 300_000)
    assert.ok(IDLE_POLL_INTERVAL_MS > POLL_INTERVAL_MS, "idle must back OFF, never poll faster than active")
  })
})

// ─── Task 2: cadence ──────────────────────────────────────────────────────────────────────────

/**
 * executor.js's main loop, reduced to the tick it runs every POLL_INTERVAL_MS (cited inline):
 *   cadence.tick() === "probe"  ⇒ DB-only probe; 0 rows ⇒ return (no RPC this tick)
 *   otherwise                    ⇒ executeCycle (the RPC cycle) then cadence.record(activeOrders)
 * `ordersAt(t)` is what Supabase holds at time t. Returns the times of the RPC cycles.
 */
function runLoop({ cadence, ordersAt, untilMs }) {
  const rpcCyclesAt = []
  const probesAt = []
  for (let t = 0; t <= untilMs; t += POLL_INTERVAL_MS) {
    if (cadence.tick() === "probe") {
      probesAt.push(t)
      if (ordersAt(t) === 0) continue
    }
    rpcCyclesAt.push(t)
    cadence.record(ordersAt(t))
  }
  return { rpcCyclesAt, probesAt }
}

const deltas = (times) => times.slice(1).map((t, i) => t - times[i])

describe("createIdleCadence — 0 orders ⇒ next RPC cycle at the idle interval; ≥1 order ⇒ 30s; both transitions", () => {
  test("boots ACTIVE: the first tick is a full RPC cycle, never a probe", () => {
    const cadence = createIdleCadence()
    assert.equal(cadence.isIdle(), false)
    assert.equal(cadence.tick(), "rpc")
  })

  test("with ≥1 active order every cycle the cadence is exactly today's: an RPC cycle every 30s, no probes", () => {
    const { rpcCyclesAt, probesAt } = runLoop({ cadence: createIdleCadence(), ordersAt: () => 1, untilMs: 600_000 })
    assert.equal(rpcCyclesAt.length, 21, "0s, 30s, …, 600s")
    assert.deepEqual(new Set(deltas(rpcCyclesAt)), new Set([POLL_INTERVAL_MS]))
    assert.deepEqual(probesAt, [])
  })

  test("0 orders ⇒ the next RPC cycle runs after IDLE_POLL_INTERVAL_MS; the DB probe keeps polling every 30s", () => {
    const { rpcCyclesAt, probesAt } = runLoop({ cadence: createIdleCadence(), ordersAt: () => 0, untilMs: 900_000 })
    assert.deepEqual(rpcCyclesAt, [0, 300_000, 600_000, 900_000])
    assert.deepEqual(new Set(deltas(rpcCyclesAt)), new Set([IDLE_POLL_INTERVAL_MS]))
    // Every other 30s tick was a DB-only probe.
    const everyTick = []
    for (let t = POLL_INTERVAL_MS; t <= 900_000; t += POLL_INTERVAL_MS) everyTick.push(t)
    assert.deepEqual(probesAt, everyTick.filter((t) => !rpcCyclesAt.includes(t)))
  })

  test("transition active → idle → active: 30s, then 300s, then a new order promotes at the next 30s probe, then 30s again", () => {
    // Orders: present until 100s; none until 700s (appears at 700s); none again from 1_000s.
    const ordersAt = (t) => (t <= 100_000 ? 1 : t < 700_000 ? 0 : t < 1_000_000 ? 1 : 0)
    const { rpcCyclesAt } = runLoop({ cadence: createIdleCadence(), ordersAt, untilMs: 1_500_000 })
    assert.deepEqual(rpcCyclesAt, [
      0, 30_000, 60_000, 90_000, // active: every 30s
      120_000, // finds 0 ⇒ idle
      420_000, // idle: +300s, still 0
      720_000, // the 30s probe at 720s finds the order that appeared at 700s ⇒ full cycle NOW (≤ 30s after creation)
      750_000, 780_000, 810_000, 840_000, 870_000, 900_000, 930_000, 960_000, 990_000, // active again: every 30s
      1_020_000, // finds 0 ⇒ idle
      1_320_000, // +300s
    ])
  })

  test("a new order is noticed within ONE poll interval of appearing, wherever in the idle window it lands", () => {
    for (const appearsAt of [305_000, 450_000, 599_000]) {
      const ordersAt = (t) => (t === 0 ? 0 : t >= appearsAt ? 1 : 0)
      const { rpcCyclesAt } = runLoop({ cadence: createIdleCadence(), ordersAt, untilMs: appearsAt + 60_000 })
      const promoted = rpcCyclesAt.find((t) => t >= appearsAt)
      assert.ok(promoted - appearsAt < POLL_INTERVAL_MS, `order at ${appearsAt} promoted at ${promoted}`)
    }
  })

  test("idle interval is expressed in whole 30s ticks (ceil): a non-multiple never polls FASTER than asked", () => {
    const cadence = createIdleCadence({ pollIntervalMs: 30_000, idlePollIntervalMs: 100_000 })
    cadence.record(0)
    const due = []
    for (let tick = 1; tick <= 12; tick += 1) {
      if (cadence.tick() === "rpc") {
        due.push(tick)
        cadence.record(0)
      }
    }
    assert.deepEqual(due, [4, 8, 12], "due every 4 ticks = 120s ≥ 100s, never at 3 ticks = 90s")
  })
})

// ─── Wiring — executor.js really drives the cadence and the watcher ───────────────────────────

describe("executor.js wiring (source anchors) — the loop backs RPC off, not the DB read", () => {
  test("the poll constants come from idle-backoff.js (single source of truth)", () => {
    const src = executorSource()
    for (const name of ["POLL_INTERVAL_MS", "IDLE_POLL_INTERVAL_MS", "createIdleCadence"]) {
      assert.ok(
        new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./idle-backoff\\.js"`).test(src),
        `${name} is imported from ./idle-backoff.js`,
      )
    }
    assert.equal(/^const POLL_INTERVAL_MS = /m.test(src), false, "no second definition of the poll interval")
  })

  test("executeCycle reports the number of active orders it found (0 on the no-orders branch)", () => {
    const body = sliceBetween(executorSource(), "async function executeCycle(", "\n// ---- Stats tracking")
    const noOrders = sliceBetween(body, "if (orders.length === 0) {", "\n  }")
    assert.ok(noOrders.includes("return 0"), "0 orders ⇒ returns 0")
    assert.ok(body.endsWith("  return orders.length\n}\n\n// ---- Stats tracking"), "the active path returns the count")
  })

  test("the tick: idle ⇒ DB-only probe (the same two Supabase calls as a cycle), 0 rows ⇒ no RPC; then the RPC cycle records the count and pushes the mode to the watcher", () => {
    const tick = sliceBetween(executorSource(), "async function runTick() {", "\n  }\n")
    const probe = sliceBetween(tick, 'if (cadence.tick() === "probe") {', "\n    }")
    assert.ok(probe.includes("await unlockStaleOrders()"), "probe unlocks stale rows, as every cycle does")
    assert.ok(probe.includes("await fetchActiveOrders()"), "probe reads active orders")
    assert.ok(probe.includes("length === 0) return"), "0 rows ⇒ return before ANY RPC")
    assert.equal(probe.includes("publicClient."), false, "the probe never touches the RPC")
    assert.equal(probe.includes("executeCycle("), false)
    assert.ok(tick.includes("const activeOrders = await executeCycle("), "the RPC cycle's count is captured")
    assert.ok(tick.includes("cadence.record(activeOrders)"), "and recorded")
    assert.ok(tick.includes("watcher.setIdle(cadence.isIdle())"), "and pushed to the event watcher")
  })

  test("the interval still fires every POLL_INTERVAL_MS (the probe cadence) and runs the tick, not executeCycle directly", () => {
    const main = sliceBetween(executorSource(), "async function main() {", "\n}\n")
    assert.ok(main.includes("const watcher = startEventWatcher(publicClient, watchedContracts, monitor)"))
    assert.ok(main.includes("const cadence = createIdleCadence()"))
    assert.ok(main.includes("await runTick()"), "boot runs the tick (ACTIVE ⇒ a full cycle)")
    const interval = sliceBetween(main, "setInterval(async () => {", "}, POLL_INTERVAL_MS)")
    assert.ok(interval.includes("await runTick()"))
    assert.equal(interval.includes("executeCycle("), false)
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
