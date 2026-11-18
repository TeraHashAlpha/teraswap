// [SEC-4 / A88 round 2] Shipped-cycle tests of the scan, the pre-screen, the walk and the carry-over, with a fake
// wallet that REALLY executes (executor-cycle.fixture.mjs): S-6 (MAX_BATCH mid-list, gas SKIP, carry-over leading
// the next cycle), pre-screen failures (one call reverting, a chunk timing out, Multicall3 absent), S-7 (alerts and
// /health counters), S-3's two-complete-scans prune, S-11's capped detail line, and the pre-screen asking with the
// path's own struct (v2 and v3).
//
// Run: node --test contracts/order-engine/executor/active-scan-cycle.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { HttpRequestError, decodeFunctionData } from "viem"

import { createFakePostgrest, createFakeChain, makeRow, mulberry32, withFakes, V2_EXECUTOR } from "./executor-cycle.fixture.mjs"
import { CYCLE_MS, T0, loadKeeper, runCycle } from "./active-scan.testlib.mjs"

const V3_EXECUTOR = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
const rowsOf = (n, from = 1, opts = {}) => Array.from({ length: n }, (_, i) => makeRow(from + i, opts))
const SRC = readFileSync(new URL("./executor.js", import.meta.url), "utf8")

describe("[S-6] shipped cycles that really execute", () => {
  test("MAX_BATCH mid-list: 8 ready rows among 20 ⇒ the 5 oldest execute, 3 are carried and execute first next cycle", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(20, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const ready = new Set([2, 4, 5, 8, 11, 13, 17, 19].map((i) => rows[i].id))
    const chain = createFakeChain(db, (row) => (ready.has(row.id) ? [true, ""] : [false, "Price below floor"]), { wallet: true })
    const c0 = await runCycle(k, db, chain, 0)
    assert.deepEqual(c0.executed, [2, 4, 5, 8, 11].map((i) => rows[i].id), "the 5 oldest ready rows, oldest first")
    assert.match(c0.scanLine, /active=20 scanned=20 true=8 attempted=5 carried=3 quarantined=0 rotate=no fallback=none$/)
    const c1 = await runCycle(k, db, chain, 1)
    assert.deepEqual(c1.executed, [13, 17, 19].map((i) => rows[i].id))
    assert.match(c1.scanLine, /active=15 scanned=15 true=3 attempted=3 carried=0/)
    assert.equal(db.executionsPosted.length, 8, "every fill recorded")
    assert.deepEqual(db.unexpected, [])
  })

  test("gas SKIP: the cycle stops on the first ready row, carries all 3, and the next cycle executes them in order", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(10, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const ready = [1, 6, 9].map((i) => rows[i].id)
    let skip = true
    const chain = createFakeChain(db, (row) => (ready.includes(row.id) ? [true, ""] : [false, "Price below floor"]), {
      wallet: true,
      gasPriceWei: () => (skip ? 1_000_000_000n : 10_000_000n),
    })
    const c0 = await runCycle(k, db, chain, 0)
    assert.deepEqual(c0.executed, [])
    assert.deepEqual(c0.path, [ready[0]], "the loop stopped on the first ready row")
    assert.match(c0.scanLine, /true=3 attempted=1 carried=3/)
    skip = false
    const c1 = await runCycle(k, db, chain, 1)
    assert.deepEqual(c1.executed, ready)
  })

  test("carry-over leads the next cycle when the rotating scan has moved on (re-read by id, attempted first)", async () => {
    const k = await loadKeeper({ constants: { SCAN_CAP: 20 } })
    const rows = rowsOf(60, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const index = new Map(rows.map((r, i) => [r.id, i]))
    const ready = new Set()
    const chain = createFakeChain(db, (row) => (ready.has(row.id) ? [true, ""] : [false, "Price below floor"]), { wallet: true })
    const random = mulberry32(60)
    const warm = await runCycle(k, db, chain, 0, { random }) // the fresh process's random page; nothing ready
    const next = (k0, n) => Array.from({ length: n }, (_, i) => rows[(k0 + i) % 60].id)
    const page1 = next(index.get(warm.screened.at(-1)) + 1, 20)
    for (const id of page1.slice(0, 8)) ready.add(id)
    const c1 = await runCycle(k, db, chain, 1, { random })
    assert.deepEqual(c1.executed, page1.slice(0, 5))
    const carried = page1.slice(5, 8)
    const page2 = next(index.get(page1.at(-1)) + 1, 20)
    for (const id of page2.slice(0, 2)) ready.add(id)
    const c2 = await runCycle(k, db, chain, 2, { random })
    assert.ok(c2.requests.some((r) => /id=in\.\(/.test(r.search)), "the carried rows are re-read by id")
    assert.deepEqual(c2.executed, [...carried, ...page2.slice(0, 2)], "carried rows go first, then the new page's ready rows")
  })
})

describe("[pre-screen] failures never leave a cycle that examines nothing", () => {
  test("one call in a chunk reverts: that row goes down the path one by one (and executes); the rest are answered", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(10, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const odd = rows[3].id
    const chain = createFakeChain(db, (row, _s, route) => (row.id === odd ? (route === "screen" ? { revert: true } : [true, ""]) : [false, "Price below floor"]), { wallet: true })
    const c0 = await runCycle(k, db, chain, 0)
    assert.equal(c0.screened.length, 10)
    assert.deepEqual(c0.path, [odd])
    assert.deepEqual(c0.executed, [odd])
    assert.match(c0.scanLine, /scanned=10 true=0 attempted=1 carried=0 quarantined=0 rotate=no fallback=none$/, "one row's revert is not a chunk failure")
  })

  // [A91 R2-1] ROUND 3 CHANGED THIS TEST. Round 2 pinned "the scan holds at that chunk" (the next scan started at the
  // failed chunk's first row, and its rows went to the 15-row budget); a hostile row could make that chunk fail every
  // cycle and freeze the rotation. Now the failed chunk is BISECTED in the same cycle and the scan moves on.
  test("ROUND 3: a chunk times out: it is bisected in the same cycle (every row answered by the pre-screen, none left for the 15-row budget), the cycle is flagged, and the scan does NOT hold — the next page starts after the last row read", async () => {
    const k = await loadKeeper({ constants: { SCAN_CAP: 150, PRESCREEN_CHUNK_TIMEOUT_MS: 100 } })
    const rows = rowsOf(200)
    const db = createFakePostgrest(rows)
    let hang = true
    const chain = createFakeChain(db, () => [false, "Price below floor"], { aggregate: ({ chunkIndex }) => (hang && chunkIndex === 1 ? "hang" : null) })
    const index = new Map(rows.map((r, i) => [r.id, i]))
    // Seed 7's random first page; whatever it is, chunk 1 holds rows 50..99 of that page.
    const random = mulberry32(7)
    const c0 = await runCycle(k, db, chain, 0, { random })
    assert.equal(new Set(c0.screened).size, 150, "chunks 0 and 2 answered, and chunk 1's rows through its two halves")
    assert.deepEqual(chain.aggregateCalls.slice(3).map((c) => c.size), [25, 25], "the timed-out chunk: two halves of 25, both answered")
    assert.equal(c0.path.length, 0, "no row left for the 15-row budget")
    assert.match(c0.scanLine, /quarantined=0 rotate=yes fallback=prescreen-1of3$/)
    assert.equal(k.stats.prescreenFallbackCycles, 1)
    const lastRead = chain.aggregateCalls[2].ids.at(-1)
    hang = false
    const c1 = await runCycle(k, db, chain, 1, { random })
    assert.equal(index.get(c1.screened[0]), (index.get(lastRead) + 1) % rows.length, "the next scan starts after the last row read, not at the failed chunk")
    assert.match(c1.scanLine, /fallback=none$/)
  })

  // [A91 R2-1] ROUND 3 CHANGED THE COUNT: "absent" is not an RPC transport error, so the chunk is bisected and the
  // bisect's gas-capped single asks (direct canExecute calls: no Multicall3 needed) answer about 20 of the 40 rows
  // each cycle; the path still asks 15 rows one by one. "All 40 asked" now counts both routes, not the path alone.
  test("Multicall3 absent: every cycle still examines 15 rows one by one, rotating, and the bisect asks others alone, so 40 rows are all asked within 3 cycles", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(40)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "Price below floor"], { aggregate: () => "absent" })
    const asked = new Set()
    for (let c = 0; c < 3; c++) {
      const b0 = k.stats.bisectCalls
      const r = await runCycle(k, db, chain, c)
      assert.equal(r.path.length, 15, `cycle ${c} asked ${r.path.length} rows one by one`)
      assert.match(r.scanLine, /scanned=40 true=0 attempted=15 carried=0 quarantined=0 rotate=no fallback=prescreen-1of1$/)
      assert.ok(k.stats.bisectCalls - b0 <= 40)
      for (const id of r.asked) asked.add(id)
    }
    assert.equal(asked.size, 40)
    assert.equal(k.stats.quarantinedRows, 0, "rows that answer alone are never quarantined")
  })
})

