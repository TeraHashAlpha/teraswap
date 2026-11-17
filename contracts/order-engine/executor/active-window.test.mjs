// [SEC-4 / fix/keeper-active-orders-window] Pure tests of active-window.js: the query parameters, the
// window selection (wrap, dedupe, chain filter, ties), the cursor advance, the prune keep-set and the
// balance/allowance slow-down — plus a seeded property simulation that drives the helper the way
// executor.js fetchActiveOrders / executeCycle do (tail after the cursor; head from the oldest when the
// tail is short; the loop stops after MAX_BATCH executions or on a gas SKIP) over a random table with
// rows added and removed between cycles.
//
// The simulated database orders and filters with the fixture's own timestamp comparison
// (executor-cycle.fixture.mjs compareTimestamps), not the helper's, so the two cannot share a bug.
//
// Run: node --test contracts/order-engine/executor/active-window.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import {
  ACTIVE_WINDOW_SLOW_AFTER,
  ACTIVE_WINDOW_SLOW_MS,
  ACTIVE_WINDOW_SLOW_REASONS,
  activeWindowParams,
  contentRangeTotal,
  cursorOf,
  selectActiveWindow,
  advanceActiveWindow,
  activeWindowKeepIds,
  isSlowReason,
  nextSlowEntry,
  isSlowed,
  noteCanExecuteAnswer,
  pruneSlowRows,
  activeWindowLogLine,
} from "./active-window.js"
import { compareTimestamps } from "./executor-cycle.fixture.mjs"

const W = 15 // MAX_BATCH * 3
const MAX_BATCH = 5
const CHAIN = 8453
const OTHER = 42161
const CYCLE_MS = 30_000 // POLL_INTERVAL_MS

// ── tiny seeded PRNG + row factory ──────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hex = (rand, n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("")
const uuid = (rand) => `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-8${hex(rand, 3)}-${hex(rand, 12)}`
const T0 = Date.parse("2026-11-01T00:00:00.000Z")
const ts = (ms, micros = 0) => `${new Date(ms).toISOString().slice(0, 19)}.${String(micros).padStart(6, "0")}+00:00`
const row = (id, createdAt, chainId = CHAIN) => ({ id, created_at: createdAt, chain_id: chainId, status: "active" })
const idN = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

// A database answering the keeper's two queries. Order and keyset use the FIXTURE's timestamp compare.
function keyCmp(a, b) {
  const c = compareTimestamps(a.created_at, b.created_at)
  if (c !== 0) return c
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
function createDb(rows = []) {
  const table = rows.slice()
  return {
    table,
    active: (chainId = CHAIN) => table.filter((r) => r.status === "active" && r.chain_id === chainId),
    query(cursor, limit, chainId = CHAIN) {
      const after = cursor ? (r) => keyCmp(r, { created_at: cursor.createdAt, id: cursor.id }) > 0 : () => true
      return this.active(chainId).filter(after).sort(keyCmp).slice(0, limit)
    },
  }
}

// One keeper "process": the same orchestration executor.js runs around the helper.
function createKeeper() {
  return { cursor: null, rotation: new Set(), slow: new Map() }
}
function fetchWindow(db, k, nowMs) {
  const tail = db.query(k.cursor, W)
  const head = k.cursor !== null && tail.length < W ? db.query(null, W - tail.length) : null
  return selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: k.cursor, tail, head, slow: k.slow, nowMs })
}

// ── query parameters ─────────────────────────────────────────────────────────────────────────────

describe("activeWindowParams — the PostgREST page after the cursor", () => {
  test("no cursor ⇒ from the oldest, keyset order, the window's limit (no keyset filter)", () => {
    assert.equal(activeWindowParams({ cursor: null, limit: 15 }), "select=*&order=created_at.asc%2Cid.asc&limit=15")
  })
  test("cursor ⇒ or=(created_at.gt.\"ts\",and(created_at.eq.\"ts\",id.gt.\"id\")), quoted and form-encoded (+ ⇒ %2B)", () => {
    const cursor = { createdAt: "2026-11-17T10:00:00.123456+00:00", id: "0b6f2c4e-1d2a-4f7b-9c3d-5e6f7a8b9c0d" }
    const p = activeWindowParams({ cursor, limit: 7 })
    assert.equal(
      p,
      "or=%28created_at.gt.%222026-11-17T10%3A00%3A00.123456%2B00%3A00%22%2Cand%28created_at.eq.%222026-11-17T10%3A00%3A00.123456%2B00%3A00%22%2Cid.gt.%220b6f2c4e-1d2a-4f7b-9c3d-5e6f7a8b9c0d%22%29%29&select=*&order=created_at.asc%2Cid.asc&limit=7",
    )
    assert.equal(p.includes("+"), false, "a raw '+' would reach PostgREST as a space")
    const decoded = new URLSearchParams(p)
    assert.equal(decoded.get("or"), `(created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.gt."${cursor.id}"))`)
    assert.equal(decoded.get("order"), "created_at.asc,id.asc")
  })
  test("limit is a positive integer", () => {
    assert.match(activeWindowParams({ limit: 0 }), /limit=1$/)
    assert.match(activeWindowParams({ limit: 3.9 }), /limit=3$/)
  })
})

