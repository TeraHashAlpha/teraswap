// [SEC-4 / fix/keeper-active-orders-window] Pure tests of active-window.js: the query parameters, the scan
// page (wrap, dedupe, chain filter, ties, the count), the scan state (cursor, passes, complete scans), the
// prune rule (two consecutive complete scans), the walk plan (ready, expired, the rotating one-by-one budget),
// the carry-over, the alert pacing and the cycle line — plus a seeded property simulation that drives the
// helpers the way executor.js does over a random table with rows added and removed between cycles.
//
// The simulated database orders and filters with the fixture's own timestamp comparison
// (executor-cycle.fixture.mjs compareTimestamps), not the helper's, so the two cannot share a bug.
//
// Round 2 (A88): the tests of the round-1 cursor-by-reached-rows, rotation keep-set and slow-down went with
// those mechanisms (listed in the branch's feedback file); the selection tests below are round 1's, moved
// from advanceActiveWindow to advanceScan.
//
// Run: node --test contracts/order-engine/executor/active-window.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import {
  activeWindowParams,
  contentRangeTotal,
  cursorOf,
  isUuid,
  selectActiveWindow,
  advanceScan,
  truncateScan,
  keepIdsAfterScans,
  planWalk,
  carryAfterLoop,
  createEpisodeGate,
  fallbackFlag,
  activeScanLogLine,
  logBody,
} from "./active-window.js"
import { compareTimestamps, mulberry32 } from "./executor-cycle.fixture.mjs"
import { checkScreenBound } from "./active-scan.testlib.mjs"

const W = 15 // a small scan, so the unit tests rotate (SCAN_CAP is 1000 in executor.js)
const CHAIN = 8453
const OTHER = 42161

// ── row factory ─────────────────────────────────────────────────────────────────────────────────

const hex = (rand, n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("")
const uuid = (rand) => `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-8${hex(rand, 3)}-${hex(rand, 12)}`
const T0 = Date.parse("2026-11-01T00:00:00.000Z")
const ts = (ms, micros = 0) => `${new Date(ms).toISOString().slice(0, 19)}.${String(micros).padStart(6, "0")}+00:00`
const row = (id, createdAt, chainId = CHAIN) => ({ id, created_at: createdAt, chain_id: chainId, status: "active" })
const idN = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

// A database answering the keeper's scan reads. Order and keyset use the FIXTURE's timestamp compare.
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
    /** rows after `cursor` (or from row `offset`), keyset order; `total` = what PostgREST's count=exact says. */
    query(cursor, limit, { offset = 0 } = {}) {
      const after = cursor ? (r) => keyCmp(r, { created_at: cursor.createdAt, id: cursor.id }) > 0 : () => true
      const all = this.active().filter(after).sort(keyCmp)
      return { rows: all.slice(offset, offset + limit), total: all.length }
    },
  }
}

