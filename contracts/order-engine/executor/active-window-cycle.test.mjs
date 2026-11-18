// [SEC-4 / fix/keeper-active-orders-window] The keeper only ever looked at the 15 oldest active rows of
// its chain: fetchActiveOrders asked for status=eq.active, this chain, order=created_at.asc,
// limit=MAX_BATCH*3, and a row whose canExecute is false is unlocked back to `active` without a miss, so
// it keeps its place. 15 rows that cannot execute yet (unfunded, no allowance, a DCA waiting for its
// interval) hid every newer order on that chain until they expired.
//
// These tests run the SHIPPED executeCycle / fetchActiveOrders (executor-cycle.fixture.mjs copies
// executor.js with its imports made absolute and main() cut) against a fake PostgREST and a fake chain.
// "Examined" at this level = canExecute was asked for that row (round 2: by the pre-screen or by the path).
//
// Round 2 (A88): the expectations that encoded round 1's 15-row window, its `Active window:` line and the
// balance/allowance slow-down changed with the design (listed in CAPITALS in the branch's feedback file); a
// test that needs a rotating scan rewrites SCAN_CAP to 15 in the temp copy. The seeded property moved to
// active-scan-property.test.mjs.
//
// Run: node --test contracts/order-engine/executor/active-window-cycle.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { loadShippedExecutor, createFakePostgrest, createFakeChain, makeRow, withFakes, mulberry32, OTHER_CHAIN_ID } from "./executor-cycle.fixture.mjs"

const WINDOW = 15 // MAX_BATCH * 3 — main's per-cycle row budget, and the scaled scan below
const SCAN = 1000 // SCAN_CAP

/** 15 old rows that cannot execute (5 unfunded, 5 without allowance, 5 DCA between chunks). */
function fifteenStuckRows() {
  const rows = []
  for (let i = 1; i <= 15; i++) rows.push(makeRow(i, { type: i > 10 ? "dca" : "limit" }))
  return rows
}
const STUCK_REASON = (row) => {
  const n = Number(row.order_data.nonce) - 1_000_000
  if (n <= 5) return "Insufficient balance"
  if (n <= 10) return "Insufficient allowance"
  return "DCA interval not reached"
}

const CYCLE_MS = 30_000 // POLL_INTERVAL_MS
const T0 = Date.now()

/** `cycles` full cycles of the shipped keeper; the fake clock advances one poll per cycle from `startMs`. */
async function runCycles(k, db, chain, cycles, { startMs = T0, onBeforeCycle = null, random = null } = {}) {
  const perCycle = []
  const pathPerCycle = []
  const lines = []
  const windowLines = []
  const returned = []
  for (let c = 0; c < cycles; c++) {
    if (onBeforeCycle) onBeforeCycle(c)
    const before = chain.canExecuteCalls.length
    const pathBefore = chain.pathCalls.length
    const out = await withFakes(db, () => k.executeCycle(chain.publicClient, null, null, null, null, null), { nowMs: startMs + c * CYCLE_MS, random })
    lines.push(...out.lines)
    windowLines.push(out.lines.filter((l) => l.includes("Active scan:")))
    returned.push(out.result)
    perCycle.push(chain.canExecuteCalls.slice(before))
    pathPerCycle.push(chain.pathCalls.slice(pathBefore))
  }
  return { perCycle, pathPerCycle, lines, windowLines, returned }
}
const scaled = () => loadShippedExecutor({ constants: { SCAN_CAP: WINDOW } })