describe("[S-7] a fallback pages ops on its first cycle, then hourly while it lasts, and counts on /health", () => {
  test("scan query failing: alert on cycle 0, quiet while it persists, again after an hour, again after a good cycle", async () => {
    const k = await loadKeeper()
    const db = createFakePostgrest(rowsOf(20))
    const chain = createFakeChain(db, () => [false, "Price below floor"])
    let failing = true
    db.failWhen((req) => (failing && req.method === "GET" && /order=created_at\.asc%2Cid\.asc/.test(req.search) ? { status: 503, body: "" } : null))
    const saved = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID }
    process.env.TELEGRAM_BOT_TOKEN = "fixture-bot"
    process.env.TELEGRAM_CHAT_ID = "fixture-chat"
    try {
      const sent = () => db.telegram.filter((m) => /active-scan-fallback/.test(m.text)).length
      await runCycle(k, db, chain, 0)
      assert.equal(sent(), 1, "first cycle of the run")
      for (let c = 1; c < 5; c++) await runCycle(k, db, chain, c)
      assert.equal(sent(), 1, "quiet while it persists (within the hour)")
      await runCycle(k, db, chain, 121) // an hour later, still failing
      assert.equal(sent(), 2)
      failing = false
      await runCycle(k, db, chain, 122)
      failing = true
      await runCycle(k, db, chain, 123)
      assert.equal(sent(), 3, "a new run alerts at once")
      assert.equal(k.stats.scanFallbackCycles, 7)
      const text = db.telegram.find((m) => /active-scan-fallback/.test(m.text)).text
      assert.match(text, /EXECUTOR-OPERATIONS\.md § 9/)
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-|https?:\/\//)
    } finally {
      if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = saved.token
      if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID
      else process.env.TELEGRAM_CHAT_ID = saved.chat
    }
  })

  test("/health reports the three counters (source anchor: additive fields of stats)", () => {
    const health = SRC.slice(SRC.indexOf('if (req.url === "/health"'), SRC.indexOf('else if (req.url === "/")'))
    for (const f of ["scanFallbackCycles", "prescreenFallbackCycles", "overlapSkippedTicks"]) assert.ok(health.includes(`${f}: stats.${f}`), f)
  })
})

