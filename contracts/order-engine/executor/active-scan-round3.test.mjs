// [A91 / design 120c, owner answers 2026-11-18] Round-3 behaviour of the SHIPPED cycle (executor-cycle.fixture.mjs):
//
//   R2-1  quarantine: visible (cycle line, /health, alert at 5 then hourly), changes nothing (no status, no miss, no
//         ADR-024 / ADR-026 state), asked again alone at most once every 30 min (10 per cycle), released when it
//         answers, an expired quarantined row still marked expired; hostile-only (owner answer 2): a transport-failed
//         chunk is not bisected, nothing is quarantined when no pre-screen call answered; the bisect never exceeds
//         its 40 calls; the single ask carries gas 3,000,000.
//   R2-2  the freeze read fails CLOSED (owner decision "error = frozen"): a 5.5 s read answering frozen=true holds the
//         DCA row; only a well-formed "not frozen" lets it pass; every other outcome holds it, alerts, and shows on
//         /health.
//   watchdog: a cycle past 5 minutes pages ops once (fake clock); a cycle with every external call hanging ends
//         within the sum of its limits (owner answer 3: Supabase writes and /api/swap have limits now).
//   R2-3  a fallback cycle keeps the carry-over list.   R2-4  a failed wrap read is flagged, counted and alerted.
//
// Each test FAILED on the audited head 16fb740c (the outputs are in the round-3 tables file).
//
// Run: node --test contracts/order-engine/executor/active-scan-round3.test.mjs

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { createFakePostgrest, createFakeChain, makeRow, mulberry32, withFakes } from "./executor-cycle.fixture.mjs"
import { CYCLE_MS, T0, loadKeeper, runCycle, settles } from "./active-scan.testlib.mjs"

const SRC = readFileSync(new URL("./executor.js", import.meta.url), "utf8")
const rowsOf = (n, from = 1, opts = {}) => Array.from({ length: n }, (_, i) => makeRow(from + i, opts))
const notReady = [false, "Price below floor"]
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** A keeper whose ADR-024 / ADR-026 / ladder maps are visible too (all exist on main). */
const loadKeeperWithMaps = (opts = {}) =>
  loadKeeper({ ...opts, optionalExports: ["runOneCycleAtATime", "quorumSkips", "orderRetries", "pinnedRouteReverts"] })

/** Telegram configured for `fn` (alert.js reads the variables at alert time). */
async function withTelegram(fn) {
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID }
  process.env.TELEGRAM_BOT_TOKEN = "fixture-bot"
  process.env.TELEGRAM_CHAT_ID = "fixture-chat"
  try {
    return await fn()
  } finally {
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = saved.token
    if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID
    else process.env.TELEGRAM_CHAT_ID = saved.chat
  }
}

const rowWrites = (requests, ids) => requests.filter((q) => q.method === "PATCH" && [...ids].some((id) => q.search.includes(`id=eq.${id}`)))