describe("cursorOf — only a real (timestamp, uuid) pair can become the cursor (it goes into a URL)", () => {
  test("PostgREST timestamptz shapes and a uuid", () => {
    for (const createdAt of ["2026-11-17T10:00:00.123456+00:00", "2026-11-17T10:00:00+00:00", "2026-11-17T10:00:00Z", "2026-11-17 10:00:00.5+00"]) {
      assert.deepEqual(cursorOf({ created_at: createdAt, id: idN(1) }), { createdAt, id: idN(1) })
    }
  })
  test("anything else is refused (no injection into the or=() tree)", () => {
    for (const bad of [
      { created_at: '2026-11-17T10:00:00Z",id.gt.0)', id: idN(1) },
      { created_at: "2026-11-17T10:00:00Z", id: "1) or (1=1" },
      { created_at: null, id: idN(1) },
      { created_at: "2026-11-17T10:00:00Z" },
      { created_at: 1731837600000, id: idN(1) },
      null,
    ]) {
      assert.equal(cursorOf(bad), null, JSON.stringify(bad))
    }
  })
})

test("contentRangeTotal reads PostgREST's Content-Range total", () => {
  assert.equal(contentRangeTotal("0-14/37"), 37)
  assert.equal(contentRangeTotal("*/0"), 0)
  assert.equal(contentRangeTotal("0-0/*"), null)
  assert.equal(contentRangeTotal(null), null)
})

// ── selection edges ──────────────────────────────────────────────────────────────────────────────

