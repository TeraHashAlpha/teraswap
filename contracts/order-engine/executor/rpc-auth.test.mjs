// [fix/executor-alert-masking-rpc-auth] INC-2026-10-30-001 — RPC auth/allowlist rejection is FATAL-OPS.
//
// What is pinned here:
//   1. classifyRpcError on the errors viem 2.47 REALLY throws for each provider answer (a local HTTP
//      server plays the provider — no network): a 403 with a JSON-RPC body loses its HTTP status in
//      viem, so the provider's words must carry the classification.
//   2. The runtime monitor: 3 consecutive auth errors ⇒ ONE alert + `paused: rpc-auth`; reminders at
//      most once per cooldown with a suppressed count; transient errors neither count nor reset; a
//      success clears the state with ONE recovery alert; it never throws.
//   3. The boot gate: one alert per cooldown across pm2 restarts; unreadable state ⇒ alert anyway.
//   4. Wiring: chain-verify tags (only) its RPC refusals; the event watcher hands auth errors to the
//      monitor instead of its own Degraded alert (transient: unchanged); paused-state publish; metrics;
//      heartbeat; and the REAL executor.js boot against a provider that rejects the key.
//
// Run: node --test contracts/order-engine/executor/rpc-auth.test.mjs

import { test, describe, mock, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HttpRequestError, createPublicClient, http } from "viem"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { classifyRpcError, createRpcAuthMonitor, createBootAlertGate, RPC_AUTH, RPC_TRANSIENT, RPC_AUTH_THRESHOLD } =
  await import("./rpc-auth.js")
const { alertRpcAuth, sendTelegramHeartbeat } = await import("./alert.js")
const { verifyChainBinding, ChainVerificationError, EXPECTED_ORDER_TYPEHASH_V2 } = await import("./chain-verify.js")
const { startEventWatcher } = await import("./event-watcher.js")
const { publishPausedState } = await import("./runtime-config.js")
const { ExecutorMonitor } = await import("./monitor.js")

const KEY = "TESTKEY"
const WHITELIST = "Unspecified origin not on whitelist."
const ADDR = "0x" + "ab".repeat(20)
const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}
const tempDirs = []
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