describe("[A91 R2-1] the quarantine: visible, and it changes nothing", () => {
  test("two burners in one chunk: both quarantined in the same cycle (cycle line, /health); the other 58 rows answered; no write, miss or streak for them", async () => {
    const k = await loadKeeperWithMaps()
    const rows = rowsOf(60, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const burners = new Set([rows[3].id, rows[41].id])
    const ready = rows[30].id
    const chain = createFakeChain(db, (row) => (burners.has(row.id) ? { burn: true } : row.id === ready ? [true, ""] : notReady), { wallet: true })
    const c0 = await runCycle(k, db, chain, 0)
    assert.match(c0.scanLine, /active=60 scanned=60 true=1 attempted=1 carried=0 quarantined=2 rotate=no fallback=prescreen-1of2$/)
    assert.deepEqual(c0.executed, [ready], "the healthy ready row of the failed chunk executes in the same cycle")
    assert.equal(k.stats.quarantinedRows, 2)
    assert.equal(k.stats.quarantinedTotal, 2)
    assert.ok(k.stats.bisectCalls > 0 && k.stats.bisectCalls <= 40, `${k.stats.bisectCalls} bisect calls`)
    assert.deepEqual(new Set(c0.screened.filter((id) => !burners.has(id))).size, 58, "every other row answered by the pre-screen")
    for (const s of chain.singleCalls) assert.equal(s.gas, 3_000_000n, "the single ask carries the explicit gas cap")
    for (let c = 1; c < 4; c++) {
      const r = await runCycle(k, db, chain, c)
      assert.match(r.scanLine, /quarantined=2 rotate=no fallback=none$/, `cycle ${c}: the quarantined rows are left out of every chunk`)
      assert.equal(r.screened.filter((id) => burners.has(id)).length, 0)
      assert.equal(r.path.filter((id) => burners.has(id)).length, 0, "never walked")
    }
    assert.deepEqual(rowWrites(db.requests, burners), [], "never a write to a quarantined row")
    for (const map of [k.orderInfraMisses, k.quorumSkips__opt, k.orderRetries__opt, k.pinnedRouteReverts__opt]) for (const id of burners) assert.equal(map.has(id), false, "no ADR-024 / ADR-026 / ladder state")
    assert.equal(db.table.filter((r) => r.status !== "active").length, 1, "only the executed row changed status")
  })

  test("asked again alone at most once every 30 minutes; released when it answers (back in the chunks the next cycle)", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(60, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const a = rows[3].id
    const b = rows[41].id
    let cycle = 0
    const chain = createFakeChain(db, (row) => (row.id === b || (row.id === a && cycle < 100) ? { burn: true } : notReady))
    const alone = (r0, id) => chain.singleCalls.slice(r0).filter((s) => s.id === id).length
    for (cycle of [0, 1, 30, 59, 60, 61, 90, 119, 120, 121]) {
      const before = chain.singleCalls.length
      const r = await runCycle(k, db, chain, cycle)
      const expected = cycle === 0 || cycle === 60 || cycle === 120 ? 1 : 0
      assert.equal(alone(before, a), expected, `cycle ${cycle} (${cycle / 2} min): row a asked alone ${alone(before, a)} time(s)`)
      assert.equal(alone(before, b), expected, `cycle ${cycle}: row b asked alone ${alone(before, b)} time(s)`)
      if (cycle === 120) assert.match(r.scanLine, /quarantined=1 /, "a answered at its re-ask and was released")
      if (cycle === 121) assert.ok(r.screened.includes(a), "a released row is back in the chunks")
    }
    assert.equal(k.stats.quarantineReleased, 1)
  })

  test("ten re-asks per cycle at most: 20 rows quarantined together are asked again 10, then 10, the cycles after 30 minutes", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(500)
    const db = createFakePostgrest(rows)
    const burners = new Set(Array.from({ length: 10 }, (_, j) => [rows[50 * j + 3].id, rows[50 * j + 41].id]).flat())
    const chain = createFakeChain(db, (row) => (burners.has(row.id) ? { burn: true } : notReady))
    await runCycle(k, db, chain, 0)
    assert.equal(k.stats.quarantinedRows, 20, "all 20 isolated in one cycle (4 calls per chunk, 40 in all)")
    const reasked = []
    for (const c of [59, 60, 61, 62]) {
      const before = k.stats.reaskCalls
      await runCycle(k, db, chain, c)
      reasked.push(k.stats.reaskCalls - before)
    }
    assert.deepEqual(reasked, [0, 10, 10, 0])
  })

  test("an expired quarantined row is still walked: the path marks it `expired` without asking canExecute", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(60, 1, { pinned: true })
    const expiry = Math.floor(T0 / 1000) + 45 // passed from cycle 2 (60 s)
    rows[3] = makeRow(4, { pinned: true, expiry })
    const db = createFakePostgrest(rows)
    const burners = new Set([rows[3].id, rows[41].id])
    const chain = createFakeChain(db, (row) => (burners.has(row.id) ? { burn: true } : notReady))
    await runCycle(k, db, chain, 0)
    assert.equal(k.stats.quarantinedRows, 2)
    await runCycle(k, db, chain, 2)
    assert.equal(db.table.find((r) => r.id === rows[3].id).status, "expired")
    assert.equal(chain.pathCalls.includes(rows[3].id), false)
  })

  test("ops is paged when the quarantine first holds 5 rows, quiet within the hour, again after it; the count only, never an id or address", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(150)
    const db = createFakePostgrest(rows)
    const burners = new Set([3, 41, 53, 91, 103, 141].map((i) => rows[i].id))
    const chain = createFakeChain(db, (row) => (burners.has(row.id) ? { burn: true } : notReady))
    await withTelegram(async () => {
      const sent = () => db.telegram.filter((m) => /prescreen-quarantine/.test(m.text))
      await runCycle(k, db, chain, 0)
      assert.equal(k.stats.quarantinedRows, 6)
      assert.equal(sent().length, 1)
      for (const c of [1, 2, 50]) await runCycle(k, db, chain, c)
      assert.equal(sent().length, 1, "quiet within the hour")
      await runCycle(k, db, chain, 121)
      assert.equal(sent().length, 2, "again after an hour while above 5")
      const text = sent()[0].text
      assert.match(text, /6 active order\(s\)/)
      assert.doesNotMatch(text, UUID)
      assert.doesNotMatch(text, /0x[0-9a-f]{6,}/i)
    })
  })
})