describe("selectActiveWindow — edges named by the goal", () => {
  const sel = (db, k, nowMs = T0) => fetchWindow(db, k, nowMs)

  test("empty table ⇒ empty window, scan reached the end and covers everything, cursor back to the oldest", () => {
    const k = createKeeper()
    k.cursor = cursorOf(row(idN(9), ts(T0)))
    const scan = sel(createDb([]), k)
    assert.deepEqual(scan.rows, [])
    assert.equal(scan.endReached, true)
    assert.equal(scan.coversAll, true, "an empty head is a short head")
    const moved = advanceActiveWindow(scan, 0, new Set(["x"]))
    assert.equal(moved.cursor, null)
    assert.equal(moved.wrapped, true)
    assert.deepEqual([...moved.rotation], [])
  })

  test("one row ⇒ it is in every window", () => {
    const db = createDb([row(idN(1), ts(T0))])
    const k = createKeeper()
    for (let c = 0; c < 4; c++) {
      const scan = sel(db, k)
      assert.deepEqual(scan.rows.map((r) => r.id), [idN(1)])
      assert.equal(scan.coversAll, true)
      k.cursor = advanceActiveWindow(scan, scan.rows.length, k.rotation).cursor
    }
  })

  test("exactly 15 rows ⇒ every cycle's window is all 15, oldest first, and covers the table", () => {
    const rows = Array.from({ length: 15 }, (_, i) => row(idN(i + 1), ts(T0 + i * 1000)))
    const db = createDb(rows)
    const k = createKeeper()
    for (let c = 0; c < 5; c++) {
      const scan = sel(db, k)
      assert.deepEqual(scan.rows.map((r) => r.id), rows.map((r) => r.id), `cycle ${c + 1}`)
      assert.ok(c === 0 || scan.coversAll, `cycle ${c + 1} covers all`)
      const moved = advanceActiveWindow(scan, scan.rows.length, k.rotation)
      k.cursor = moved.cursor
      k.rotation = moved.rotation
    }
    // The first cycle (cursor null) reads a FULL page of 15: it cannot know the table ends there.
    const first = sel(db, createKeeper())
    assert.equal(first.endReached, false)
  })

  test("16 rows ⇒ the 16th is in the second window, then the windows keep rotating", () => {
    const rows = Array.from({ length: 16 }, (_, i) => row(idN(i + 1), ts(T0 + i * 1000)))
    const db = createDb(rows)
    const k = createKeeper()
    const windows = []
    for (let c = 0; c < 4; c++) {
      const scan = sel(db, k)
      windows.push(scan.rows.map((r) => Number.parseInt(r.id.slice(-12), 16)))
      k.cursor = advanceActiveWindow(scan, scan.rows.length, k.rotation).cursor
    }
    assert.deepEqual(windows[0], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    assert.deepEqual(windows[1], [16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    assert.deepEqual(windows[2], [15, 16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  test("equal created_at: the id breaks the tie, so 40 rows sharing one timestamp still rotate (no row twice before all once)", () => {
    const same = ts(T0, 123456)
    const rows = Array.from({ length: 40 }, (_, i) => row(idN(1000 + i), same))
    const db = createDb(rows)
    const k = createKeeper()
    const seen = []
    for (let c = 0; c < 3; c++) {
      const scan = sel(db, k)
      seen.push(...scan.rows.map((r) => r.id))
      k.cursor = advanceActiveWindow(scan, scan.rows.length, k.rotation).cursor
    }
    assert.equal(new Set(seen.slice(0, 40)).size, 40, "the first 40 examinations are the 40 distinct rows")
  })

  test("a row of another chain in a page is never handed to the loop (defence in depth behind chain_id=eq.)", () => {
    const tail = [row(idN(1), ts(T0)), row(idN(2), ts(T0 + 1), OTHER), row(idN(3), ts(T0 + 2))]
    const scan = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: null, tail, head: null, nowMs: T0 })
    assert.deepEqual(scan.rows.map((r) => r.id), [idN(1), idN(3)])
  })

  test("head rows already in the tail are dropped, and the window never exceeds its size", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(idN(i + 1), ts(T0 + i)))
    const cursor = cursorOf(rows[3])
    const tail = rows.slice(4)
    const head = rows.slice(0, 9) // W - |tail| = 9: rows 1..9, of which 5..9 are in the tail
    const scan = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor, tail, head, nowMs: T0 })
    assert.deepEqual(scan.rows.map((r) => r.id), [...rows.slice(4), ...rows.slice(0, 4)].map((r) => r.id))
    assert.equal(scan.coversAll, true)
    const big = selectActiveWindow({ chainId: CHAIN, windowSize: 3, cursor: null, tail: rows, nowMs: T0 })
    assert.equal(big.rows.length, 3)
  })
})

describe("advanceActiveWindow — the cursor moves past the rows the loop reached", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(idN(i + 1), ts(T0 + i * 1000)))
  const db = createDb(rows)

  test("the loop reached every row ⇒ the cursor is the window's last row", () => {
    const scan = fetchWindow(db, createKeeper(), T0)
    const moved = advanceActiveWindow(scan, scan.rows.length, new Set())
    assert.deepEqual(moved.cursor, cursorOf(rows[14]))
    assert.equal(moved.wrapped, false)
  })
  test("MAX_BATCH stopped the loop after 7 rows ⇒ the cursor is the 7th; rows 8.. lead the next window", () => {
    const k = createKeeper()
    const scan = fetchWindow(db, k, T0)
    k.cursor = advanceActiveWindow(scan, 7, new Set()).cursor
    assert.deepEqual(k.cursor, cursorOf(rows[6]))
    assert.equal(fetchWindow(db, k, T0).rows[0].id, rows[7].id)
  })
  test("wrap = the scan got past the newest row (a short tail reached in full)", () => {
    const k = createKeeper()
    k.cursor = cursorOf(rows[9]) // tail = rows 11..20 (10 rows), head = rows 1..5
    const scan = fetchWindow(db, k, T0)
    assert.equal(scan.tailCount, 10)
    assert.equal(advanceActiveWindow(scan, 9, new Set()).wrapped, false, "stopped inside the tail")
    assert.equal(advanceActiveWindow(scan, 10, new Set()).wrapped, true, "reached the newest row")
    const all = advanceActiveWindow(scan, 15, new Set(["old"]))
    assert.equal(all.wrapped, true)
    assert.deepEqual(all.cursor, cursorOf(rows[4]))
    assert.deepEqual(
      [...all.rotation].sort(),
      scan.rows.slice(scan.tailCount).map((r) => r.id).sort(),
      "the cursor moved into the head part: the rotation restarts as that head part (it covers [oldest, cursor])",
    )
  })
  test("a cursor that stops ON the newest row keeps the rotation (the next window starts after it, not at the oldest)", () => {
    const k = createKeeper()
    k.cursor = cursorOf(rows[9])
    const scan = fetchWindow(db, k, T0)
    const atEnd = advanceActiveWindow(scan, scan.tailCount, new Set(["earlier"]))
    assert.deepEqual(atEnd.cursor, cursorOf(rows[19]))
    assert.equal(atEnd.wrapped, true)
    assert.ok(atEnd.rotation.has("earlier"), "accumulates: [oldest, cursor] is still the earlier windows plus this one")
    for (const r of scan.rows) assert.ok(atEnd.rotation.has(r.id))
  })
  test("no scan (the fetch failed) ⇒ cursor unchanged by the caller (null returned, nothing wrapped)", () => {
    assert.deepEqual(advanceActiveWindow(null, 0, new Set(["a"])), { cursor: null, wrapped: false, rotation: new Set(["a"]) })
  })
})