// One keeper "process": the state executor.js keeps around the helpers.
function createKeeper() {
  return { cursor: null, pass: { ids: new Set(), fromOldest: false } }
}
/** The page after the cursor (with its count, as executor.js asks), and the head from the oldest when it reached the end. */
function fetchWindow(db, k, { count = true, offset = null } = {}) {
  const page = db.query(k.cursor, W, { offset: offset ?? 0 })
  const tailTotal = count ? page.total : null
  const first = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: k.cursor, offset, tail: page.rows, tailTotal })
  const head = first.endReached && !first.fromOldest && page.rows.length < W ? db.query(null, W - page.rows.length).rows : null
  return head ? selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: k.cursor, offset, tail: page.rows, tailTotal, head }) : first
}
/** Move the keeper past a screened scan (executor.js advanceActiveScan). */
function advance(k, scan, extraIds = []) {
  const next = advanceScan({ cursor: k.cursor, pass: k.pass }, scan, { extraIds })
  k.cursor = next.cursor
  k.pass = next.pass
  return next
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
  const sel = (db, k) => fetchWindow(db, k)

  test("empty table ⇒ empty window, scan reached the end and covers everything, cursor back to the oldest", () => {
    const k = createKeeper()
    k.cursor = cursorOf(row(idN(9), ts(T0)))
    const scan = sel(createDb([]), k)
    assert.deepEqual(scan.rows, [])
    assert.equal(scan.endReached, true)
    assert.equal(scan.coversAll, true, "an empty head is a short head")
    const moved = advanceScan({ cursor: k.cursor, pass: { ids: new Set(["x"]), fromOldest: true } }, scan)
    assert.equal(moved.cursor, null)
    assert.deepEqual([...moved.complete], [], "an empty chain is a complete (empty) scan")
  })

  test("one row ⇒ it is in every window", () => {
    const db = createDb([row(idN(1), ts(T0))])
    const k = createKeeper()
    for (let c = 0; c < 4; c++) {
      const scan = sel(db, k)
      assert.deepEqual(scan.rows.map((r) => r.id), [idN(1)])
      assert.equal(scan.coversAll, true)
      advance(k, scan)
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
      advance(k, scan)
    }
    // The first cycle (cursor null) reads a FULL page of 15: without a count it cannot know the table ends there.
    const first = fetchWindow(db, createKeeper(), { count: false })
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
      advance(k, scan)
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
      advance(k, scan)
    }
    assert.equal(new Set(seen.slice(0, 40)).size, 40, "the first 40 examinations are the 40 distinct rows")
  })

  test("a row of another chain in a page is never handed to the loop (defence in depth behind chain_id=eq.)", () => {
    const tail = [row(idN(1), ts(T0)), row(idN(2), ts(T0 + 1), OTHER), row(idN(3), ts(T0 + 2))]
    const scan = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: null, tail, head: null })
    assert.deepEqual(scan.rows.map((r) => r.id), [idN(1), idN(3)])
  })

  test("head rows already in the tail are dropped, and the window never exceeds its size", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(idN(i + 1), ts(T0 + i)))
    const cursor = cursorOf(rows[3])
    const tail = rows.slice(4)
    const head = rows.slice(0, 9) // W - |tail| = 9: rows 1..9, of which 5..9 are in the tail
    const scan = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor, tail, head })
    assert.deepEqual(scan.rows.map((r) => r.id), [...rows.slice(4), ...rows.slice(0, 4)].map((r) => r.id))
    assert.equal(scan.coversAll, true)
    const big = selectActiveWindow({ chainId: CHAIN, windowSize: 3, cursor: null, tail: rows })
    assert.equal(big.rows.length, 3)
  })
})

describe("activeWindowParams / isUuid — round 2 additions", () => {
  test("offset (a fresh process's random page) only without a cursor; never a negative or fractional offset", () => {
    assert.equal(activeWindowParams({ cursor: null, limit: 1000, offset: 4321 }), "select=*&order=created_at.asc%2Cid.asc&limit=1000&offset=4321")
    assert.equal(activeWindowParams({ cursor: null, limit: 10, offset: 0 }), "select=*&order=created_at.asc%2Cid.asc&limit=10")
    assert.equal(activeWindowParams({ cursor: null, limit: 10, offset: -3 }).includes("offset"), false)
    assert.equal(activeWindowParams({ cursor: null, limit: 10, offset: 2.5 }).includes("offset"), false)
    const cursor = { createdAt: "2026-11-17T10:00:00Z", id: idN(1) }
    assert.equal(activeWindowParams({ cursor, limit: 10, offset: 7 }).includes("offset"), false)
  })
  test("isUuid: the only id shape ever put in an id=in.(…) list", () => {
    assert.equal(isUuid(idN(5)), true)
    for (const bad of ["1) or (1=1", "", null, 7, `${idN(5)},x`]) assert.equal(isUuid(bad), false, String(bad))
  })
})