describe("[A91 R2-1, owner answer 2] hostile-only: an RPC failure never bisects or quarantines", () => {
  test("a chunk that fails with an HTTP 503 is not bisected: no single ask, its rows go to the 15-row budget, nothing quarantined", async () => {
    const k = await loadKeeper()
    const db = createFakePostgrest(rowsOf(60))
    const chain = createFakeChain(db, () => notReady, { aggregate: ({ chunkIndex }) => (chunkIndex === 0 ? "throw" : null) })
    const r = await runCycle(k, db, chain, 0)
    assert.equal(chain.singleCalls.length, 0)
    assert.equal(chain.aggregateCalls.length, 2, "the two chunks, nothing more")
    assert.equal(r.path.length, 15)
    assert.match(r.scanLine, /quarantined=0 rotate=no fallback=prescreen-1of2$/)
  })

  test("nothing answers (every call hits its time limit): the bisect stays within its budget and quarantines nothing", async () => {
    const k = await loadKeeper({ constants: { PRESCREEN_CHUNK_TIMEOUT_MS: 20 } })
    const db = createFakePostgrest(rowsOf(60))
    const chain = createFakeChain(db, (_row, _s, route) => (route === "single" ? { hang: true } : notReady), { aggregate: () => "hang" })
    const r = await runCycle(k, db, chain, 0)
    assert.ok(k.stats.bisectCalls > 0 && k.stats.bisectCalls <= 40, `${k.stats.bisectCalls} bisect calls`)
    assert.equal(k.stats.quarantinedRows, 0, "an RPC that answers nothing proves nothing about a row")
    assert.equal(r.path.length, 15, "the rows go to the 15-row budget")
  })

  test("200 burners among 600 rows: never more than 40 bisect calls and 10 re-asks in a cycle", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(600)
    const db = createFakePostgrest(rows)
    const rand = mulberry32(200)
    const burners = new Set()
    while (burners.size < 200) burners.add(rows[Math.floor(rand() * 600)].id)
    const chain = createFakeChain(db, (row) => (burners.has(row.id) ? { burn: true } : notReady))
    for (let c = 0; c < 4; c++) {
      const b0 = k.stats.bisectCalls
      const a0 = chain.aggregateCalls.length
      const s0 = chain.singleCalls.length
      const r = await runCycle(k, db, chain, c)
      const chunks = Number(/prescreen-\d+of(\d+)/.exec(r.scanLine)?.[1] ?? Math.ceil(600 / 50))
      assert.ok(k.stats.bisectCalls - b0 <= 40, `cycle ${c}: ${k.stats.bisectCalls - b0} bisect calls`)
      assert.ok(chain.aggregateCalls.length - a0 + chain.singleCalls.length - s0 <= chunks + 40, `cycle ${c}: more pre-screen calls than the chunks plus the budget`)
    }
    assert.ok(k.stats.quarantinedRows > 0)
  })
})