describe("[SEC-4] Step 0 — the 15 oldest non-executable rows must not hide a newer order", () => {
  test("15 old rows whose canExecute is false + 1 newer executable row: the newer row is examined within 20 cycles", async () => {
    const k = await loadShippedExecutor()
    const newer = makeRow(100)
    const db = createFakePostgrest([...fifteenStuckRows(), newer])
    const chain = createFakeChain(db, (row) => (row.id === newer.id ? [true, ""] : [false, STUCK_REASON(row)]))

    const { perCycle, pathPerCycle } = await runCycles(k, db, chain, 20)

    for (const [i, ids] of perCycle.entries()) {
      // ROUND 2: every row is screened each cycle (16 <= SCAN_CAP); the path asks only the row that answered true.
      assert.ok(ids.length <= SCAN + WINDOW, `cycle ${i + 1} asked ${ids.length} times`)
      assert.ok(pathPerCycle[i].every((id) => id === newer.id), `cycle ${i + 1}: the path asked a row that answered false`)
    }
    assert.deepEqual(db.unexpected, [], `requests the fake did not expect: ${db.unexpected.join(" | ")}`)
    const firstSeen = perCycle.findIndex((ids) => ids.includes(newer.id))
    assert.ok(
      firstSeen >= 0,
      `the newer executable row was never examined in 20 cycles; per-cycle canExecute calls: ` +
        perCycle.map((ids) => ids.length).join(","),
    )
  })
})

// ── shipped cycle: edges named by the goal ────────────────────────────────────────────────────────

const answerBy = (map) => (row) => map.get(row.id) ?? [false, "DCA interval not reached"]
const rowsOf = (n, from = 1, opts = {}) => Array.from({ length: n }, (_, i) => makeRow(from + i, opts))

describe("[SEC-4] shipped cycle — edges", () => {
  test("empty table: 'No active orders', returns 0 (idle cadence), one window line active=0, no RPC", async () => {
    const k = await loadShippedExecutor()
    const db = createFakePostgrest([])
    const chain = createFakeChain(db, () => assert.fail("canExecute on an empty table"))
    const { returned, windowLines, lines } = await runCycles(k, db, chain, 2)
    assert.deepEqual(returned, [0, 0])
    assert.ok(lines.some((l) => l.includes("No active orders")))
    assert.deepEqual(windowLines.map((w) => w.length), [1, 1])
    assert.match(windowLines[0][0], /Active scan: active=0 scanned=0 true=0 attempted=0 carried=0 quarantined=0 rotate=no fallback=none$/)
  })

  test("one row: examined every cycle", async () => {
    const k = await loadShippedExecutor()
    const db = createFakePostgrest([makeRow(1)])
    const chain = createFakeChain(db, () => [false, "Price below floor"])
    const { perCycle, returned } = await runCycles(k, db, chain, 4)
    assert.deepEqual(perCycle.map((ids) => ids.length), [1, 1, 1, 1])
    assert.deepEqual(returned, [1, 1, 1, 1], "an active row keeps the cadence ACTIVE")
  })

  test("exactly 15 rows: all 15 examined every cycle, oldest first", async () => {
    const k = await loadShippedExecutor()
    const rows = rowsOf(15)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    const { perCycle, windowLines } = await runCycles(k, db, chain, 4)
    for (const ids of perCycle) assert.deepEqual(ids, rows.map((r) => r.id))
    assert.match(windowLines[0][0], /active=15 scanned=15 true=0 attempted=0 carried=0 quarantined=0 rotate=no fallback=none$/, "the count says the page holds the whole chain")
    assert.match(windowLines[1][0], /active=15 scanned=15 true=0 attempted=0 carried=0 quarantined=0 rotate=no fallback=none$/)
  })

  test("equal created_at: 40 rows sharing one timestamp are all examined within ceil(40/15) = 3 cycles, none twice first", async () => {
    const k = await loadShippedExecutor()
    const same = "2026-08-01T00:00:00.123456+00:00"
    const rows = Array.from({ length: 40 }, (_, i) => makeRow(200 + i, { createdAt: same }))
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "Price above ceiling"])
    const { perCycle } = await runCycles(k, db, chain, 3)
    const firstForty = perCycle.flat().slice(0, 40)
    assert.equal(new Set(firstForty).size, 40)
    assert.deepEqual(db.unexpected, [])
  })

  test("restart mid-rotation (scan scaled to 15): a fresh process begins at a random page (S-8) and still covers the table within ceil(M/15) cycles", async () => {
    const rows = rowsOf(50)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    const index = new Map(rows.map((r, i) => [r.id, i]))
    const random = mulberry32(50)
    const before = await scaled()
    const first = await runCycles(before, db, chain, 2, { random })
    assert.equal(index.get(first.perCycle[1][0]), (index.get(first.perCycle[0].at(-1)) + 1) % 50, "the second page continues after the first")
    const after = await scaled() // new module instance = a restarted process (state in memory only)
    const { perCycle } = await runCycles(after, db, chain, Math.ceil(50 / WINDOW), { random })
    assert.notEqual(perCycle[0][0], rows[0].id, "ROUND 2: a restart with more rows than one scan starts at a random page (this seed's is not the oldest)")
    assert.equal(new Set(perCycle.flat()).size, 50)
  })

  test("the idle probe's fetchActiveOrders() never moves the cursor (only a full cycle does)", async () => {
    const k = await scaled()
    const rows = rowsOf(40)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    const first = await runCycles(k, db, chain, 1, { random: mulberry32(40) })
    const probes = []
    for (let i = 0; i < 3; i++) probes.push((await withFakes(db, () => k.fetchActiveOrders())).result.map((r) => r.id))
    const after = (rows.findIndex((r) => r.id === first.perCycle[0].at(-1)) + 1) % 40
    assert.deepEqual(probes[0], Array.from({ length: WINDOW }, (_, i) => rows[(after + i) % 40].id), "ROUND 2: the page after the first (random) page")
    assert.deepEqual(probes[1], probes[0])
    assert.deepEqual(probes[2], probes[0])
    const { perCycle } = await runCycles(k, db, chain, 1)
    assert.deepEqual(perCycle[0], probes[0], "the next full cycle examines exactly the window the probes saw")
  })

  test("never a row of another chain: every orders read is chain-scoped, and another chain's rows are never examined", async () => {
    const k = await loadShippedExecutor()
    const mine = rowsOf(20)
    const theirs = rowsOf(20, 500, { chainId: OTHER_CHAIN_ID })
    const db = createFakePostgrest([...theirs, ...mine])
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    const { perCycle } = await runCycles(k, db, chain, 6)
    const theirIds = new Set(theirs.map((r) => r.id))
    assert.equal(perCycle.flat().some((id) => theirIds.has(id)), false)
    const reads = db.requests.filter((r) => r.path === "/rest/v1/orders" && (r.method === "GET" || r.method === "HEAD"))
    assert.ok(reads.length > 0)
    for (const r of reads) assert.match(r.search, /[?&]chain_id=eq\.8453(&|$)/, r.search)
  })
})