describe("[S-3] an ADR-026 streak survives one complete scan without its row; two drop it", () => {
  test("a row `executing` during one cycle keeps its streak; a row gone for two complete scans loses it", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(12)
    const db = createFakePostgrest(rows)
    const x = rows[4]
    const chain = createFakeChain(db, (row, _s, route) =>
      row.id === x.id ? (route === "screen" ? [true, ""] : { throw: new HttpRequestError({ url: "https://rpc.example/v2/K", status: 503 }) }) : [false, "Price below floor"],
    )
    await runCycle(k, db, chain, 0)
    assert.ok(k.orderInfraMisses.has(x.id), "the path's 503 is an infra miss: a streak")
    db.table.find((r) => r.id === x.id).status = "executing" // another process holds it during this cycle's scan
    await runCycle(k, db, chain, 1)
    assert.ok(k.orderInfraMisses.has(x.id), "absent from ONE complete scan: kept")
    db.table.find((r) => r.id === x.id).status = "active"
    await runCycle(k, db, chain, 2)
    assert.ok(k.orderInfraMisses.has(x.id))
    db.remove(x.id)
    await runCycle(k, db, chain, 3)
    assert.ok(k.orderInfraMisses.has(x.id), "gone for one complete scan: still kept")
    await runCycle(k, db, chain, 4)
    assert.equal(k.orderInfraMisses.has(x.id), false, "gone for two consecutive complete scans: dropped")
  })
})

describe("[pre-screen] asks with exactly what the path sends (the path's own builders)", () => {
  for (const [label, env, extra] of [
    ["v2 order", {}, {}],
    ["v3 order", { ORDER_EXECUTOR_V3_ADDRESS: V3_EXECUTOR }, { maxSlippageBps: 75 }],
  ]) {
    test(`${label}: the struct, signature and executor address of the aggregate3 call equal the path's canExecute call`, async () => {
      const k = await loadKeeper({ env })
      const row = makeRow(1, { pinned: true })
      Object.assign(row.order_data, extra)
      const db = createFakePostgrest([row, makeRow(2)])
      const chain = createFakeChain(db, (r) => (r.id === row.id ? [true, ""] : [false, "Price below floor"]), { wallet: true })
      const seen = { screen: null, path: null }
      const read = chain.publicClient.readContract.bind(chain.publicClient)
      chain.publicClient.readContract = async (req) => {
        if (req.functionName === "aggregate3") {
          for (const c of req.args[0]) {
            const abi = [{ name: "canExecute", type: "function", stateMutability: "view", inputs: [{ name: "order", type: "tuple", components: (extra.maxSlippageBps ? V3_COMPONENTS : V2_COMPONENTS) }, { name: "signature", type: "bytes" }], outputs: [{ type: "bool" }, { type: "string" }] }]
            const d = decodeFunctionData({ abi, data: c.callData })
            if (String(d.args[0].nonce) === row.order_data.nonce) seen.screen = { target: c.target, allowFailure: c.allowFailure, args: d.args }
          }
        }
        if (req.functionName === "canExecute" && String(req.args[0].nonce) === row.order_data.nonce) seen.path = { target: req.address, args: req.args }
        return read(req)
      }
      const r = await runCycle(k, db, chain, 0)
      assert.deepEqual(r.executed, [row.id])
      assert.equal(seen.screen.allowFailure, true)
      assert.equal(seen.screen.target, extra.maxSlippageBps ? V3_EXECUTOR : V2_EXECUTOR)
      assert.equal(seen.path.target, seen.screen.target)
      assert.deepEqual(seen.screen.args, seen.path.args, "the same struct and signature")
    })
  }

  test("source: one builder — resolveOrderRouting / buildOrderStruct are called by both the pre-screen and the path, and no second struct literal exists", () => {
    assert.equal(SRC.split("= buildOrderStruct(od, ").length - 1, 2, "canExecuteCallFor + the path")
    assert.equal(SRC.split("= resolveOrderRouting(od)").length - 1, 2, "canExecuteCallFor + the path")
    assert.equal(SRC.split("owner: getAddress(od.owner)").length - 1, 1, "one struct literal")
    assert.equal(SRC.split("resolveExecutorRouting({").length - 1, 1, "one routing call")
  })
})