describe("activeWindowKeepIds — absence from a window is not absence from the table", () => {
  test("partial window ⇒ null (prune nothing)", () => {
    const db = createDb(Array.from({ length: 30 }, (_, i) => row(idN(i + 1), ts(T0 + i))))
    const scan = fetchWindow(db, createKeeper(), T0)
    assert.equal(activeWindowKeepIds(scan, scan.rows.map((r) => r.id), new Set()), null)
  })
  test("the window holds the whole table ⇒ exactly its ids (today's rule)", () => {
    const db = createDb(Array.from({ length: 6 }, (_, i) => row(idN(i + 1), ts(T0 + i))))
    const scan = fetchWindow(db, createKeeper(), T0)
    const keep = activeWindowKeepIds(scan, scan.rows.map((r) => r.id), new Set(["gone"]))
    assert.deepEqual([...keep].sort(), scan.rows.map((r) => r.id).sort())
  })
  test("the window reached the newest row of a bigger table ⇒ its ids plus every id since the last wrap", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(idN(i + 1), ts(T0 + i)))
    const k = createKeeper()
    k.cursor = cursorOf(rows[19])
    const scan = fetchWindow(createDb(rows), k, T0)
    assert.equal(scan.coversAll, false)
    const keep = activeWindowKeepIds(scan, scan.rows.map((r) => r.id), new Set([idN(10)]))
    assert.ok(keep.has(idN(10)) && keep.has(idN(25)) && keep.has(idN(1)))
  })
  test("pruneSlowRows drops exactly the ids outside the keep-set; null keeps everything", () => {
    const m = new Map([["a", 1], ["b", 2], ["c", 3]])
    assert.equal(pruneSlowRows(m, null), 0)
    assert.equal(pruneSlowRows(m, new Set(["b"])), 2)
    assert.deepEqual([...m.keys()], ["b"])
  })
})

// ── slow-down ────────────────────────────────────────────────────────────────────────────────────

describe("slow-down — only balance/allowance, after 3 in a row, at most once per 10 minutes", () => {
  test("the slow reasons are exactly the contracts' two strings", () => {
    assert.deepEqual([...ACTIVE_WINDOW_SLOW_REASONS], ["Insufficient balance", "Insufficient allowance"])
    assert.equal(ACTIVE_WINDOW_SLOW_AFTER, 3)
    assert.equal(ACTIVE_WINDOW_SLOW_MS, 600_000)
    for (const r of [
      "DCA interval not reached",
      "Price below floor",
      "Price above ceiling",
      "Stale price feed",
      "Invalid price",
      "Incomplete round",
      "Order cancelled",
      "Order expired",
      "Nonce used",
      "Router not whitelisted",
      "Paused",
      "",
      undefined,
    ]) {
      assert.equal(isSlowReason(r), false, String(r))
    }
  })
  test("3 consecutive balance/allowance answers (mixed) ⇒ slowed for 10 min after the last; then examinable", () => {
    let e = null
    e = nextSlowEntry(e, { canExecute: false, reason: "Insufficient balance", nowMs: T0 })
    e = nextSlowEntry(e, { canExecute: false, reason: "Insufficient allowance", nowMs: T0 + CYCLE_MS })
    assert.equal(isSlowed(e, T0 + CYCLE_MS), false, "2 answers are not enough")
    e = nextSlowEntry(e, { canExecute: false, reason: "Insufficient balance", nowMs: T0 + 2 * CYCLE_MS })
    assert.equal(isSlowed(e, T0 + 2 * CYCLE_MS), true)
    assert.equal(isSlowed(e, T0 + 2 * CYCLE_MS + ACTIVE_WINDOW_SLOW_MS - 1), true)
    assert.equal(isSlowed(e, T0 + 2 * CYCLE_MS + ACTIVE_WINDOW_SLOW_MS), false)
  })
  test("any other answer clears the streak (true, interval not reached, a price reason)", () => {
    for (const other of [{ canExecute: true, reason: "" }, { canExecute: false, reason: "DCA interval not reached" }, { canExecute: false, reason: "Price below floor" }]) {
      const m = new Map()
      for (let i = 0; i < 3; i++) noteCanExecuteAnswer(m, "x", { canExecute: false, reason: "Insufficient balance", nowMs: T0 + i })
      assert.equal(isSlowed(m.get("x"), T0 + 5), true)
      noteCanExecuteAnswer(m, "x", { ...other, nowMs: T0 + 10 })
      assert.equal(m.has("x"), false, JSON.stringify(other))
    }
  })
  test("a slowed row stays in the window (it holds no slot of the rotation) but is not examined", () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(idN(i + 1), ts(T0 + i)))
    const slow = new Map([[idN(2), { streak: 3, lastAt: T0 }]])
    const scan = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: null, tail: rows, slow, nowMs: T0 + 1000 })
    assert.equal(scan.rows.length, 3)
    assert.deepEqual([...scan.slowedIds], [idN(2)])
    assert.deepEqual([...scan.examineIds], [idN(1), idN(3)])
  })
})