describe("[SEC-4] shipped cycle — one window line per cycle, counts only", () => {
  test("exactly one `Active scan:` line per cycle; no address, no signature, no id; fetch's old per-query lines are gone", async () => {
    const k = await loadShippedExecutor()
    const rows = [...rowsOf(10), ...rowsOf(10, 20, { type: "dca" })]
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, (row) => (row.order_type === "dca" ? [false, "DCA interval not reached"] : [false, "Insufficient balance"]))
    const { windowLines, lines } = await runCycles(k, db, chain, 5)
    assert.deepEqual(windowLines.map((w) => w.length), [1, 1, 1, 1, 1])
    for (const [w] of windowLines) {
      // ROUND 2: the whole chain (20 rows) is scanned and pre-screened every cycle; none answered true.
      assert.match(w, /Active scan: active=20 scanned=20 true=0 attempted=0 carried=0 quarantined=0 rotate=no fallback=none$/)
      assert.doesNotMatch(w, /0x|[0-9a-f]{8}-[0-9a-f]{4}-/i, "no address, signature or id")
    }
    assert.equal(lines.some((l) => /Querying:|Supabase returned|First order:/.test(l)), false)
  })
})

describe("[SEC-4] shipped cycle — the scan query rejected by Supabase (owner answer: fall back to the oldest 15)", () => {
  test("a 400 on the scan query ⇒ today's exact query for that cycle, flagged on the scan line, detail logged once", async () => {
    const k = await loadShippedExecutor()
    const rows = rowsOf(20)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    await runCycles(k, db, chain, 1)
    // ROUND 2: with 20 rows the scan reads from the oldest (no or=(…)): the scan read is the keyset-ordered one.
    db.failNextMatching(/order=created_at\.asc%2Cid\.asc/, 400, '{"code":"PGRST100","message":"failed to parse logic tree"}', "GET")
    const second = await runCycles(k, db, chain, 1)
    assert.deepEqual(second.perCycle[0], rows.slice(0, 15).map((r) => r.id), "the 15 oldest, as before this change")
    const legacy = db.requests.filter((r) => r.search === "?status=eq.active&chain_id=eq.8453&select=*&order=created_at.asc&limit=15")
    assert.equal(legacy.length, 1, "today's query, byte for byte")
    assert.equal(legacy[0].prefer, "", "S-9: and without the scan's Prefer: count=exact")
    assert.match(second.windowLines[0][0], /fallback=scan-400$/)
    assert.equal(second.lines.filter((l) => l.includes("Active scan query FAILED")).length, 1)
    db.failNextMatching(/order=created_at\.asc%2Cid\.asc/, 400, "again", "GET")
    const third = await runCycles(k, db, chain, 1)
    assert.equal(third.lines.filter((l) => l.includes("Active scan query FAILED")).length, 0, "logged once per process")
    assert.match(third.windowLines[0][0], /fallback=scan-400/)
  })

  test("both the scan query and today's query fail ⇒ today's handling: log, no rows, the cursor is kept (scan scaled to 15)", async () => {
    const k = await scaled()
    const rows = rowsOf(20)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    const random = mulberry32(20)
    const first = await runCycles(k, db, chain, 1, { random })
    const realFetch = db.fetch
    let failures = 0
    db.fetch = async (input, init) => (String(input).includes("/rest/v1/orders?") && (init?.method ?? "GET") === "GET" && failures++ < 2 ? new Response("down", { status: 503 }) : realFetch(input, init))
    const down = await runCycles(k, db, chain, 1, { random })
    assert.deepEqual(down.returned, [0])
    assert.ok(down.lines.some((l) => l.includes("Supabase fetch error: 503")))
    db.fetch = realFetch
    const next = await runCycles(k, db, chain, 1, { random })
    const after = (rows.findIndex((r) => r.id === first.perCycle[0].at(-1)) + 1) % 20
    assert.equal(next.perCycle[0][0], rows[after].id, "the cursor survived the failed cycle")
  })
})