describe("[A91 R2-2, owner decision 'error = frozen'] the freeze read fails closed", () => {
  const world = async (constants = {}) => {
    const k = await loadKeeper({ constants })
    const dca = makeRow(1, { type: "dca" })
    const limit = makeRow(2, { pinned: true })
    const db = createFakePostgrest([dca, limit])
    const chain = createFakeChain(db, () => [true, ""], { wallet: true, account: true })
    return { k, db, chain, dca, limit }
  }

  test("a slow freeze read (5.5 s, answering frozen=true): the DCA row is held (never asked by the path, left active); the limit order still executes", async () => {
    const { k, db, chain, dca, limit } = await world()
    db.setFreeze({ status: 200, body: '[{"frozen":true,"reason":"ops freeze"}]', delayMs: 5_500 })
    const r = await withTelegram(() => runCycle(k, db, chain, 0))
    assert.ok(r.lines.some((l) => l.includes("freeze read timed out -- treating as FROZEN this cycle")), r.lines.join("\n"))
    assert.ok(r.lines.some((l) => l.includes(`Order ${dca.id.slice(0, 8)}... DCA execution FROZEN -- delaying (left active)`)))
    assert.equal(r.path.includes(dca.id), false, "the DCA row never reached the path's canExecute")
    assert.deepEqual(r.executed, [limit.id], "non-DCA orders are unaffected")
    assert.equal(db.table.find((x) => x.id === dca.id).status, "active")
    assert.equal(k.stats.freezeReadFailedCycles, 1)
    assert.equal(k.stats.freezeReadFailure, "timeout")
    assert.equal(db.telegram.filter((m) => /freeze-read-failed/.test(m.text)).length, 1)
  })

  // [owner answers 0 and 1] Only a well-formed answer saying not frozen passes. MAIN passes every row marked * (fail-open).
  const OUTCOMES = [
    ["answer frozen=false", { body: '[{"frozen":false,"reason":null}]' }, false, null],
    ["answer frozen=true", { body: '[{"frozen":true,"reason":"maintenance"}]' }, true, null],
    ["HTTP 503 *", { status: 503, body: "upstream" }, true, "http-503"],
    ["HTTP 404, no table *", { status: 404, body: '{"code":"PGRST205"}' }, true, "http-404"],
    ["network error *", "throw", true, "network"],
    ["body not JSON *", { body: "<html>" }, true, "malformed"],
    ["body not a list *", { body: '{"frozen":false}' }, true, "malformed"],
    ["frozen not a boolean *", { body: '[{"frozen":"false"}]' }, true, "malformed"],
    ["no dca row *", { body: "[]" }, true, "row-missing"],
    ["time limit (scaled: 100 ms limit, 300 ms answer) *", { body: '[{"frozen":false}]', delayMs: 300 }, true, "timeout"],
  ]
  for (const [label, spec, frozen, failure] of OUTCOMES) {
    test(`${label} ⇒ ${frozen ? "FROZEN" : "not frozen"} for DCA this cycle`, async () => {
      const { k, db, chain, dca } = await world({ SUPABASE_READ_TIMEOUT_MS: 100 })
      db.setFreeze(spec)
      const r = await runCycle(k, db, chain, 0)
      assert.equal(r.path.includes(dca.id), !frozen, r.lines.join("\n"))
      assert.equal(k.stats.freezeReadFailure, failure)
      assert.equal(k.stats.freezeReadFailedCycles, failure ? 1 : 0)
      if (failure) assert.ok(r.lines.some((l) => /freeze read .* -- treating as FROZEN this cycle/.test(l)))
      assert.equal(r.lines.some((l) => /treating as NOT frozen/.test(l)), false)
    })
  }

  test("/health shows freezeReadFailedCycles and freezeReadFailure (source anchor: additive fields of stats)", () => {
    const health = SRC.slice(SRC.indexOf('if (req.url === "/health"'), SRC.indexOf('else if (req.url === "/")'))
    for (const f of ["freezeReadFailedCycles", "freezeReadFailure", "quarantinedRows", "quarantinedTotal", "quarantineReleased", "bisectCalls", "reaskCalls", "scanWrapFailedCycles", "longCycles"]) {
      assert.ok(health.includes(`${f}: stats.${f}`), f)
    }
    assert.match(health, /cycleRunningSec: tickInFlight \?/)
  })
})