test("the log line carries counts only — no id, address or signature", () => {
  const line = activeWindowLogLine({ active: 37, window: 15, examined: 12, slowed: 3, wrapped: false })
  assert.equal(line, "Active window: active=37 window=15 examined=12 slowed=3 wrap=no")
  assert.equal(activeWindowLogLine({ active: null, window: 0, examined: 0, slowed: 0, wrapped: true, fallback: 400 }), "Active window: active=? window=0 examined=0 slowed=0 wrap=yes keyset=rejected(400) fallback=oldest")
  assert.doesNotMatch(line, /0x|[0-9a-f]{8}-/)
})

// ── seeded property simulation ───────────────────────────────────────────────────────────────────

const PERSONAS = ["executable", "unfunded", "no-allowance", "interval", "price", "mixed", "cancelled"]
function answerFor(persona, rand) {
  switch (persona) {
    case "executable": return rand() < 0.7 ? [true, ""] : [false, "DCA interval not reached"]
    case "unfunded": return rand() < 0.9 ? [false, "Insufficient balance"] : [true, ""]
    case "no-allowance": return rand() < 0.9 ? [false, "Insufficient allowance"] : [false, "Price below floor"]
    case "interval": return [false, "DCA interval not reached"]
    case "price": return [false, rand() < 0.5 ? "Price below floor" : "Stale price feed"]
    case "cancelled": return [false, "Order cancelled"]
    default: {
      const r = rand()
      if (r < 0.3) return [false, "Insufficient balance"]
      if (r < 0.5) return [false, "Insufficient allowance"]
      if (r < 0.7) return [false, "DCA interval not reached"]
      return [true, ""]
    }
  }
}

/**
 * One seeded run. Returns the per-cycle trace and the facts the assertions need.
 * Churn between cycles: up to `maxAdd` rows added (mostly newest, some tied, some back-dated) and up to
 * `maxRemove` removed; a filled non-DCA row also leaves. A restart (fresh in-memory state) can happen.
 */
function simulate(seed, { cycles, initial, maxAdd = 3, maxRemove = 3, restartP = 0, otherChainNoise = false }) {
  const rand = mulberry32(seed)
  const db = createDb()
  const persona = new Map()
  const dca = new Map()
  let nextMs = T0
  let created = 0
  const add = (when) => {
    const id = uuid(rand)
    created++
    const r = rand()
    let createdAt
    if (when === "initial" || r < 0.7) createdAt = ts((nextMs += 1 + Math.floor(rand() * 5000)), Math.floor(rand() * 1e6))
    else if (r < 0.85 && db.table.length) createdAt = db.table[Math.floor(rand() * db.table.length)].created_at // a tie
    else createdAt = ts(T0 - Math.floor(rand() * 86_400_000), Math.floor(rand() * 1e6)) // back-dated
    db.table.push(row(id, createdAt))
    persona.set(id, PERSONAS[Math.floor(rand() * PERSONAS.length)])
    dca.set(id, rand() < 0.5)
  }
  for (let i = 0; i < initial; i++) add("initial")
  if (otherChainNoise) for (let i = 0; i < 20; i++) db.table.push(row(uuid(rand), ts(T0 + i), OTHER))

  let k = createKeeper()
  const tracked = new Map() // stands in for orderInfraMisses: an entry for every row the loop reached
  const trace = []
  const answers = new Map() // id -> [{ cycle, nowMs, ok, reason }]
  const restarts = []
  const droppedWhileActive = []
  const removedAt = new Map()
  const droppedAt = new Map()
  for (let c = 0; c < cycles; c++) {
    const nowMs = T0 + c * CYCLE_MS
    if (c > 0 && rand() < restartP) {
      k = createKeeper()
      tracked.clear()
      restarts.push(c)
    }
    const present = new Set(db.active().map((r) => r.id))
    let scan = fetchWindow(db, k, nowMs)
    if (otherChainNoise) {
      // A broken filter would hand back rows of another chain: mix some into the page and re-select.
      const tail = db.query(k.cursor, W)
      const noisy = tail.slice()
      noisy.splice(Math.floor(rand() * (noisy.length + 1)), 0, row(uuid(rand), ts(nowMs), OTHER))
      const head = k.cursor !== null && tail.length < W ? db.query(null, W - tail.length) : null
      const alt = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: k.cursor, tail: noisy, head, slow: k.slow, nowMs })
      for (const r of alt.rows) assert.equal(r.chain_id, CHAIN, `seed ${seed} cycle ${c}: another chain's row reached the loop`)
    }
    // the prune step, exactly as executeCycle runs it (before the loop)
    const keep = activeWindowKeepIds(scan, scan.rows.map((r) => r.id), k.rotation)
    for (const [map, label] of [[tracked, "tracked"], [k.slow, "slow"]]) {
      const before = new Set(map.keys())
      pruneSlowRows(map, keep)
      for (const id of before) {
        if (map.has(id)) continue
        if (present.has(id)) droppedWhileActive.push({ seed, c, id, label })
        if (label === "tracked" && !droppedAt.has(id)) droppedAt.set(id, c)
      }
    }
    // the loop
    let reached = 0
    let executed = 0
    let early = false
    const reachedIds = []
    const examined = []
    const slowSkipped = []
    const filled = []
    for (const r of scan.rows) {
      if (executed >= MAX_BATCH) {
        early = true
        break
      }
      reached++
      reachedIds.push(r.id)
      tracked.set(r.id, c)
      if (scan.slowedIds.has(r.id)) {
        slowSkipped.push(r.id)
        continue
      }
      examined.push(r.id)
      const [ok, reason] = answerFor(persona.get(r.id), rand)
      noteCanExecuteAnswer(k.slow, r.id, { canExecute: ok, reason, nowMs })
      if (!answers.has(r.id)) answers.set(r.id, [])
      answers.get(r.id).push({ cycle: c, nowMs, ok, reason })
      if (ok) {
        if (rand() < 0.5) {
          executed++
          if (!dca.get(r.id)) filled.push(r.id)
        } else if (rand() < 0.03) {
          early = true // gas SKIP: "skip remaining orders too"
          break
        }
      }
    }
    if (reached === scan.rows.length) early = false
    const moved = advanceActiveWindow(scan, reached, k.rotation)
    k.cursor = moved.cursor
    k.rotation = moved.rotation
    trace.push({ c, present, reached: new Set(reachedIds), examined, slowSkipped, early, windowSize: scan.rows.length })
    // churn
    for (const id of filled) {
      db.table.splice(db.table.findIndex((x) => x.id === id), 1)
      removedAt.set(id, c + 1)
    }
    const removeN = Math.floor(rand() * (maxRemove + 1))
    for (let i = 0; i < removeN && db.table.length; i++) {
      const j = Math.floor(rand() * db.table.length)
      if (db.table[j].chain_id !== CHAIN) continue
      removedAt.set(db.table[j].id, c + 1)
      db.table.splice(j, 1)
    }
    const addN = Math.floor(rand() * (maxAdd + 1))
    for (let i = 0; i < addN; i++) add("churn")
  }
  return { trace, answers, restarts, droppedWhileActive, removedAt, droppedAt, created }
}