describe("selectActiveWindow — the count decides the end of the table (Supabase max_rows)", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(idN(i + 1), ts(T0 + i * 1000)))
  test("a page shorter than its limit is NOT the end when the count says more rows match", () => {
    const capped = selectActiveWindow({ chainId: CHAIN, windowSize: 20, cursor: null, tail: rows.slice(0, 10), tailTotal: 30 })
    assert.equal(capped.endReached, false)
    assert.equal(capped.coversAll, false)
  })
  test("a full page IS the end when the count says so (the whole table from the oldest: a complete scan)", () => {
    const full = selectActiveWindow({ chainId: CHAIN, windowSize: 30, cursor: null, tail: rows, tailTotal: 30 })
    assert.equal(full.endReached, true)
    assert.equal(full.coversAll, true)
    assert.equal(full.fromOldest, true)
  })
  test("an offset page counts from its offset (Content-Range total ignores the offset) and is never complete on its own", () => {
    const tail = rows.slice(25)
    const s = selectActiveWindow({ chainId: CHAIN, windowSize: 10, cursor: null, offset: 25, tail, tailTotal: 30 })
    assert.equal(s.endReached, true)
    assert.equal(s.fromOldest, false)
    assert.equal(s.coversAll, false)
    const wrapped = selectActiveWindow({ chainId: CHAIN, windowSize: 10, cursor: null, offset: 25, tail, tailTotal: 30, head: rows.slice(0, 5) })
    assert.deepEqual(wrapped.rows.map((r) => r.id), [...rows.slice(25), ...rows.slice(0, 5)].map((r) => r.id))
    assert.equal(wrapped.coversAll, false, "it holds 10 of 30")
  })
})

describe("advanceScan — the scan's position and its complete scans", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(idN(i + 1), ts(T0 + i * 1000)))
  test("M <= scan size: every cycle is a complete scan from the oldest; no cursor", () => {
    const db = createDb(rows.slice(0, 12))
    const k = createKeeper()
    for (let c = 0; c < 3; c++) {
      const next = advance(k, fetchWindow(db, k))
      assert.equal(next.cursor, null)
      assert.equal(next.complete.size, 12)
    }
  })
  test("rotating: consecutive pages tile the table; a pass from the oldest is complete when it reaches the newest row", () => {
    const db = createDb(rows)
    const k = createKeeper()
    const completes = []
    const pages = []
    for (let c = 0; c < 8; c++) {
      const scan = fetchWindow(db, k)
      pages.push(scan.rows.map((r) => Number.parseInt(r.id.slice(-12), 16)))
      const next = advance(k, scan)
      completes.push(next.complete ? next.complete.size : null)
    }
    assert.deepEqual(pages[0], Array.from({ length: 15 }, (_, i) => i + 1))
    assert.deepEqual(pages[2], [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2, 3, 4, 5])
    assert.deepEqual(completes.slice(0, 3), [null, null, 40], "the pass from row 1 is complete at the cycle that reaches row 40")
    assert.equal(completes.filter((x) => x === 40).length >= 2, true)
  })
  test("a random first page (S-8): that first pass is not complete; the next one, from the oldest, is", () => {
    const db = createDb(rows)
    const k = createKeeper()
    const first = fetchWindow(db, k, { offset: 22 })
    const n1 = advance(k, first)
    assert.equal(n1.complete, null)
    let c = 0
    let completeAt = null
    while (completeAt === null && c < 10) {
      const n = advance(k, fetchWindow(db, k))
      c++
      if (n.complete) completeAt = c
      if (n.complete) assert.equal(n.complete.size, 40)
    }
    assert.notEqual(completeAt, null)
  })
  test("no head this cycle (its read failed): the pass ends here, the next scan starts at the oldest row (never stalls on the newest)", () => {
    const db = createDb(rows)
    const k = createKeeper()
    k.cursor = cursorOf(rows[29])
    k.pass = { ids: new Set(rows.slice(0, 30).map((r) => r.id)), fromOldest: true }
    const page = db.query(k.cursor, W)
    const scan = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: k.cursor, tail: page.rows, tailTotal: page.total, head: null })
    assert.equal(scan.endReached, true)
    const next = advance(k, scan)
    assert.equal(next.cursor, null)
    assert.equal(next.complete.size, 40)
  })
  test("truncateScan: a failed chunk holds the scan at its first row (the next page starts there)", () => {
    const db = createDb(rows)
    const k = createKeeper()
    const scan = fetchWindow(db, k)
    const held = truncateScan(scan, 6)
    assert.equal(held.rows.length, 6)
    advance(k, held)
    assert.equal(fetchWindow(db, k).rows[0].id, rows[6].id)
    const none = truncateScan(scan, 0)
    const k2 = createKeeper()
    advance(k2, none)
    assert.equal(k2.cursor, null, "nothing screened: the position does not move")
    assert.equal(truncateScan(scan, 99), scan)
  })
})