describe("[A91] one cycle at a time needs a watchdog", () => {
  test("fake clock: a cycle still running at 5 minutes pages ops once (warn) and counts on /health; it is not killed; a cycle that ends in time pages nothing", async () => {
    const k = await loadKeeper()
    const db = createFakePostgrest([])
    const realFetch = globalThis.fetch
    globalThis.fetch = db.fetch
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 })
    try {
      await withTelegram(async () => {
        const flush = async () => {
          for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
        }
        const sent = () => db.telegram.filter((m) => /cycle-watchdog/.test(m.text)).length
        // A cycle that ends after 4 minutes: no page.
        let endShort
        const short = k.runOneCycleAtATime__opt(() => new Promise((r) => (endShort = r)))
        mock.timers.tick(4 * 60_000)
        endShort()
        await short
        mock.timers.tick(10 * 60_000)
        await flush()
        assert.equal(sent(), 0)
        // A cycle that never ends.
        let finished = false
        const long = k.runOneCycleAtATime__opt(() => new Promise(() => {})).then(() => (finished = true))
        mock.timers.tick(5 * 60_000 - 1)
        await flush()
        assert.equal(sent(), 0, "not before 5 minutes")
        mock.timers.tick(1)
        await flush()
        assert.equal(sent(), 1, "one page at 5 minutes")
        assert.equal(k.stats.longCycles, 1)
        mock.timers.tick(60 * 60_000)
        await flush()
        assert.equal(sent(), 1, "once per long cycle")
        assert.equal(finished, false, "the cycle is not killed")
        assert.equal(await k.runOneCycleAtATime__opt(async () => assert.fail("must not run")), false, "ticks are still skipped while it runs")
        void long
      })
    } finally {
      mock.timers.reset()
      globalThis.fetch = realFetch
    }
  })

  test("source: the boot cycle runs under the same guard (and watchdog) as the interval's", () => {
    const main = SRC.slice(SRC.indexOf("async function main() {"))
    assert.match(main, /await runOneCycleAtATime\(runTick\)/)
  })

  // Every limit scaled down in the temp copy; the fake chain's hanging calls reject at 70 ms with viem's TimeoutError,
  // standing in for viem's http transport limit (10 s per try), which the fake bypasses.
  const LIMITS = { SUPABASE_READ_TIMEOUT_MS: 60, SUPABASE_WRITE_TIMEOUT_MS: 80, PRESCREEN_CHUNK_TIMEOUT_MS: 50, SWAP_API_TIMEOUT_MS: 90 }
  const RPC_MS = 70

  test("every external call hangs: the cycle ends (it throws at the stale-unlock write) within balance + freeze + ETH/USD + write limits", async () => {
    const k = await loadKeeper({ constants: LIMITS })
    const db = createFakePostgrest(rowsOf(20))
    db.failWhen(() => "hang")
    db.setFreeze("hang")
    const chain = createFakeChain(db, () => notReady, { wallet: true, account: true, rpcHang: () => true, rpcLimitMs: RPC_MS })
    const t0 = performance.now()
    const outcome = await settles(
      withFakes(db, () => k.executeCycle(chain.publicClient, chain.walletClient, null, null, null, null), { nowMs: T0 }).then(() => "resolved", (e) => `threw: ${e?.name}`),
      10_000,
      "a cycle with every call hanging",
    )
    const ms = performance.now() - t0
    const sum = RPC_MS + LIMITS.SUPABASE_READ_TIMEOUT_MS + RPC_MS + LIMITS.SUPABASE_WRITE_TIMEOUT_MS
    assert.match(outcome, /threw: (TimeoutError|AbortError)/)
    assert.ok(ms < sum + 2_000, `${Math.round(ms)} ms > sum of limits ${sum} ms (+2 s scheduling)`)
  })

  test("every call after the scan read hangs (RPC, writes, the swap API): the pre-screen, the bisect and the path each stop at their limits and the cycle ends", async () => {
    const k = await loadKeeper({ constants: LIMITS, env: { TERASWAP_API_URL: "http://api.fake.test" } })
    const db = createFakePostgrest(rowsOf(20, 1, { pinned: true }))
    db.failWhen((req) => (req.method === "GET" && req.path === "/rest/v1/orders") || /status=eq\.executing/.test(req.search) ? null : "hang")
    db.setFreeze("hang")
    const chain = createFakeChain(db, (_row, _s, route) => (route === "single" ? { hang: true } : notReady), { wallet: true, account: true, aggregate: () => "hang", rpcHang: (m) => m !== "aggregate3" && m !== "canExecute", rpcLimitMs: RPC_MS })
    const t0 = performance.now()
    await settles(
      withFakes(db, () => k.executeCycle(chain.publicClient, chain.walletClient, null, null, null, null), { nowMs: T0 }).catch(() => null),
      15_000,
      "a cycle whose every call after the scan hangs",
    )
    const ms = performance.now() - t0
    // balance + freeze + ETH/USD, one chunk + at most 40 bisect calls, then the first walked row's lock write and its
    // failure write (the cycle ends there or earlier).
    const sum = RPC_MS + LIMITS.SUPABASE_READ_TIMEOUT_MS + RPC_MS + (1 + 40) * LIMITS.PRESCREEN_CHUNK_TIMEOUT_MS + 15 * 2 * LIMITS.SUPABASE_WRITE_TIMEOUT_MS
    assert.ok(k.stats.bisectCalls <= 40)
    assert.ok(ms < sum + 2_000, `${Math.round(ms)} ms > sum of limits ${sum} ms (+2 s scheduling)`)
  })
})