/** Smallest K with K ≥ ceil(M/15) + 1 + E, where M = distinct rows present and E = early stops in [s, s+K−1]. */
/** The definition, set by set (slow): kept as the reference the fast index is checked against. */
function boundFromSlow(trace, s) {
  const seen = new Set()
  let early = 0
  for (let K = 1; s + K - 1 < trace.length; K++) {
    const t = trace[s + K - 1]
    for (const id of t.present) seen.add(id)
    if (t.early) early++
    if (K >= Math.ceil(seen.size / W) + 1 + early) return { K, M: seen.size, E: early }
  }
  return null
}

/**
 * Per-trace index so the bound check costs O(rows × cycles), not O(rows × cycles × K): a row is present
 * over ONE interval [born, end) (the simulation never brings a removed row back — asserted here), so the
 * distinct rows of cycles s..e are |present_s| plus the rows born in s+1..e.
 */
function indexTrace(trace) {
  const born = new Map()
  const end = new Map()
  const reachedAt = new Map()
  const newAt = new Array(trace.length).fill(0)
  const earlyPrefix = [0]
  for (const t of trace) {
    for (const id of t.present) {
      if (!born.has(id)) {
        born.set(id, t.c)
        if (t.c > 0) newAt[t.c]++
      } else assert.ok(!end.has(id), `row ${id.slice(0, 8)} came back after leaving: the index assumes it cannot`)
    }
    if (t.c > 0) for (const id of trace[t.c - 1].present) if (!t.present.has(id) && !end.has(id)) end.set(id, t.c)
    for (const id of t.reached) {
      if (!reachedAt.has(id)) reachedAt.set(id, [])
      reachedAt.get(id).push(t.c)
    }
    earlyPrefix.push(earlyPrefix[earlyPrefix.length - 1] + (t.early ? 1 : 0))
  }
  return { born, end, reachedAt, newAt, earlyPrefix }
}

function boundFromIndexed(trace, ix, s) {
  let M = trace[s].present.size
  for (let K = 1; s + K - 1 < trace.length; K++) {
    if (K > 1) M += ix.newAt[s + K - 1]
    const E = ix.earlyPrefix[s + K] - ix.earlyPrefix[s]
    if (K >= Math.ceil(M / W) + 1 + E) return { K, M, E }
  }
  return null
}

/** First element of a sorted array that is ≥ x, or undefined. */
function firstAtOrAfter(sorted, x) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < x) lo = mid + 1
    else hi = mid
  }
  return sorted[lo]
}