describe("keepIdsAfterScans — an entry goes only when its row is absent from two consecutive complete scans", () => {
  test("no complete scan, or the first one of the process ⇒ prune nothing", () => {
    assert.equal(keepIdsAfterScans(null, null), null)
    assert.equal(keepIdsAfterScans(new Set(["a"]), null), null)
    assert.equal(keepIdsAfterScans(null, new Set(["a"])), null)
  })
  test("a row absent from ONE complete scan (it was `executing`) keeps its entry; absent from two, it goes", () => {
    const keep = keepIdsAfterScans(new Set(["a", "b"]), new Set(["a"]))
    assert.deepEqual([...keep].sort(), ["a", "b"])
    assert.deepEqual([...keepIdsAfterScans(new Set(["a"]), new Set(["a"]))], ["a"])
  })
})

describe("planWalk — ready rows, expired rows, and the rotating one-by-one budget", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: idN(i + 1), expiry: String(2_000_000_000) }))
  const ans = (pairs) => new Map(pairs)
  test("ready rows and expired rows always; rows answered false never; order kept", () => {
    const r = rows.slice(0, 5).map((x) => ({ ...x }))
    r[3].expiry = "100"
    const w = planWalk({
      rows: r,
      answers: ans([[r[0].id, { canExec: true }], [r[1].id, { canExec: false }], [r[2].id, { canExec: true }], [r[3].id, { canExec: false }], [r[4].id, { canExec: false }]]),
      nowSec: 1_900_000_000,
      budget: 15,
    })
    assert.deepEqual(w.ready, [r[0].id, r[2].id])
    assert.deepEqual(w.expired, [r[3].id])
    assert.deepEqual([...w.ids], [r[0].id, r[2].id, r[3].id])
  })
  test("unanswered rows share the budget, least recently walked first; never walked first, oldest first", () => {
    const answers = new Map(rows.map((x) => [x.id, { unanswered: "chunk" }]))
    const lastWalked = new Map()
    const walked = []
    for (let cycle = 1; cycle <= 3; cycle++) {
      const w = planWalk({ rows, answers, nowSec: 0, budget: 15, lastWalked })
      walked.push(w.oneByOne.map((id) => Number.parseInt(id.slice(-12), 16)))
      for (const id of w.oneByOne) lastWalked.set(id, cycle)
    }
    assert.deepEqual(walked[0], Array.from({ length: 15 }, (_, i) => i + 1))
    assert.deepEqual(walked[1], Array.from({ length: 15 }, (_, i) => i + 16))
    assert.deepEqual(walked[2], Array.from({ length: 15 }, (_, i) => i + 1), "the queue wraps: the rows that used it longest ago")
  })
  test("40 permanently unanswerable rows + one more: the 41st is in the budget within ceil(41/15) = 3 cycles", () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ id: idN(i + 1), expiry: "2000000000" }))
    const answers = new Map(many.map((x) => [x.id, { unanswered: "build" }]))
    const lastWalked = new Map()
    let at = null
    for (let cycle = 1; cycle <= 3 && at === null; cycle++) {
      const w = planWalk({ rows: many, answers, nowSec: 0, budget: 15, lastWalked })
      if (w.oneByOne.includes(many[40].id)) at = cycle
      for (const id of w.oneByOne) lastWalked.set(id, cycle)
    }
    assert.equal(at, 3)
  })
})