describe("[A91 R2-3] a fallback cycle keeps the carry-over list", () => {
  test("rotating (scan 20 of 60): 3 ready rows carried; the next cycle's scan query fails (503); the cycle after, the carried rows execute first", async () => {
    const k = await loadKeeper({ constants: { SCAN_CAP: 20 } })
    const rows = rowsOf(60, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const index = new Map(rows.map((r, i) => [r.id, i]))
    const ready = new Set()
    const chain = createFakeChain(db, (row) => (ready.has(row.id) ? [true, ""] : notReady), { wallet: true })
    const random = mulberry32(60)
    let failScan = false
    db.failWhen((req) => (failScan && req.method === "GET" && /order=created_at\.asc%2Cid\.asc/.test(req.search) ? { status: 503, body: "" } : null))
    const warm = await runCycle(k, db, chain, 0, { random })
    const next = (k0, n) => Array.from({ length: n }, (_, i) => rows[(k0 + i) % 60].id)
    const page1 = next(index.get(warm.screened.at(-1)) + 1, 20)
    const picks = page1.filter((id) => index.get(id) >= 15).slice(0, 8) // never among the fallback's 15 oldest
    assert.equal(picks.length, 8)
    for (const id of picks) ready.add(id)
    const c1 = await runCycle(k, db, chain, 1, { random })
    assert.equal(c1.executed.length, 5)
    const carried = picks.filter((id) => !c1.executed.includes(id))
    assert.equal(carried.length, 3)
    failScan = true
    const c2 = await runCycle(k, db, chain, 2, { random })
    assert.match(c2.scanLine, /carried=3 .*fallback=scan-503$/, "the fallback cycle shows the kept list")
    failScan = false
    const c3 = await runCycle(k, db, chain, 3, { random })
    assert.deepEqual(c3.executed.slice(0, 3), carried, "the carried rows execute first, the cycle after the fallback")
  })
})

describe("[A91 R2-4] a failed wrap read is flagged, counted and alerted", () => {
  test("scan 50 of 120: the page reaches the newest row, the wrap read fails ⇒ fallback=scan-wrap, /health counts it, ops is paged once; the next cycle starts at the oldest row", async () => {
    const k = await loadKeeper({ constants: { SCAN_CAP: 50 } })
    const rows = rowsOf(120)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => notReady)
    const random = mulberry32(120)
    let failWrap = false
    let ordersGets = 0
    db.failWhen((req) => {
      if (!failWrap || req.method !== "GET" || req.path !== "/rest/v1/orders") return null
      ordersGets++
      const wrapRead = ordersGets > 1 && /order=created_at\.asc%2Cid\.asc/.test(req.search) && !/[?&]or=/.test(req.search) && !/[?&]offset=/.test(req.search)
      return wrapRead ? { status: 503, body: "" } : null
    })
    await withTelegram(async () => {
      let flagged = null
      for (let c = 0; c < 6 && flagged === null; c++) {
        failWrap = true
        ordersGets = 0
        const r = await runCycle(k, db, chain, c, { random })
        if (/fallback=scan-wrap/.test(r.scanLine ?? "")) flagged = { c, r }
      }
      assert.ok(flagged, "no cycle flagged fallback=scan-wrap")
      assert.match(flagged.r.scanLine, /fallback=scan-wrap$/)
      assert.equal(k.stats.scanWrapFailedCycles, 1)
      const alerts = db.telegram.filter((m) => /active-scan-wrap-failed/.test(m.text))
      assert.equal(alerts.length, 1)
      assert.doesNotMatch(alerts[0].text, UUID)
      failWrap = false
      const after = await runCycle(k, db, chain, flagged.c + 1, { random })
      assert.equal(after.screened[0], rows[0].id, "the next scan starts at the oldest row")
    })
  })
})
