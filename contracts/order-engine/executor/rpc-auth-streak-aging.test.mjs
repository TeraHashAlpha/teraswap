// [A74 S-10 (L)] An auth streak ended only by a success report from ITS OWN origin. An origin that gets a
// non-auth failure after the key is fixed (a transient 503, a revert, a timeout — none of which touches an
// auth streak) therefore kept its open streak forever, and since A71b S-1 an open streak anywhere holds the
// `paused: rpc-auth` state: the keeper stayed paused (attempting nothing) long after the provider was
// answering. A streak that has seen no NEW auth error for `streakTtlMs` is now aged out — the same condition
// "the provider is still refusing this origin" would have refreshed it — and a count restarts from 1 when its
// last error is older than that.
//
// Auth errors are real viem HttpRequestError objects (a 403 with the provider's words).
//
// Run: node --test contracts/order-engine/executor/rpc-auth-streak-aging.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { HttpRequestError } from "viem"

import * as rpcAuth from "./rpc-auth.js"
import { IDLE_POLL_INTERVAL_MS, POLL_INTERVAL_MS } from "./idle-backoff.js"

const { createRpcAuthMonitor, RPC_AUTH_THRESHOLD } = rpcAuth
// namespace import: on a build without the export the BEHAVIOUR tests below still run (and fail) instead of
// the whole file dying at link time
const RPC_AUTH_STREAK_TTL_MS = rpcAuth.RPC_AUTH_STREAK_TTL_MS ?? 900_000

const URL_ = "https://base-mainnet.g.alchemy.com/v2/TESTKEY"
const AUTH = () => new HttpRequestError({ url: URL_, status: 403, body: { method: "eth_call" }, details: "Unspecified origin not on whitelist." })
const TRANSIENT = () => new HttpRequestError({ url: URL_, status: 503, body: { method: "eth_call" }, details: "Service Unavailable" })
const T0 = Date.parse("2026-11-05T12:00:00.000Z")

function harness(over = {}) {
  const clock = { t: T0 }
  const alerts = []
  const m = createRpcAuthMonitor({ chainId: 8453, now: () => clock.t, alert: async (p) => alerts.push(p), ...over })
  return { m, alerts, clock }
}

describe("[A74 S-10] the default TTL cannot age out an origin that is still being refused", () => {
  test("rpc-auth.js exports it", () => assert.equal(typeof rpcAuth.RPC_AUTH_STREAK_TTL_MS, "number"))
  test("it exceeds the slowest cadence at which a refused origin re-reports (the idle full cycle)", () => {
    assert.ok(RPC_AUTH_STREAK_TTL_MS >= 2 * IDLE_POLL_INTERVAL_MS, `${RPC_AUTH_STREAK_TTL_MS} vs idle ${IDLE_POLL_INTERVAL_MS}`)
    assert.ok(RPC_AUTH_STREAK_TTL_MS > POLL_INTERVAL_MS)
  })
})

describe("[A74 S-10] a streak that gets no new auth error ages out", () => {
  test("the audited deadlock: key fixed, balance-read answers, `cycle` only fails non-auth ⇒ the pause clears", async () => {
    const h = harness()
    for (let i = 0; i < RPC_AUTH_THRESHOLD; i++) await h.m.onRpcError("cycle", AUTH())
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.equal(h.alerts.filter((a) => a.phase === "runtime").length, 1)

    // the key is fixed: the balance read answers, but the cycle now dies of something else every time
    h.clock.t += 60_000
    assert.deepEqual(await h.m.onRpcSuccess("balance-read"), { recovered: false }, "within the TTL the open `cycle` streak still holds the pause")
    await h.m.onRpcError("cycle", TRANSIENT())
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.deepEqual(h.m.state().authStreaks, { cycle: RPC_AUTH_THRESHOLD })

    h.clock.t += RPC_AUTH_STREAK_TTL_MS
    await h.m.onRpcError("cycle", TRANSIENT()) // still not auth: does not refresh the streak
    const r = await h.m.onRpcSuccess("balance-read")
    assert.deepEqual(r, { recovered: true })
    assert.equal(h.m.state().paused, null)
    assert.deepEqual(h.m.state().authStreaks, {})
    assert.equal(h.alerts.filter((a) => a.phase === "recovered").length, 1)
  })

  test("a streak refreshed by a new auth error inside the TTL does NOT age out (the origin is still refused)", async () => {
    const h = harness()
    for (let i = 0; i < RPC_AUTH_THRESHOLD; i++) await h.m.onRpcError("balance-read", AUTH())
    for (let k = 0; k < 6; k++) {
      h.clock.t += RPC_AUTH_STREAK_TTL_MS - 1_000
      assert.deepEqual(await h.m.onRpcSuccess("event-watcher:getLogs"), { recovered: false }, `round ${k}`)
      await h.m.onRpcError("balance-read", AUTH())
    }
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.equal(h.alerts.filter((a) => a.phase === "recovered").length, 0)
  })

  test("a count restarts from 1 when its last auth error is older than the TTL (two stale errors + one new ≠ three consecutive)", async () => {
    const h = harness()
    await h.m.onRpcError("cycle", AUTH())
    await h.m.onRpcError("cycle", AUTH())
    h.clock.t += RPC_AUTH_STREAK_TTL_MS + 1
    await h.m.onRpcError("cycle", AUTH())
    assert.equal(h.m.state().paused, null, "1 fresh error is below the threshold")
    assert.deepEqual(h.m.state().authStreaks, { cycle: 1 })
    assert.equal(h.alerts.length, 0)
    await h.m.onRpcError("cycle", AUTH())
    await h.m.onRpcError("cycle", AUTH())
    assert.equal(h.m.state().paused, "rpc-auth", "three fresh ones still pause")
  })

  test("only the stale origin is dropped: a fresh streak elsewhere still holds the pause", async () => {
    const h = harness()
    for (let i = 0; i < RPC_AUTH_THRESHOLD; i++) await h.m.onRpcError("cycle", AUTH())
    h.clock.t += RPC_AUTH_STREAK_TTL_MS + 1
    await h.m.onRpcError("event-watcher:getLogs", AUTH()) // fresh
    assert.deepEqual(await h.m.onRpcSuccess("balance-read"), { recovered: false })
    assert.deepEqual(h.m.state().authStreaks, { "event-watcher:getLogs": 1 })
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.deepEqual(await h.m.onRpcSuccess("event-watcher:getLogs"), { recovered: true })
  })

  test("the TTL is configurable (streakTtlMs) and a transient error never refreshes a streak", async () => {
    const h = harness({ streakTtlMs: 1_000 })
    for (let i = 0; i < RPC_AUTH_THRESHOLD; i++) await h.m.onRpcError("cycle", AUTH())
    h.clock.t += 900
    await h.m.onRpcError("cycle", TRANSIENT())
    h.clock.t += 900 // 1 800 ms since the last AUTH error
    assert.deepEqual(await h.m.onRpcSuccess("balance-read"), { recovered: true })
  })
})