function checkBound(seed, run) {
  const { trace, restarts } = run
  const ix = indexTrace(trace)
  run.boundFrom = (s) => boundFromIndexed(trace, ix, s)
  let checked = 0
  for (let s = 0; s < trace.length; s++) {
    const b = boundFromIndexed(trace, ix, s)
    if (s % 17 === 0) assert.deepEqual(b, boundFromSlow(trace, s), `seed ${seed} s=${s}: the indexed bound differs from the definition`)
    if (!b) break
    if (restarts.some((r) => r > s && r <= s + b.K - 1)) continue // a restart begins at the oldest: measured from it
    for (const id of trace[s].present) {
      const presentThroughout = (ix.end.get(id) ?? Infinity) >= s + b.K
      if (!presentThroughout) continue
      checked++
      const r = firstAtOrAfter(ix.reachedAt.get(id) ?? [], s)
      assert.ok(r !== undefined && r < s + b.K, `seed ${seed}: row ${id.slice(0, 8)} present in cycles ${s}..${s + b.K - 1} (M=${b.M}, early stops=${b.E}) was never reached`)
    }
  }
  return checked
}

/** boundFrom for the checks below: the indexed one once checkBound has built it, else the definition. */
function boundFrom(trace, s, run = null) {
  return run?.boundFrom ? run.boundFrom(s) : boundFromSlow(trace, s)
}

function checkSlowDown(seed, run) {
  const { trace, answers, restarts } = run
  // The slow-down is in memory only: a restart (before cycle r) forgets every streak, so only answers
  // given since the last restart at or before a cycle can have slowed a row in that cycle.
  const sinceRestart = (c) => restarts.filter((r) => r <= c).reduce((a, b) => Math.max(a, b), 0)
  let slowedRows = 0
  for (const t of trace) {
    for (const id of t.slowSkipped) {
      const hist = (answers.get(id) || []).filter((a) => a.cycle < t.c && a.cycle >= sinceRestart(t.c))
      const last3 = hist.slice(-ACTIVE_WINDOW_SLOW_AFTER)
      assert.equal(last3.length, ACTIVE_WINDOW_SLOW_AFTER, `seed ${seed}: ${id.slice(0, 8)} slowed after ${last3.length} answers`)
      for (const a of last3) assert.ok(!a.ok && isSlowReason(a.reason), `seed ${seed}: ${id.slice(0, 8)} slowed though an answer was ${JSON.stringify(a.reason)}`)
      assert.ok(T0 + t.c * CYCLE_MS - last3[last3.length - 1].nowMs < ACTIVE_WINDOW_SLOW_MS, `seed ${seed}: ${id.slice(0, 8)} still slowed 10 min after its last answer`)
    }
  }
  // At most once per 10 minutes once slowed; and examined again within 10 minutes + one rotation.
  const slowCycles = ACTIVE_WINDOW_SLOW_MS / CYCLE_MS
  for (const [id, hist] of answers) {
    for (let i = ACTIVE_WINDOW_SLOW_AFTER; i < hist.length; i++) {
      const prev = hist.slice(i - ACTIVE_WINDOW_SLOW_AFTER, i)
      if (prev[0].cycle < sinceRestart(hist[i].cycle)) continue // a restart in between forgot the streak
      if (!prev.every((a) => !a.ok && isSlowReason(a.reason))) continue
      slowedRows++
      assert.ok(hist[i].nowMs - prev[prev.length - 1].nowMs >= ACTIVE_WINDOW_SLOW_MS, `seed ${seed}: slowed ${id.slice(0, 8)} examined twice within 10 min`)
    }
    const last = hist[hist.length - 1]
    const lastThree = hist.slice(-ACTIVE_WINDOW_SLOW_AFTER)
    if (lastThree.length === ACTIVE_WINDOW_SLOW_AFTER && lastThree.every((a) => !a.ok && isSlowReason(a.reason))) {
      const due = last.cycle + slowCycles
      if (due >= trace.length) continue
      const b = boundFrom(trace, due, run)
      if (!b) continue
      if (run.restarts.some((r) => r > last.cycle && r <= due + b.K - 1)) continue
      let present = true
      for (let t = last.cycle; t < due + b.K; t++) if (!trace[t].present.has(id)) present = false
      if (!present) continue
      assert.fail(`seed ${seed}: slowed ${id.slice(0, 8)} last answered at cycle ${last.cycle}, present through cycle ${due + b.K - 1} (10 min + one rotation) and never examined again`)
    }
  }
  return slowedRows
}

