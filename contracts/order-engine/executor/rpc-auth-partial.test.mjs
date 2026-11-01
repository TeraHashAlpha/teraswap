// [A71 M-1] A PARTIAL rejection must still be alerted, and a legacy alert is muted only while paused.
//
// The audited head reset the auth streak on ANY origin's success and muted the legacy alerts
// (event-watcher "Degraded", executor "Ops issue: rpc", monitor consecutive-errors) for every
// auth-CLASSIFIED error. A provider that answers getBlockNumber but refuses getLogs therefore never
// reached the threshold AND had its Degraded alert muted: 50 alternating success/auth calls ⇒ 0 alerts.
//
// Run: node --test contracts/order-engine/executor/rpc-auth-partial.test.mjs

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"
import { HttpRequestError } from "viem"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { createRpcAuthMonitor } = await import("./rpc-auth.js")
const { alertRpcAuth } = await import("./alert.js")
const { startEventWatcher } = await import("./event-watcher.js")

const KEY = "TESTKEY"
const URL_ = `https://base-mainnet.g.alchemy.com/v2/${KEY}`
const ADDR = "0x1111111111111111111111111111111111111111"
const AUTH = () => new HttpRequestError({ url: URL_, status: 403, body: { method: "eth_getLogs" }, details: "Unspecified origin not on whitelist." })
const TRANSIENT = () => new HttpRequestError({ url: URL_, status: 503, body: { method: "eth_blockNumber" }, details: "Service Unavailable" })
const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

function harness() {
  const alerts = []
  const m = createRpcAuthMonitor({ chainId: 8453, now: () => Date.parse("2026-10-30T15:00:00.000Z"), alert: async (p) => alerts.push(p) })
  return { m, alerts }
}

describe("[A71 M-1] the monitor: one streak per origin/method", () => {
  test("50 alternating success/auth calls (getBlockNumber ok, getLogs refused) ⇒ the alert fires and paused is set", async () => {
    const h = harness()
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) await h.m.onRpcSuccess("event-watcher:getBlockNumber")
      else await h.m.onRpcError("event-watcher:getLogs", AUTH())
    }
    assert.equal(h.alerts.length, 1, "one rate-limited runtime alert")
    assert.equal(h.alerts[0].phase, "runtime")
    assert.equal(h.alerts[0].origin, "event-watcher:getLogs")
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.equal(h.m.state().authStreaks["event-watcher:getLogs"], 25)
    // the method that works is no evidence for the one that is refused
    assert.deepEqual(await h.m.onRpcSuccess("event-watcher:getBlockNumber"), { recovered: false })
    assert.equal(h.m.state().paused, "rpc-auth")
    // only the refused method answering ends the pause, with ONE recovery alert
    assert.deepEqual(await h.m.onRpcSuccess("event-watcher:getLogs"), { recovered: true })
    assert.equal(h.alerts.filter((a) => a.phase === "recovered").length, 1)
  })

  test("muted is true ONLY for an auth error while paused — never below the threshold, never for transient", async () => {
    const h = harness()
    assert.equal((await h.m.onRpcError("balance-read", AUTH())).muted, false)
    assert.equal((await h.m.onRpcError("balance-read", AUTH())).muted, false)
    assert.equal((await h.m.onRpcError("balance-read", TRANSIENT())).muted, false)
    const third = await h.m.onRpcError("balance-read", AUTH())
    assert.equal(third.alerted, true)
    assert.equal(third.muted, true, "the monitor just alerted: the caller's own alert would repeat it")
    assert.equal((await h.m.onRpcError("cycle", AUTH())).muted, true, "while paused, every auth error is the monitor's")
    assert.equal((await h.m.onRpcError("cycle", TRANSIENT())).muted, false, "a transient error is never muted, even while paused")
    await h.m.onRpcSuccess("balance-read")
    await h.m.onRpcSuccess("cycle")
    assert.equal(h.m.state().paused, null)
    assert.equal((await h.m.onRpcError("balance-read", AUTH())).muted, false, "not paused any more ⇒ not muted")
  })
})

describe("[A71 M-1] the REAL event watcher with the REAL monitor", () => {
  async function run({ getBlockNumber, getLogs }, polls) {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    const errMock = mock.method(console, "error", () => {})
    const logMock = mock.method(console, "log", () => {})
    const sent = []
    const fetchMock = mock.method(globalThis, "fetch", async (_u, init) => (sent.push(JSON.parse(init.body).text), { ok: true }))
    const m = createRpcAuthMonitor({ chainId: 8453, alert: alertRpcAuth })
    let n = 0
    const client = { getBlockNumber: async () => getBlockNumber(n++), getLogs: async () => getLogs() }
    const watcher = startEventWatcher(client, [{ address: ADDR, label: "OrderExecutor" }], null, m)
    try {
      for (let i = 0; i < polls; i++) {
        await flush()
        mock.timers.tick(30_000)
      }
      watcher.stop()
      await flush()
      return { sent, state: m.state() }
    } finally {
      fetchMock.mock.restore()
      errMock.mock.restore()
      logMock.mock.restore()
      mock.timers.reset()
    }
  }

  test("getBlockNumber answers, getLogs is refused, 50 polls ⇒ ONE 'RPC AUTH REJECTED', paused, and no key", async () => {
    const r = await run({ getBlockNumber: (i) => 100n + BigInt(i), getLogs: () => { throw AUTH() } }, 50)
    assert.equal(r.sent.filter((t) => t.includes("RPC AUTH REJECTED")).length, 1)
    assert.equal(r.state.paused, "rpc-auth")
    assert.equal(r.state.lastOrigin, "event-watcher:getLogs")
    assert.equal(r.sent.filter((t) => t.includes("Event Watcher Degraded")).length, 0, "paused: the monitor's alert, not a Degraded loop")
    assert.ok(r.sent.every((t) => !t.includes(KEY)))
  })

  test("5 failures ending in 2 auth errors (below the threshold, not paused) ⇒ the Degraded alert is NOT muted", async () => {
    const r = await run({ getBlockNumber: (i) => { if (i < 3) throw TRANSIENT(); if (i < 5) throw AUTH(); return 200n }, getLogs: () => [] }, 5)
    assert.equal(r.state.paused, null)
    assert.equal(r.sent.filter((t) => t.includes("Event Watcher Degraded")).length, 1)
    assert.equal(r.sent.filter((t) => t.includes("RPC AUTH REJECTED")).length, 0)
  })
})
