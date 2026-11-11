// [A74 S-11 (L)] runTick reported `onRpcSuccess("cycle")` after EVERY executeCycle that did not throw —
// including the paused branch, which returns `orders.length` having attempted nothing (no lock, no tx, no
// retry count: ADR-026 §3). A cycle that tried nothing is no evidence that the "cycle" origin works, so a
// `cycle` auth streak was wiped by the very cycles that were paused because of it: the pause cleared
// without a single successful attempt, the next cycle attempted, was refused three more times, paused again,
// alerted again — a flap. A paused cycle now reports nothing for "cycle"; with S-10's aging it cannot hold
// the pause forever (the streak ends when it stops being refreshed).
//
// The real runTick SOURCE is extracted from executor.js and run against a real rpc-auth monitor with fake
// dependencies, so the wiring under test is the shipped text, not a model of it.
//
// Auth errors are real viem HttpRequestError objects.
//
// Run: node --test contracts/order-engine/executor/executor-paused-cycle.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { HttpRequestError } from "viem"

import { createRpcAuthMonitor, RPC_AUTH_THRESHOLD } from "./rpc-auth.js"
import * as rpcAuth from "./rpc-auth.js"

const TTL = rpcAuth.RPC_AUTH_STREAK_TTL_MS ?? 900_000
const URL_ = "https://base-mainnet.g.alchemy.com/v2/TESTKEY"
const AUTH = () => new HttpRequestError({ url: URL_, status: 403, body: { method: "eth_call" }, details: "Unspecified origin not on whitelist." })
const T0 = Date.parse("2026-11-05T12:00:00.000Z")

const SRC = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
function sliceBetween(src, from, to) {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `anchor not found in executor.js: ${JSON.stringify(from)}`)
  const b = src.indexOf(to, a + from.length)
  assert.ok(b >= 0, `end anchor not found after ${JSON.stringify(from)}`)
  return src.slice(a, b + to.length)
}
const RUN_TICK_SRC = sliceBetween(SRC, "async function runTick() {", "\n  }\n")
const makeRunTick = new Function(
  "d",
  `const { cadence, unlockStaleOrders, fetchActiveOrders, log, executeCycle, publicClient, walletClient, flashbotsPublicClient,
    flashbotsWalletClient, monitor, rpcAuthMonitor, stats, watcher, IDLE_POLL_INTERVAL_MS, POLL_INTERVAL_MS } = d
   return (${RUN_TICK_SRC})`,
)

/** A keeper around the SHIPPED runTick. executeCycle mimics the real one: it starts with the balance read
 *  (reported to the monitor as "balance-read"), then takes the paused branch (stats.pausedCycles++, return
 *  the order count) when the monitor says paused, else "attempts" and returns the count. */
function keeper({ balanceReadAuthFails = true } = {}) {
  const clock = { t: T0 }
  const alerts = []
  const stats = { pausedCycles: 0 }
  const successes = []
  const monitor = createRpcAuthMonitor({ chainId: 8453, now: () => clock.t, alert: async (p) => alerts.push(p) })
  const rpcAuthMonitor = {
    onRpcError: (o, e) => monitor.onRpcError(o, e),
    onRpcSuccess: (o) => (successes.push(o), monitor.onRpcSuccess(o)),
    state: () => monitor.state(),
  }
  const world = { attempts: 0, cycleThrows: null }
  const cycleCalls = []
  const deps = {
    cadence: { tick: () => "cycle", record() {}, isIdle: () => false },
    unlockStaleOrders: async () => {},
    fetchActiveOrders: async () => [{}],
    log() {},
    publicClient: {},
    walletClient: {},
    flashbotsPublicClient: null,
    flashbotsWalletClient: null,
    monitor: null,
    rpcAuthMonitor,
    stats,
    watcher: { setIdle() {} },
    IDLE_POLL_INTERVAL_MS: 300_000,
    POLL_INTERVAL_MS: 30_000,
    executeCycle: async () => {
      cycleCalls.push(clock.t)
      if (world.cycleThrows) throw world.cycleThrows
      // the cycle-start balance read
      if (balanceReadAuthFails) await rpcAuthMonitor.onRpcError("balance-read", AUTH())
      else await rpcAuthMonitor.onRpcSuccess("balance-read")
      if (rpcAuthMonitor.state().paused) {
        stats.pausedCycles++
        return 5 // the real paused branch: attempted nothing
      }
      world.attempts++
      return 5
    },
  }
  const runTick = makeRunTick(deps)
  return { runTick, monitor, rpcAuthMonitor, clock, alerts, stats, successes, world, cycleCalls, setBalanceRead: (ok) => (balanceReadAuthFails = !ok) }
}

