// [A71b S-1] The `paused: rpc-auth` state clears only when NO origin still has an open auth streak.
//
// The audited head cleared the pause as soon as every streak was BELOW the threshold, so one origin
// answering ended the pause while another origin (one or two auth errors in, not yet at the
// threshold) was still being refused. It re-paused with a second alert after one more error — never
// silent, but a false "recovered" alert and a flapping state. The watcher's log-processing phase
// (origin `event-watcher:poll`) is an origin too, so it must report its own success: otherwise a
// streak left there would hold the pause forever under the stricter rule.
//
// Auth errors are real viem HttpRequestError objects (a 403 with the provider's words).
//
// Run: node --test contracts/order-engine/executor/rpc-auth-pause-clear.test.mjs

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"
import { HttpRequestError } from "viem"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { createRpcAuthMonitor } = await import("./rpc-auth.js")
const { startEventWatcher } = await import("./event-watcher.js")

const URL_ = "https://base-mainnet.g.alchemy.com/v2/TESTKEY"
const ADDR = "0x1111111111111111111111111111111111111111"
const AUTH = () => new HttpRequestError({ url: URL_, status: 403, body: { method: "eth_getLogs" }, details: "Unspecified origin not on whitelist." })
const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

function harness() {
  const alerts = []
  const m = createRpcAuthMonitor({ chainId: 8453, now: () => Date.parse("2026-11-05T12:00:00.000Z"), alert: async (p) => alerts.push(p) })
  return { m, alerts }
}

describe("[A71b S-1] the monitor: the pause outlives an answering origin while another is still refused", () => {
  test("origin B 2 auth errors (below the threshold), origin A paused then answers ⇒ still paused, no recovery alert", async () => {
    const h = harness()
    await h.m.onRpcError("balance-read", AUTH())
    await h.m.onRpcError("balance-read", AUTH())
    assert.equal(h.m.state().paused, null, "2 < threshold 3: not paused yet")
    for (let i = 0; i < 3; i++) await h.m.onRpcError("event-watcher:getLogs", AUTH())
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.equal(h.alerts.filter((a) => a.phase === "runtime").length, 1)

    assert.deepEqual(await h.m.onRpcSuccess("event-watcher:getLogs"), { recovered: false }, "balance-read is still refused")
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.equal(h.m.state().authStreaks["balance-read"], 2)
    assert.equal(h.alerts.filter((a) => a.phase === "recovered").length, 0, "no false 'recovered'")

    // the last refused origin answers ⇒ NOW it clears, with exactly one recovery alert
    assert.deepEqual(await h.m.onRpcSuccess("balance-read"), { recovered: true })
    assert.equal(h.m.state().paused, null)
    assert.deepEqual(h.m.state().authStreaks, {})
    assert.equal(h.alerts.filter((a) => a.phase === "recovered").length, 1)
  })

  test("a transient error neither opens nor closes a streak: it does not hold the pause", async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) await h.m.onRpcError("cycle", AUTH())
    assert.equal(h.m.state().paused, "rpc-auth")
    const transient = new HttpRequestError({ url: URL_, status: 503, details: "Service Unavailable" })
    await h.m.onRpcError("balance-read", transient)
    assert.deepEqual(h.m.state().authStreaks, { cycle: 3 })
    assert.deepEqual(await h.m.onRpcSuccess("cycle"), { recovered: true })
  })
})

describe("[A71b S-1] the REAL event watcher reports its log-processing phase as its own origin", () => {
  test("a completed poll (getBlockNumber → getLogs → processing) reports success for getBlockNumber, getLogs AND poll", async () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    const errMock = mock.method(console, "error", () => {})
    const logMock = mock.method(console, "log", () => {})
    const seen = []
    const spy = {
      onRpcSuccess: async (origin) => (seen.push(origin), { recovered: false }),
      onRpcError: async () => ({ kind: "transient", signal: null, alerted: false, muted: false }),
      state: () => ({ paused: null }),
    }
    let block = 100n
    const client = { getBlockNumber: async () => block++, getLogs: async () => [] }
    const watcher = startEventWatcher(client, [{ address: ADDR, label: "OrderExecutor" }], null, spy)
    try {
      for (let i = 0; i < 3; i++) {
        await flush()
        mock.timers.tick(30_000)
      }
      watcher.stop()
      await flush()
    } finally {
      errMock.mock.restore()
      logMock.mock.restore()
      mock.timers.reset()
    }
    for (const origin of ["event-watcher:getBlockNumber", "event-watcher:getLogs", "event-watcher:poll"]) {
      assert.ok(seen.includes(origin), `no success report for ${origin}; saw ${[...new Set(seen)].join(", ")}`)
    }
  })

  test("a streak on event-watcher:poll does not hold a pause once a poll completes (real monitor)", async () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    const errMock = mock.method(console, "error", () => {})
    const logMock = mock.method(console, "log", () => {})
    const h = harness()
    await h.m.onRpcError("event-watcher:poll", AUTH())
    for (let i = 0; i < 3; i++) await h.m.onRpcError("balance-read", AUTH())
    assert.equal(h.m.state().paused, "rpc-auth")
    await h.m.onRpcSuccess("balance-read")
    assert.equal(h.m.state().paused, "rpc-auth", "poll is still refused")
    let block = 100n
    const client = { getBlockNumber: async () => block++, getLogs: async () => [] }
    const watcher = startEventWatcher(client, [{ address: ADDR, label: "OrderExecutor" }], null, h.m)
    try {
      for (let i = 0; i < 3; i++) {
        await flush()
        mock.timers.tick(30_000)
      }
      watcher.stop()
      await flush()
    } finally {
      errMock.mock.restore()
      logMock.mock.restore()
      mock.timers.reset()
    }
    assert.equal(h.m.state().paused, null, JSON.stringify(h.m.state()))
    assert.equal(h.alerts.filter((a) => a.phase === "recovered").length, 1)
  })
})