/** A local "provider" whose answer is switchable; returns the thrown viem error for each mode. */
async function providerErrors(modes) {
  let mode
  const srv = createServer((_req, res) => {
    const json = (status, error) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error }))
    }
    if (mode === "json403-whitelist") return json(403, { code: -32600, message: WHITELIST })
    if (mode === "json200-invalid-key") return json(200, { code: -32000, message: "invalid api key" })
    if (mode === "json429") return json(429, { code: 429, message: "Your app has exceeded its compute units per second capacity." })
    const text = { "text401": [401, "Must be authenticated!"], "html403": [403, "<html>Forbidden</html>"], "text503": [503, "Service Unavailable"] }[mode]
    res.writeHead(text[0], { "content-type": "text/plain" })
    res.end(text[1])
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${srv.address().port}/v2/${KEY}`, { retryCount: 0 }) })
  const out = {}
  try {
    for (const m of modes) {
      mode = m
      out[m] = await client.getBlockNumber().then(() => null, (e) => e)
      out[`${m}:readContract`] = await client
        .readContract({ address: ADDR, abi: [{ name: "f", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }], functionName: "f" })
        .then(() => null, (e) => e)
    }
  } finally {
    srv.close()
  }
  return out
}

const ERRORS = await providerErrors(["json403-whitelist", "text401", "html403", "json200-invalid-key", "text503", "json429"])

describe("classifyRpcError — the errors viem really throws", () => {
  const rows = [
    ["json403-whitelist", RPC_AUTH, "not on whitelist"], // viem drops the 403: the provider's words carry it
    ["text401", RPC_AUTH, "HTTP 401"],
    ["html403", RPC_AUTH, "HTTP 403"],
    ["json200-invalid-key", RPC_AUTH, "invalid api key"],
    ["text503", RPC_TRANSIENT, null],
    ["json429", RPC_TRANSIENT, null],
  ]
  for (const [mode, kind, signal] of rows) {
    test(`${mode} → ${kind}${signal ? ` (${signal})` : ""}, also when wrapped by readContract`, () => {
      assert.ok(ERRORS[mode], "fixture produced no error")
      assert.deepEqual(classifyRpcError(ERRORS[mode]), { kind, signal })
      assert.deepEqual(classifyRpcError(ERRORS[`${mode}:readContract`]), { kind, signal })
    })
  }

  test("a closed port (ECONNREFUSED), a timeout, null and junk stay transient", async () => {
    const dead = createPublicClient({ transport: http("http://127.0.0.1:1/v2/x", { retryCount: 0 }) })
    const refused = await dead.getBlockNumber().then(() => null, (e) => e)
    assert.equal(classifyRpcError(refused).kind, RPC_TRANSIENT)
    assert.equal(classifyRpcError(new Error("timed out after 10000ms")).kind, RPC_TRANSIENT)
    assert.equal(classifyRpcError(null).kind, RPC_TRANSIENT)
    const cyclic = { message: "x" }
    cyclic.cause = cyclic
    assert.equal(classifyRpcError(cyclic).kind, RPC_TRANSIENT)
  })

  test("a contract revert that SAYS 'not on whitelist' is the contract, not the provider", () => {
    const revert = Object.assign(new Error("execution reverted: router not on whitelist"), { name: "ContractFunctionRevertedError" })
    assert.equal(classifyRpcError(revert).kind, RPC_TRANSIENT)
    assert.equal(classifyRpcError({ name: "X", message: "wrapped", cause: revert }).kind, RPC_TRANSIENT)
  })

  test("the key / URL path never takes part in matching (text is redacted first)", () => {
    const e = new HttpRequestError({ url: "https://rpc.example.com/unauthorized/v2/k", status: 500, body: {}, details: "boom" })
    assert.equal(classifyRpcError(e).kind, RPC_TRANSIENT)
  })
})

function harness({ cooldownMs = 3_600_000, alertThrows = false } = {}) {
  let t = Date.parse("2026-10-30T15:00:00Z")
  const alerts = []
  const states = []
  const lines = []
  const m = createRpcAuthMonitor({
    chainId: 8453,
    cooldownMs,
    now: () => t,
    alert: async (p) => {
      if (alertThrows) throw new Error("telegram down")
      alerts.push(p)
    },
    onStateChange: async (s) => {
      if (alertThrows) throw new Error("supabase down")
      states.push(s)
    },
    log: (l) => lines.push(l),
  })
  return { m, alerts, states, lines, advance: (ms) => (t += ms) }
}
const AUTH_ERR = () => ERRORS["json403-whitelist"]
const TRANSIENT_ERR = () => ERRORS["text503"]

describe("runtime monitor — 3 consecutive auth errors ⇒ ONE alert + paused: rpc-auth", () => {
  test("below the threshold: counted, no alert, not paused", async () => {
    const h = harness()
    assert.equal(RPC_AUTH_THRESHOLD, 3)
    await h.m.onRpcError("event-watcher", AUTH_ERR())
    await h.m.onRpcError("balance-read", AUTH_ERR())
    assert.equal(h.alerts.length, 0)
    assert.equal(h.m.state().paused, null)
    assert.equal(h.m.state().consecutiveAuthErrors, 2)
  })

  test("at the threshold: the AUTH line, paused: rpc-auth, one runtime alert, one state change", async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) await h.m.onRpcError("event-watcher", AUTH_ERR())
    assert.equal(h.lines[0], "rpc: AUTH REJECTED chain=8453 source=RPC_URL — check provider allowlist/key")
    assert.equal(h.m.state().paused, "rpc-auth")
    assert.equal(h.m.state().pausedSince, "2026-10-30T15:00:00.000Z")
    assert.equal(h.alerts.length, 1)
    assert.deepEqual(
      { phase: h.alerts[0].phase, signal: h.alerts[0].signal, consecutive: h.alerts[0].consecutive, suppressed: h.alerts[0].suppressed },
      { phase: "runtime", signal: "not on whitelist", consecutive: 3, suppressed: 0 },
    )
    assert.equal(h.states.length, 1)
    assert.equal(h.states[0].paused, "rpc-auth")
  })

  test("rate limit: every further poll inside the cooldown is suppressed; one reminder after it, with the count", async () => {
    const h = harness({ cooldownMs: 3_600_000 })
    for (let i = 0; i < 3; i++) await h.m.onRpcError("event-watcher", AUTH_ERR())
    for (let i = 0; i < 11; i++) {
      h.advance(5 * 60_000) // idle cadence: one poll every 5 min → 55 min, still inside the hour
      await h.m.onRpcError(i % 2 ? "balance-read" : "event-watcher", AUTH_ERR())
    }
    assert.equal(h.alerts.length, 1, "an alert per poll is the INC-2026-10-30-001 loop")
    h.advance(5 * 60_000) // 60 min since the first alert
    const r = await h.m.onRpcError("event-watcher", AUTH_ERR())
    assert.equal(r.alerted, true)
    assert.equal(h.alerts.length, 2)
    assert.equal(h.alerts[1].suppressed, 11)
    assert.equal(h.alerts[1].since, "2026-10-30T15:00:00.000Z", "since = the FIRST moment, not the reminder")
    assert.equal(h.states.length, 1, "a reminder is not a state change")
  })

  test("transient errors neither count nor reset; a success resets the streak", async () => {
    const h = harness()
    await h.m.onRpcError("a", AUTH_ERR())
    await h.m.onRpcError("a", TRANSIENT_ERR())
    await h.m.onRpcError("a", AUTH_ERR())
    assert.equal(h.m.state().consecutiveAuthErrors, 2)
    await h.m.onRpcSuccess("balance-read")
    await h.m.onRpcError("a", AUTH_ERR())
    await h.m.onRpcError("a", AUTH_ERR())
    assert.equal(h.alerts.length, 0)
    assert.equal((await h.m.onRpcError("a", TRANSIENT_ERR())).kind, RPC_TRANSIENT)
  })

  test("recovery: the first success clears the state with ONE recovery alert; later successes are silent", async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) await h.m.onRpcError("event-watcher", AUTH_ERR())
    h.advance(20 * 3_600_000)
    assert.deepEqual(await h.m.onRpcSuccess("event-watcher"), { recovered: true })
    assert.deepEqual(await h.m.onRpcSuccess("balance-read"), { recovered: false })
    assert.equal(h.m.state().paused, null)
    assert.equal(h.alerts.at(-1).phase, "recovered")
    assert.equal(h.alerts.filter((a) => a.phase === "recovered").length, 1)
    assert.deepEqual(h.states.map((s) => s.paused), ["rpc-auth", null])
    assert.match(h.lines.at(-1), /^rpc: auth recovered chain=8453 source=RPC_URL/)
  })

  test("concurrent reports crossing the threshold still alert once", async () => {
    const h = harness()
    await h.m.onRpcError("a", AUTH_ERR())
    await h.m.onRpcError("a", AUTH_ERR())
    await Promise.all(Array.from({ length: 5 }, () => h.m.onRpcError("b", AUTH_ERR())))
    assert.equal(h.alerts.length, 1)
  })

  test("a throwing alert sink / state sink never throws out of the monitor", async () => {
    const h = harness({ alertThrows: true })
    for (let i = 0; i < 3; i++) await h.m.onRpcError("a", AUTH_ERR())
    assert.equal(h.m.state().paused, "rpc-auth")
    await h.m.onRpcSuccess("a")
    assert.equal(h.m.state().paused, null)
  })
})

describe("boot gate — one alert per cooldown across pm2 restarts", () => {
  function gateHarness() {
    let t = 1_000_000
    const disk = new Map()
    const make = (over = {}) =>
      createBootAlertGate({
        chainId: 8453,
        now: () => t,
        file: "/state.json",
        read: (f) => {
          if (!disk.has(f)) throw new Error("ENOENT")
          return disk.get(f)
        },
        write: (f, s) => disk.set(f, s),
        ...over,
      })
    return { make, disk, advance: (ms) => (t += ms) }
  }

  test("first boot sends; the next restarts inside the hour are suppressed and counted; then one with the count", () => {
    const g = gateHarness()
    assert.equal(g.make().check().send, true)
    for (let i = 1; i <= 49; i++) {
      g.advance(8_000) // pm2: restart_delay 5 s + a ~3 s refused boot
      const v = g.make().check()
      assert.equal(v.send, false)
      assert.equal(v.suppressed, i)
    }
    g.advance(3_600_000)
    const v = g.make().check()
    assert.equal(v.send, true)
    assert.equal(v.suppressed, 49)
  })

  test("unreadable / corrupt / unwritable state ⇒ the alert is SENT (never quieter)", () => {
    const g = gateHarness()
    g.disk.set("/state.json", "{not json")
    assert.equal(g.make().check().send, true)
    const unwritable = g.make({ read: () => { throw new Error("EACCES") }, write: () => { throw new Error("EROFS") } })
    assert.equal(unwritable.check().send, true)
    assert.equal(unwritable.check().send, true)
  })

  test("the default file lives in os.tmpdir(), per chain, and round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "rpc-auth-gate-"))
    tempDirs.push(dir)
    const file = join(dir, "gate.json")
    assert.equal(createBootAlertGate({ chainId: 1, file }).check().send, true)
    assert.equal(createBootAlertGate({ chainId: 1, file }).check().send, false)
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).suppressed, 1)
  })
})

describe("alertRpcAuth — urgency HIGH, the grep-able line, no freeze advice", () => {
  test("runtime / boot / recovered bodies", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ({ ok: true }))
    try {
      const runtime = await alertRpcAuth({ phase: "runtime", chainId: 8453, source: "RPC_URL", signal: "not on whitelist", consecutive: 3, threshold: 3, origin: "event-watcher", since: "2026-10-30T15:00:00.000Z" })
      assert.match(runtime, /Urgency: HIGH/)
      assert.ok(runtime.includes("rpc: AUTH REJECTED chain=8453 source=RPC_URL — check provider allowlist/key"))
      assert.ok(runtime.includes("State: paused: rpc-auth since 2026-10-30T15:00:00.000Z"))
      assert.ok(!runtime.includes("Freeze-urgency"), "freezing DCA does not fix a key")
      const boot = await alertRpcAuth({ phase: "boot", chainId: 8453, source: "RPC_URL", signal: "<b>x</b>", suppressed: 4 })
      assert.match(boot, /Phase: boot — chain-verify refused; the keeper is NOT running/)
      assert.match(boot, /Signal: &lt;b&gt;x&lt;\/b&gt;/)
      assert.match(boot, /4 repeat\(s\) suppressed/)
      const rec = await alertRpcAuth({ phase: "recovered", chainId: 8453, source: "RPC_URL", since: "2026-10-30T15:00:00.000Z" })
      assert.match(rec, /RPC auth recovered/)
      assert.equal(fetchMock.mock.callCount(), 3)
    } finally {
      fetchMock.mock.restore()
    }
  })

  test("the heartbeat stops saying a plain 'alive' while paused", async () => {
    const sent = []
    const fetchMock = mock.method(globalThis, "fetch", async (_u, init) => (sent.push(JSON.parse(init.body).text), { ok: true }))
    try {
      await sendTelegramHeartbeat({ totalCycles: 1, totalExecuted: 0, totalErrors: 0, paused: "rpc-auth", rpcAuth: { pausedSince: "2026-10-30T15:00:00.000Z" } })
      await sendTelegramHeartbeat({ totalCycles: 1, totalExecuted: 0, totalErrors: 0, paused: null })
      assert.match(sent[0], /alive but PAUSED: rpc-auth since 2026-10-30T15:00:00\.000Z/)
      assert.match(sent[1], /✅ Executor alive/)
    } finally {
      fetchMock.mock.restore()
    }
  })
})

describe("chain-verify — auth is CLASSIFIED on the refusal; the refusal itself is unchanged", () => {
  const contracts = [{ label: "ORDER_EXECUTOR_ADDRESS (v2)", address: ADDR, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V2 }]
  const verify = (provider) => verifyChainBinding({ provider, chainId: 8453, contracts, retryDelayMs: 0, sleep: async () => {} })
  const okProvider = { getChainId: async () => 8453, getCode: async () => "0x6080", readContract: async () => EXPECTED_ORDER_TYPEHASH_V2 }

  test("an auth error on eth_chainId → still refuses (3 attempts), tagged rpcAuth + signal", async () => {
    let calls = 0
    const err = await verify({ ...okProvider, getChainId: async () => { calls++; throw AUTH_ERR() } }).then(() => null, (e) => e)
    assert.ok(err instanceof ChainVerificationError)
    assert.equal(calls, 3, "retry bound unchanged")
    assert.match(err.message, /could not read eth_chainId .* refusing to boot/)
    assert.equal(err.rpcAuth, true)
    assert.equal(err.rpcAuthSignal, "not on whitelist")
  })

  test("an auth error on the identity read is tagged too; a transient one and a mismatch are not", async () => {
    const id = await verify({ ...okProvider, readContract: async () => { throw ERRORS["text401:readContract"] } }).then(() => null, (e) => e)
    assert.deepEqual([id.check, id.rpcAuth, id.rpcAuthSignal], ["identity", true, "HTTP 401"])
    const transient = await verify({ ...okProvider, getChainId: async () => { throw TRANSIENT_ERR() } }).then(() => null, (e) => e)
    assert.deepEqual([transient.rpcAuth, transient.rpcAuthSignal], [false, null])
    const mismatch = await verify({ ...okProvider, getChainId: async () => 1 }).then(() => null, (e) => e)
    assert.deepEqual([mismatch.check, mismatch.rpcAuth], ["chainId", false])
  })

  test("a healthy RPC still passes exactly as before", async () => {
    const res = await verify(okProvider)
    assert.equal(res.chainId, 8453)
  })
})

describe("event watcher + monitor — auth is alerted once by the monitor, transient unchanged", () => {
  async function run(clientFn, polls) {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    const errMock = mock.method(console, "error", () => {})
    const logMock = mock.method(console, "log", () => {})
    const sent = []
    const fetchMock = mock.method(globalThis, "fetch", async (_u, init) => (sent.push(JSON.parse(init.body).text), { ok: true }))
    const m = createRpcAuthMonitor({ chainId: 8453, alert: alertRpcAuth })
    let n = 0
    const client = { getBlockNumber: async () => clientFn(n++), getLogs: async () => [] }
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

  test("12 auth-rejected polls: ONE 'RPC AUTH REJECTED', zero 'Degraded', paused: rpc-auth", async () => {
    const r = await run(() => { throw AUTH_ERR() }, 12)
    assert.equal(r.sent.filter((t) => t.includes("RPC AUTH REJECTED")).length, 1)
    assert.equal(r.sent.filter((t) => t.includes("Event Watcher Degraded")).length, 0)
    assert.equal(r.state.paused, "rpc-auth")
    assert.ok(r.sent.every((t) => !t.includes(KEY)))
  })

  test("transient failures keep today's Degraded alert at 5, and never pause", async () => {
    const r = await run(() => { throw TRANSIENT_ERR() }, 6)
    assert.equal(r.sent.filter((t) => t.includes("Event Watcher Degraded")).length, 1)
    assert.equal(r.state.paused, null)
  })

  test("auth then a working key: paused, then ONE recovery alert", async () => {
    const r = await run((i) => { if (i < 4) throw AUTH_ERR(); return 100n }, 7)
    assert.equal(r.sent.filter((t) => t.includes("RPC auth recovered")).length, 1)
    assert.equal(r.state.paused, null)
  })
})

describe("paused state → keeper_runtime_config (the channel off-host readers share)", () => {
  function fakeSupabase(responder) {
    const calls = []
    return {
      calls,
      fetch: async (path, opts) => {
        calls.push({ path, method: opts.method, body: JSON.parse(opts.body), prefer: opts.headers?.Prefer })
        return responder(path)
      },
    }
  }
  const ok = (rows) => ({ ok: true, status: 200, json: async () => rows })

  test("set: PATCH only a row that is not already paused (keeps the first paused_since)", async () => {
    const sb = fakeSupabase(() => ok([{ chain_id: 8453 }]))
    const r = await publishPausedState({ supabaseFetch: sb.fetch, chainId: 8453, paused: "rpc-auth", nowIso: "2026-10-30T15:00:00.000Z" })
    assert.deepEqual(r, { ok: true, status: 200, rows: 1, reason: "published", missingColumn: false })
    assert.equal(sb.calls[0].path, "keeper_runtime_config?chain_id=eq.8453&paused=is.null&select=chain_id")
    assert.equal(sb.calls[0].method, "PATCH")
    assert.deepEqual(sb.calls[0].body, { paused: "rpc-auth", paused_since: "2026-10-30T15:00:00.000Z", updated_at: "2026-10-30T15:00:00.000Z" })
  })

  test("clear: PATCH only a paused row, to nulls", async () => {
    const sb = fakeSupabase(() => ok([]))
    const lines = []
    const r = await publishPausedState({ supabaseFetch: sb.fetch, chainId: 8453, paused: null, nowIso: "2026-10-31T11:11:00.000Z", log: (l) => lines.push(l) })
    assert.equal(r.rows, 0)
    assert.equal(sb.calls[0].path, "keeper_runtime_config?chain_id=eq.8453&paused=not.is.null&select=chain_id")
    assert.deepEqual(sb.calls[0].body, { paused: null, paused_since: null, updated_at: "2026-10-31T11:11:00.000Z" })
    assert.match(lines[0], /no row changed/)
  })

  test("migration not applied yet → named in the log, non-fatal; a throw and bad input never throw", async () => {
    const lines = []
    const missing = fakeSupabase(() => ({ ok: false, status: 400, text: async () => '{"code":"42703","message":"column keeper_runtime_config.paused does not exist"}' }))
    const r = await publishPausedState({ supabaseFetch: missing.fetch, chainId: 8453, paused: "rpc-auth", nowIso: "2026-10-30T15:00:00.000Z", log: (l) => lines.push(l) })
    assert.equal(r.missingColumn, true)
    assert.match(lines[0], /apply supabase\/migrations\/20261031120000_keeper_runtime_config_paused\.sql/)
    const threw = await publishPausedState({ supabaseFetch: async () => { throw new Error(`fetch failed https://x.supabase.co/rest/v1/${KEY}`) }, chainId: 8453, paused: null, nowIso: "2026-10-30T15:00:00.000Z", log: (l) => lines.push(l) })
    assert.equal(threw.ok, false)
    assert.ok(!lines.at(-1).includes(KEY))
    for (const bad of [{ chainId: "x" }, { paused: "maintenance" }, { nowIso: "nope" }, { supabaseFetch: null }]) {
      const v = await publishPausedState({ supabaseFetch: async () => ok([]), chainId: 8453, paused: "rpc-auth", nowIso: "2026-10-30T15:00:00.000Z", ...bad })
      assert.equal(v.ok, false)
    }
  })
})