describe("[A74 S-11] runTick (shipped source)", () => {
  test("anchor: the paused branch still counts itself in stats.pausedCycles and returns the order count", () => {
    const gate = sliceBetween(SRC, "const pausedState = rpcAuthMonitor ? rpcAuthMonitor.state().paused : null", "return orders.length")
    assert.ok(gate.includes("stats.pausedCycles++"))
  })

  test("a paused cycle attempted nothing ⇒ no success for the `cycle` origin; its open streak and the pause stay", async () => {
    const k = keeper()
    for (let i = 0; i < RPC_AUTH_THRESHOLD; i++) await k.rpcAuthMonitor.onRpcError("cycle", AUTH()) // a thrown cycle, 3×
    assert.equal(k.monitor.state().paused, "rpc-auth")
    assert.deepEqual(k.monitor.state().authStreaks.cycle, RPC_AUTH_THRESHOLD)

    // the provider is STILL refusing balance-read here; cycles keep being paused
    for (let i = 0; i < 4; i++) {
      k.clock.t += 30_000
      await k.runTick()
    }
    assert.equal(k.stats.pausedCycles, 4)
    assert.equal(k.successes.filter((o) => o === "cycle").length, 0, `"cycle" was reported successful by a paused cycle: ${k.successes}`)
    assert.equal(k.monitor.state().authStreaks.cycle, RPC_AUTH_THRESHOLD, "the cycle streak was wiped by a cycle that attempted nothing")
    assert.equal(k.monitor.state().paused, "rpc-auth")
    assert.equal(k.alerts.filter((a) => a.phase === "recovered").length, 0, "no false recovery")
  })

  test("a cycle that really ran still reports success for `cycle` (the healthy path is unchanged)", async () => {
    const k = keeper({ balanceReadAuthFails: false })
    await k.runTick()
    assert.equal(k.stats.pausedCycles, 0)
    assert.equal(k.world.attempts, 1)
    assert.deepEqual(k.successes, ["balance-read", "cycle"])
  })

  test("a cycle that trips the pause DURING itself (its own balance read) is a paused cycle too: no `cycle` success", async () => {
    const k = keeper()
    await k.rpcAuthMonitor.onRpcError("balance-read", AUTH())
    await k.rpcAuthMonitor.onRpcError("balance-read", AUTH()) // 2 of 3
    await k.runTick() // the 3rd comes inside executeCycle ⇒ paused
    assert.equal(k.monitor.state().paused, "rpc-auth")
    assert.equal(k.stats.pausedCycles, 1)
    assert.equal(k.successes.filter((o) => o === "cycle").length, 0)
  })

  test("the key is fixed while the pause is held by a `cycle` streak: no deadlock — it clears within the streak TTL", async () => {
    const k = keeper()
    for (let i = 0; i < RPC_AUTH_THRESHOLD; i++) await k.rpcAuthMonitor.onRpcError("cycle", AUTH())
    k.setBalanceRead(true) // fixed: the balance read now answers
    let clearedAt = null
    for (let elapsed = 0; elapsed <= TTL + 120_000; elapsed += 30_000) {
      k.clock.t = T0 + elapsed
      await k.runTick()
      if (k.monitor.state().paused === null) {
        clearedAt = elapsed
        break
      }
    }
    assert.notEqual(clearedAt, null, "still paused after the TTL: the pause deadlocked")
    assert.ok(clearedAt > 0, "the pause must not clear while the `cycle` streak is still fresh")
    assert.ok(clearedAt <= TTL + 60_000, `cleared after ${clearedAt} ms`)
    assert.equal(k.alerts.filter((a) => a.phase === "recovered").length, 1)
    // …and the cycle that found it cleared really attempted, and was then reported as a success
    assert.ok(k.world.attempts >= 1)
    assert.ok(k.successes.includes("cycle"))
  })

  test("a thrown cycle reports no success (unchanged)", async () => {
    const k = keeper({ balanceReadAuthFails: false })
    k.world.cycleThrows = new Error("boom")
    await assert.rejects(k.runTick(), /boom/)
    assert.equal(k.successes.length, 0)
  })
})