describe("[S-11 / pre-screen] logs and status", () => {
  test("the once-per-process scan failure line carries no order id, address or URL, at most 200 body characters", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(5)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "Price below floor"])
    db.failNextMatching(/order=created_at\.asc%2Cid\.asc/, 400, `{"message":"bad filter id.gt.${rows[2].id} 0x${"ab".repeat(20)} https://supabase.example/rest/v1/orders ${"y".repeat(500)}"}`, "GET")
    const c0 = await runCycle(k, db, chain, 0)
    const line = c0.lines.find((l) => l.includes("Active scan query FAILED"))
    assert.ok(line)
    assert.doesNotMatch(line, /[0-9a-f]{8}-[0-9a-f]{4}-|0x[0-9a-f]{40}|https?:\/\//i)
    assert.ok(line.length < 420, `${line.length} characters`)
  })

  test("the pre-screen never changes a row: a cycle whose rows all answer false sends no PATCH to any row", async () => {
    const k = await loadKeeper()
    const db = createFakePostgrest(rowsOf(30))
    const chain = createFakeChain(db, () => [false, "Insufficient allowance"])
    const r = await runCycle(k, db, chain, 0)
    const rowPatches = r.requests.filter((q) => q.method === "PATCH" && /[?&]id=eq\./.test(q.search))
    assert.deepEqual(rowPatches, [])
    assert.equal(r.screened.length, 30)
  })
})

describe("[S-3] one tick at a time (main's setInterval runs runOneCycleAtATime)", () => {
  test("a second and third tick while the first runs are skipped, counted, and logged once", async () => {
    const k = await loadKeeper()
    const db = createFakePostgrest([])
    let release
    const gate = new Promise((r) => (release = r))
    const out = await withFakes(db, async () => {
      const first = k.runOneCycleAtATime__opt(() => gate)
      const second = await k.runOneCycleAtATime__opt(async () => assert.fail("must not run"))
      const third = await k.runOneCycleAtATime__opt(async () => assert.fail("must not run"))
      release()
      return [await first, second, third, await k.runOneCycleAtATime__opt(async () => {})]
    }, { nowMs: T0 + CYCLE_MS })
    assert.deepEqual(out.result, [true, false, false, true])
    assert.equal(k.stats.overlapSkippedTicks, 2)
    assert.equal(out.lines.filter((l) => l.includes("Tick skipped")).length, 1)
  })
  test("source: the interval wraps the tick in runOneCycleAtATime (and still runs runTick, never executeCycle directly)", () => {
    const main = SRC.slice(SRC.indexOf("async function main() {"))
    const interval = main.slice(main.indexOf("setInterval(async () => {"), main.indexOf("}, POLL_INTERVAL_MS)"))
    assert.match(interval, /await runOneCycleAtATime\(async \(\) => \{\s*await runTick\(\)\s*\}\)/)
  })
})

const V2_COMPONENTS = [
  { name: "owner", type: "address" },
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" },
  { name: "orderType", type: "uint8" },
  { name: "condition", type: "uint8" },
  { name: "targetPrice", type: "uint256" },
  { name: "priceFeed", type: "address" },
  { name: "expiry", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "router", type: "address" },
  { name: "routerDataHash", type: "bytes32" },
  { name: "dcaInterval", type: "uint256" },
  { name: "dcaTotal", type: "uint256" },
]
const V3_COMPONENTS = [...V2_COMPONENTS.slice(0, 5), { name: "maxSlippageBps", type: "uint16" }, ...V2_COMPONENTS.slice(5)]