// A REAL hung Supabase: a local server that accepts the PATCH and never answers, reached through a
// `supabaseFetch` shaped like executor.js's (global fetch on `${base}/rest/v1/${path}`). The open
// socket is what keeps the event loop alive while the keeper waits — exactly as on the host. (A fake
// promise that only settles on `abort` holds NO handle: AbortSignal.timeout()'s timer is unref'd, so
// on Node 20/22 the runner saw a drained loop and cancelled this test and every one after it.)
// The test-level timeout only turns a regression (no bound on the PATCH) into a failure, not a hang;
// the server is torn down in t.after() so it also closes when that timeout fires mid-await.
test("a hung Supabase cannot hold a refusing boot open: the PATCH is bounded by a timeout", { timeout: 10_000 }, async (t) => {
  const seen = []
  const srv = createServer((req) => seen.push(`${req.method} ${req.url}`)) // never responds
  t.after(() => {
    srv.closeAllConnections()
    return new Promise((r) => srv.close(r))
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const supabaseFetch = (path, options = {}) => fetch(`${base}/rest/v1/${path}`, options)
  const t0 = Date.now()
  const r = await publishPausedState({ supabaseFetch, chainId: 8453, paused: "rpc-auth", nowIso: "2026-10-30T15:00:00.000Z", timeoutMs: 50 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /^threw: .*timeout/i)
  assert.ok(Date.now() - t0 < 2_000)
  assert.deepEqual(seen, ["PATCH /rest/v1/keeper_runtime_config?chain_id=eq.8453&paused=is.null&select=chain_id"])
})

test("metrics: teraswap_executor_paused{reason=\"rpc-auth\"} + consecutive auth errors", () => {
  const stats = { startedAt: new Date().toISOString(), paused: "rpc-auth", rpcAuth: { consecutiveAuthErrors: 7 } }
  const text = new ExecutorMonitor(stats).getMetrics()
  assert.match(text, /^teraswap_executor_paused\{reason="rpc-auth"\} 1$/m)
  assert.match(text, /^teraswap_executor_rpc_auth_consecutive_errors 7$/m)
  stats.paused = null
  stats.rpcAuth = null
  assert.match(new ExecutorMonitor(stats).getMetrics(), /^teraswap_executor_paused\{reason="rpc-auth"\} 0$/m)
})

describe("executor.js wiring (source anchors)", () => {
  const src = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
  test("both boot gates and the fatal handler report an auth refusal before exiting", () => {
    assert.equal(src.match(/await reportBootRpcAuth\(err\)\s*(?:\/\/[^\n]*)?\n\s*process\.exit\(1\)/g)?.length, 3)
  })
  test("balance read, thrown cycles and the watcher all report to the ONE monitor", () => {
    assert.ok(src.includes('await rpcAuthMonitor.onRpcSuccess("balance-read")'))
    assert.ok(src.includes('await rpcAuthMonitor.onRpcError("balance-read", err)'))
    assert.ok(src.includes('await rpcAuthMonitor.onRpcError("cycle", err)'))
    assert.ok(src.includes("startEventWatcher(publicClient, watchedContracts, monitor, rpcAuthMonitor)"))
  })
  test("/health exposes the state", () => {
    assert.ok(src.includes("paused: stats.paused,"))
  })
})

describe("the REAL executor.js boot against a provider that rejects the key", () => {
  const EXECUTOR = fileURLToPath(new URL("./executor.js", import.meta.url))
  const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" // Hardhat #0, public fixture
  const AUTH_LINE = "rpc: AUTH REJECTED chain=11155111 source=RPC_URL — check provider allowlist/key"

  async function boot(cwd) {
    const supabase = []
    const srv = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        if (req.url.startsWith("/rest/v1/")) {
          supabase.push({ method: req.method, url: req.url, body })
          res.writeHead(200, { "content-type": "application/json" }).end('[{"chain_id":11155111}]')
          return
        }
        res.writeHead(403, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: WHITELIST } }))
      })
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    const port = srv.address().port
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(cwd, "stub.mjs")).href, EXECUTOR], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: cwd, // the boot gate's state file lands here, not in the machine's /tmp
        RPC_URL: `http://127.0.0.1:${port}/v2/${KEY}`,
        CHAIN_ID: "11155111",
        ORDER_EXECUTOR_ADDRESS: ADDR,
        SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
        EXECUTOR_PRIVATE_KEY: DEV_KEY,
        TELEGRAM_BOT_TOKEN: "TESTBOTTOKEN",
        TELEGRAM_CHAT_ID: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    const exitCode = await new Promise((resolve) => {
      const kill = setTimeout(() => (child.kill("SIGKILL"), resolve("TIMED_OUT")), 40_000)
      child.on("exit", (c) => (clearTimeout(kill), resolve(c)))
    })
    await new Promise((r) => srv.close(r))
    const telegram = [...stdout.matchAll(/TELEGRAM>>>(.*)<<</g)].map((m) => JSON.parse(m[1]))
    return { exitCode, stdout, stderr, telegram, supabase }
  }

  test("refuses, prints THE line, alerts HIGH once, records paused — and a pm2 restart does not re-alert", { timeout: 120_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keeper-auth-boot-"))
    tempDirs.push(cwd)
    // Intercepts ONLY Telegram in the child: prints the outgoing text, never the URL (it holds the token).
    writeFileSync(
      join(cwd, "stub.mjs"),
      'const real = globalThis.fetch\n' +
        'globalThis.fetch = async (url, init) => {\n' +
        '  if (String(url).startsWith("https://api.telegram.org/")) {\n' +
        '    process.stdout.write("TELEGRAM>>>" + JSON.stringify(JSON.parse(init.body).text) + "<<<\\n")\n' +
        '    return new Response("{}", { status: 200 })\n' +
        '  }\n' +
        '  return real(url, init)\n' +
        '}\n',
    )
    const first = await boot(cwd)
    assert.equal(first.exitCode, 1, first.stderr)
    assert.ok(first.stderr.includes(AUTH_LINE), first.stderr)
    assert.match(first.stderr, /signal: not on whitelist/)
    assert.equal(first.telegram.length, 1, first.stdout)
    assert.match(first.telegram[0], /RPC AUTH REJECTED<\/b> — Urgency: HIGH/)
    assert.ok(first.telegram[0].includes(AUTH_LINE))
    const patch = first.supabase.find((c) => c.method === "PATCH")
    assert.ok(patch && patch.url.includes("keeper_runtime_config?chain_id=eq.11155111&paused=is.null"), JSON.stringify(first.supabase))
    assert.equal(JSON.parse(patch.body).paused, "rpc-auth")
    for (const out of [first.stdout, first.stderr]) assert.ok(!out.includes(KEY), `key leaked:\n${out}`)

    const second = await boot(cwd) // pm2 restart, same host (same TMPDIR)
    assert.equal(second.exitCode, 1)
    assert.ok(second.stderr.includes(AUTH_LINE))
    assert.equal(second.telegram.length, 0, "a restart inside the cooldown must not re-alert")
    assert.match(second.stderr, /boot auth alert rate-limited: .* 1 boot refusal\(s\) since/)
  })
})