describe("[SEC-4] executor.js wiring (source anchors)", () => {
  test("the paused branch neither screens nor moves the scan (it examined nothing)", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(new URL("./executor.js", import.meta.url), "utf8")
    const a = src.indexOf("const pausedState = rpcAuthMonitor ? rpcAuthMonitor.state().paused : null")
    const b = src.indexOf("return orders.length", a)
    const paused = src.slice(a, b)
    assert.ok(a > 0 && b > a)
    assert.equal(paused.includes("advanceActiveScan("), false)
    assert.equal(paused.includes("prescreenRows("), false)
    assert.ok(paused.includes("activeScanLogLine("), "the paused cycle still prints its scan line")
  })
  test("ROUND 2: MAX_BATCH = 5 unchanged; the scan is 1000 rows, chunks of 50, 5 s limits, a one-by-one budget of MAX_BATCH * 3", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(new URL("./executor.js", import.meta.url), "utf8")
    assert.match(src, /^const MAX_BATCH = 5 /m)
    assert.match(src, /^const SCAN_CAP = 1000$/m)
    assert.match(src, /^const PRESCREEN_CHUNK = 50$/m)
    assert.match(src, /^const PRESCREEN_CHUNK_TIMEOUT_MS = 5_000$/m)
    assert.match(src, /^const SUPABASE_READ_TIMEOUT_MS = 5_000$/m)
    assert.match(src, /^const ONE_BY_ONE = MAX_BATCH \* 3$/m)
  })
})

function isoAtFor(n) {
  return new Date(Date.parse("2026-08-01T00:00:00.000Z") + n * 1000).toISOString().slice(0, 19) + ".000000+00:00"
}