test("carryAfterLoop: ready rows not reached, plus the row a gas SKIP stopped on, in scan order, capped", () => {
  const walk = { ready: ["a", "b", "c", "d"], oneByOne: ["z"] }
  assert.deepEqual(carryAfterLoop(walk, new Set(["a", "b"]), null, 10), ["c", "d"])
  assert.deepEqual(carryAfterLoop(walk, new Set(["a", "b"]), "b", 10), ["b", "c", "d"])
  assert.deepEqual(carryAfterLoop(walk, new Set(["z"]), "z", 10), ["z", "a", "b", "c", "d"])
  assert.deepEqual(carryAfterLoop(walk, new Set(), null, 2), ["a", "b"])
})

test("createEpisodeGate: alert on the first failed cycle, then at most once per repeatMs while it lasts; a good cycle ends it", () => {
  const g = createEpisodeGate({ repeatMs: 3_600_000 })
  const at = (m) => T0 + m * 60_000
  assert.deepEqual(g.onCycle(true, at(0)), { alert: true, cycles: 1, sinceMs: at(0) })
  assert.equal(g.onCycle(true, at(30)).alert, false)
  assert.equal(g.onCycle(true, at(59)).alert, false)
  const r = g.onCycle(true, at(60))
  assert.equal(r.alert, true)
  assert.equal(r.cycles, 4)
  assert.equal(g.onCycle(false, at(61)).alert, false)
  assert.equal(g.onCycle(true, at(62)).alert, true, "a new episode alerts at once")
})

describe("the cycle line (S-11): counts and flags only, numbers validated", () => {
  test("format", () => {
    assert.equal(
      activeScanLogLine({ active: 1340, scanned: 1000, ready: 7, attempted: 5, carried: 2, rotate: true, fallback: "none" }),
      "Active scan: active=1340 scanned=1000 true=7 attempted=5 carried=2 rotate=yes fallback=none",
    )
  })
  test("an absurd or missing number is '?', a fallback flag outside the vocabulary is '?'", () => {
    const line = activeScanLogLine({ active: 1e21, scanned: -1, ready: 2.5, attempted: Number.NaN, carried: null, rotate: false, fallback: "scan-503 or 1=1" })
    assert.equal(line, "Active scan: active=? scanned=? true=? attempted=? carried=? rotate=no fallback=?")
  })
  test("fallbackFlag vocabulary", () => {
    assert.equal(fallbackFlag({}), "none")
    assert.equal(fallbackFlag({ scan: "503" }), "scan-503")
    assert.equal(fallbackFlag({ scan: 400 }), "scan-400")
    assert.equal(fallbackFlag({ scan: "timeout" }), "scan-timeout")
    assert.equal(fallbackFlag({ scan: "<script>" }), "scan-error")
    assert.equal(fallbackFlag({ prescreenFailed: 2, prescreenChunks: 20 }), "prescreen-2of20")
    assert.equal(fallbackFlag({ scan: "network", prescreenFailed: 1, prescreenChunks: 1 }), "scan-network+prescreen-1of1")
    for (const f of ["none", "scan-503", "prescreen-2of20", "scan-network+prescreen-1of1"]) assert.match(activeScanLogLine({ active: 1, scanned: 1, ready: 0, attempted: 0, carried: 0, rotate: false, fallback: f }), new RegExp(`fallback=${f.replace("+", "\\+")}$`))
  })
  test("logBody: no uuid, no 0x-hex of 40+ digits, no URL; one line; at most 200 characters", () => {
    const body = `{"message":"failed to parse filter (created_at.gt.\\"2026-11-17T10:00:00+00:00\\",id.gt.\\"${idN(9)}\\")","hint":"0x${"ab".repeat(32)} see https://supabase.example/rest/v1/orders?id=eq.${idN(9)}"}\n${"x".repeat(400)}`
    const out = logBody(body)
    assert.ok(out.length <= 200)
    assert.doesNotMatch(out, /[0-9a-f]{8}-[0-9a-f]{4}-|0x[0-9a-f]{40}|https?:\/\/|\n/i)
    assert.match(out, /<id>/)
  })
})