describe("property (seeded): rotation bound, window size, chain, slow-down, pruning", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => 0x5ec4 + i * 7919)
  const stats = { cycles: 0, checked: 0, slowed: 0, maxM: 0, earlyStops: 0, restarts: 0 }

  test("random tables (1–400 rows), churn, random canExecute answers, early stops, restarts: every row present for ceil(M/15)+1+E consecutive cycles is reached; slowed rows only for 3× balance/allowance, at most once per 10 min, again within 10 min + one rotation; never more than 15 rows a cycle", () => {
    for (const seed of SEEDS) {
      const rand = mulberry32(seed ^ 0xabc)
      const initial = 1 + Math.floor(rand() * 400)
      const run = simulate(seed, { cycles: 140, initial, maxAdd: 3, maxRemove: 3, restartP: 0.01 })
      for (const t of run.trace) {
        assert.ok(t.windowSize <= W, `seed ${seed} cycle ${t.c}: window of ${t.windowSize}`)
        assert.ok(t.examined.length <= W, `seed ${seed} cycle ${t.c}: examined ${t.examined.length}`)
        stats.maxM = Math.max(stats.maxM, t.present.size)
        if (t.early) stats.earlyStops++
      }
      stats.cycles += run.trace.length
      stats.checked += checkBound(seed, run)
      stats.slowed += checkSlowDown(seed, run)
      stats.restarts += run.restarts.length
      assert.deepEqual(run.droppedWhileActive, [], `seed ${seed}: an in-memory entry of an ACTIVE row was pruned`)
    }
    assert.ok(stats.checked > 50_000, `the bound was checked ${stats.checked} times`)
    assert.ok(stats.slowed > 100, `only ${stats.slowed} slowed examinations — the generator no longer exercises the slow-down`)
    assert.ok(stats.earlyStops > 50, `only ${stats.earlyStops} early stops`)
    assert.ok(stats.maxM >= 300, `largest table ${stats.maxM}`)
    assert.ok(stats.restarts > 5, `only ${stats.restarts} restarts`)
    // eslint-disable-next-line no-console
    console.log(`  property: ${SEEDS.length} seeds, ${stats.cycles} cycles, ${stats.checked} (row, start-cycle) bound checks, ${stats.slowed} slowed re-examinations, ${stats.earlyStops} early stops, ${stats.restarts} restarts, largest table ${stats.maxM}`)
  })

  test("a static table with no early stop meets the exact bound ceil(M/15) (no +1 needed)", () => {
    for (const M of [1, 2, 14, 15, 16, 29, 30, 31, 100, 399, 400]) {
      const db = createDb(Array.from({ length: M }, (_, i) => row(idN(i + 1), ts(T0 + i * 1000))))
      const k = createKeeper()
      for (let start = 0; start < 3 * Math.ceil(M / W); start++) {
        const reached = new Set()
        const K = Math.ceil(M / W)
        const save = { cursor: k.cursor }
        for (let c = 0; c < K; c++) {
          const scan = fetchWindow(db, k, T0)
          for (const r of scan.rows) reached.add(r.id)
          k.cursor = advanceActiveWindow(scan, scan.rows.length, k.rotation).cursor
        }
        assert.equal(reached.size, M, `M=${M}, starting at cursor ${JSON.stringify(save.cursor)}: ${reached.size} rows in ${K} cycles`)
        // step one cycle forward for the next starting point
        k.cursor = save.cursor
        const scan = fetchWindow(db, k, T0)
        k.cursor = advanceActiveWindow(scan, scan.rows.length, k.rotation).cursor
      }
    }
  })

  test("a row of another chain never reaches the loop, even when a page carries one", () => {
    for (const seed of SEEDS.slice(0, 10)) simulate(seed, { cycles: 40, initial: 60, otherChainNoise: true })
  })

  test("pruning: an entry is never dropped while its row is active, and a removed row's entry goes within two rotations", () => {
    let removedChecked = 0
    for (const seed of SEEDS.slice(0, 20)) {
      const run = simulate(seed, { cycles: 160, initial: 120, maxAdd: 2, maxRemove: 2, restartP: 0 })
      const ix = indexTrace(run.trace)
      run.boundFrom = (s) => boundFromIndexed(run.trace, ix, s)
      assert.deepEqual(run.droppedWhileActive, [])
      for (const [id, r] of run.removedAt) {
        if (r >= run.trace.length) continue
        const b1 = boundFrom(run.trace, r, run)
        if (!b1 || r + b1.K >= run.trace.length) continue
        const b2 = boundFrom(run.trace, r + b1.K, run)
        if (!b2 || r + b1.K + b2.K >= run.trace.length) continue
        const wasTracked = run.trace.slice(0, r).some((t) => t.reached.has(id))
        if (!wasTracked) continue
        removedChecked++
        const d = run.droppedAt.get(id)
        assert.ok(d !== undefined && d >= r && d <= r + b1.K + b2.K, `seed ${seed}: entry of ${id.slice(0, 8)} (removed before cycle ${r}) dropped at ${d}, bound ${r + b1.K + b2.K}`)
      }
    }
    assert.ok(removedChecked > 100, `only ${removedChecked} removals checked`)
  })
})