// ── seeded property simulation ───────────────────────────────────────────────────────────────────

/**
 * One seeded run of the scan the way executor.js drives it: every cycle reads a page (after the cursor, or a
 * random first page), wraps when it reached the newest row, is screened whole (no early stop: the scan no longer
 * depends on the loop), moves, and prunes the stand-in for orderInfraMisses with keepIdsAfterScans. Rows are
 * added (mostly newest, some tied, some back-dated) and removed between cycles; a scan read fails on some cycles
 * (S-2: nothing moves) and a wrap read on others.
 */
function simulate(seed, { cycles, initial, maxAdd = 3, maxRemove = 3, failP = 0.03, wrapFailP = 0.03 }) {
  const rand = mulberry32(seed)
  const db = createDb()
  let nextMs = T0
  const add = (when) => {
    const r = rand()
    let createdAt
    if (when === "initial" || r < 0.7) createdAt = ts((nextMs += 1 + Math.floor(rand() * 5000)), Math.floor(rand() * 1e6))
    else if (r < 0.85 && db.table.length) createdAt = db.table[Math.floor(rand() * db.table.length)].created_at // a tie
    else createdAt = ts(T0 - Math.floor(rand() * 86_400_000), Math.floor(rand() * 1e6)) // back-dated
    db.table.push(row(uuid(rand), createdAt))
  }
  for (let i = 0; i < initial; i++) add("initial")
  const k = createKeeper()
  let started = false
  let previousComplete = null
  const tracked = new Set() // stands in for orderInfraMisses: an entry for every row ever screened
  const presentAt = []
  const askedAt = []
  const fallbackAt = []
  const droppedWhileActive = []
  const removedAt = new Map()
  const droppedAt = new Map()
  for (let c = 0; c < cycles; c++) {
    const present = new Set(db.active().map((r) => r.id))
    presentAt.push(present)
    if (rand() < failP) {
      // S-2: the scan read failed: the 15 oldest are examined, nothing moves.
      fallbackAt.push(true)
      askedAt.push(db.query(null, 15).rows.map((r) => r.id))
      continue
    }
    fallbackAt.push(false)
    let offset = null
    const firstPage = db.query(k.cursor, W)
    if (!started && k.cursor === null && firstPage.total > W) offset = Math.floor(rand() * firstPage.total)
    const page = db.query(k.cursor, W, { offset: offset ?? 0 })
    const first = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: k.cursor, offset, tail: page.rows, tailTotal: page.total })
    let scan = first
    if (first.endReached && !first.fromOldest && page.rows.length < W) {
      if (rand() >= wrapFailP) {
        scan = selectActiveWindow({ chainId: CHAIN, windowSize: W, cursor: k.cursor, offset, tail: page.rows, tailTotal: page.total, head: db.query(null, W - page.rows.length).rows })
      } else if (page.rows.length === 0) {
        // executor.js: an empty page whose wrap failed is a fallback cycle (the 15 oldest; nothing moves).
        fallbackAt[c] = true
        askedAt.push(db.query(null, 15).rows.map((r) => r.id))
        continue
      }
    }
    started = true
    askedAt.push(scan.rows.map((r) => r.id))
    // executor.js order: prune (advanceActiveScan, before the loop) with this cycle's ids in the keep set, then
    // the loop creates entries for the rows it walks.
    const next = advance(k, scan)
    if (next.complete) {
      const keep = keepIdsAfterScans(previousComplete, new Set([...next.complete, ...scan.rows.map((r) => r.id)]))
      previousComplete = next.complete
      if (keep) {
        for (const id of [...tracked]) {
          if (keep.has(id)) continue
          tracked.delete(id)
          if (present.has(id)) droppedWhileActive.push({ seed, c, id })
          if (!droppedAt.has(id)) droppedAt.set(id, c)
        }
      }
    }
    for (const r of scan.rows) tracked.add(r.id)
    // churn
    const removeN = Math.floor(rand() * (maxRemove + 1))
    for (let i = 0; i < removeN && db.table.length; i++) {
      const j = Math.floor(rand() * db.table.length)
      removedAt.set(db.table[j].id, c + 1)
      db.table.splice(j, 1)
    }
    const addN = Math.floor(rand() * (maxAdd + 1))
    for (let i = 0; i < addN; i++) add("churn")
  }
  return { presentAt, askedAt, fallbackAt, droppedWhileActive, removedAt, droppedAt }
}

describe("property (seeded): the scan bound, the chain filter and the prune rule", () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => 0x5ec4 + i * 7919)

  test("random tables (1–300 rows), churn, failed scan and wrap reads, a random first page: every row present long enough is screened within ceil(M/15) + fallback cycles", () => {
    let checked = 0
    for (const seed of SEEDS) {
      const initial = 1 + Math.floor(mulberry32(seed ^ 0xabc)() * 300)
      const run = simulate(seed, { cycles: 120, initial })
      // A failed wrap read ends a scan short of its size: count such cycles with the fallbacks (the bound's "+1 per fallback cycle").
      checked += checkScreenBound({ ...run, fallbackAt: run.fallbackAt.map((f, c) => f || run.askedAt[c].length < Math.min(W, run.presentAt[c].size)), scan: W, label: `seed ${seed}` }).checked
      assert.deepEqual(run.droppedWhileActive, [], `seed ${seed}: an entry of an ACTIVE row was pruned`)
    }
    assert.ok(checked > 20_000, `${checked} checks`)
  })

  test("a static table: the exact bound ceil(M/15) from any starting page", () => {
    for (const M of [1, 2, 14, 15, 16, 29, 30, 31, 100]) {
      const db = createDb(Array.from({ length: M }, (_, i) => row(idN(i + 1), ts(T0 + i * 1000))))
      const k = createKeeper()
      for (let start = 0; start < 2 * Math.ceil(M / W); start++) {
        const save = { cursor: k.cursor, pass: k.pass }
        const reached = new Set()
        for (let c = 0; c < Math.ceil(M / W); c++) {
          const scan = fetchWindow(db, k)
          for (const r of scan.rows) reached.add(r.id)
          advance(k, scan)
        }
        assert.equal(reached.size, M, `M=${M}, start ${start}`)
        k.cursor = save.cursor
        k.pass = save.pass
        advance(k, fetchWindow(db, k))
      }
    }
  })

  test("a removed row's entry is dropped by the second complete scan after it left, never earlier than it left", () => {
    let checkedRemovals = 0
    for (const seed of SEEDS.slice(0, 15)) {
      const run = simulate(seed, { cycles: 150, initial: 90, maxAdd: 2, maxRemove: 2, failP: 0, wrapFailP: 0 })
      assert.deepEqual(run.droppedWhileActive, [])
      for (const [id, r] of run.removedAt) {
        const d = run.droppedAt.get(id)
        if (d === undefined) continue
        checkedRemovals++
        assert.ok(d >= r, `seed ${seed}: ${id.slice(0, 8)} dropped at ${d} before it left at ${r}`)
        // two complete scans = at most two passes of ceil(M/15) + 1 cycles each
        assert.ok(d - r <= 2 * (Math.ceil(200 / W) + 1), `seed ${seed}: ${id.slice(0, 8)} kept ${d - r} cycles after it left`)
      }
    }
    assert.ok(checkedRemovals > 100, `${checkedRemovals} removals`)
  })
})
