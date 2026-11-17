// [SEC-4 / fix/keeper-active-orders-window] The keeper only ever looked at the 15 oldest active rows of
// its chain: fetchActiveOrders asked for status=eq.active, this chain, order=created_at.asc,
// limit=MAX_BATCH*3, and a row whose canExecute is false is unlocked back to `active` without a miss, so
// it keeps its place. 15 rows that cannot execute yet (unfunded, no allowance, a DCA waiting for its
// interval) hid every newer order on that chain until they expired.
//
// These tests run the SHIPPED executeCycle / fetchActiveOrders (executor-cycle.fixture.mjs copies
// executor.js with its imports made absolute and main() cut) against a fake PostgREST and a fake chain.
// "Examined" at this level = canExecute was asked for that row.
//
// Run: node --test contracts/order-engine/executor/active-window-cycle.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { loadShippedExecutor, createFakePostgrest, createFakeChain, makeRow, withFakes, OTHER_CHAIN_ID } from "./executor-cycle.fixture.mjs"

const WINDOW = 15 // MAX_BATCH * 3 — today's per-cycle row budget

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
async function runCycles(k, db, chain, cycles, { startMs = T0, onBeforeCycle = null } = {}) {
  const perCycle = []
  const lines = []
  const windowLines = []
  const returned = []
  for (let c = 0; c < cycles; c++) {
    if (onBeforeCycle) onBeforeCycle(c)
    const before = chain.canExecuteCalls.length
    const out = await withFakes(db, () => k.executeCycle(chain.publicClient, null, null, null, null, null), { nowMs: startMs + c * CYCLE_MS })
    lines.push(...out.lines)
    windowLines.push(out.lines.filter((l) => l.includes("Active window:")))
    returned.push(out.result)
    perCycle.push(chain.canExecuteCalls.slice(before))
  }
  return { perCycle, lines, windowLines, returned }
}

describe("[SEC-4] Step 0 — the 15 oldest non-executable rows must not hide a newer order", () => {
  test("15 old rows whose canExecute is false + 1 newer executable row: the newer row is examined within 20 cycles", async () => {
    const k = await loadShippedExecutor()
    const newer = makeRow(100)
    const db = createFakePostgrest([...fifteenStuckRows(), newer])
    const chain = createFakeChain(db, (row) => (row.id === newer.id ? [true, ""] : [false, STUCK_REASON(row)]))

    const { perCycle } = await runCycles(k, db, chain, 20)

    for (const [i, ids] of perCycle.entries()) {
      assert.ok(ids.length <= WINDOW, `cycle ${i + 1} examined ${ids.length} rows (> ${WINDOW})`)
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
    assert.match(windowLines[0][0], /Active window: active=0 window=0 examined=0 slowed=0 wrap=yes$/)
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
    assert.match(windowLines[0][0], /active=15 window=15 examined=15 slowed=0 wrap=no$/, "cycle 1 read a full page: it cannot know the table ends there")
    assert.match(windowLines[1][0], /active=15 window=15 examined=15 slowed=0 wrap=yes$/)
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

  test("restart mid-rotation: a fresh process begins at the oldest row and still covers the table within ceil(M/15) cycles", async () => {
    const rows = rowsOf(50)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    const before = await loadShippedExecutor()
    const first = await runCycles(before, db, chain, 2) // the cursor is now 30 rows in
    assert.equal(first.perCycle[1][0], rows[15].id)
    const after = await loadShippedExecutor() // new module instance = a restarted process (state in memory only)
    const { perCycle } = await runCycles(after, db, chain, Math.ceil(50 / WINDOW))
    assert.equal(perCycle[0][0], rows[0].id, "a restart begins at the oldest row")
    assert.equal(new Set(perCycle.flat()).size, 50)
  })

  test("the idle probe's fetchActiveOrders() never moves the cursor (only a full cycle does)", async () => {
    const k = await loadShippedExecutor()
    const rows = rowsOf(40)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    await runCycles(k, db, chain, 1)
    const probes = []
    for (let i = 0; i < 3; i++) probes.push((await withFakes(db, () => k.fetchActiveOrders())).result.map((r) => r.id))
    assert.deepEqual(probes[0], rows.slice(15, 30).map((r) => r.id))
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

describe("[SEC-4] shipped cycle — slow-down (balance / allowance only, 3 in a row, at most once per 10 min)", () => {
  test("unfunded and allowance-less rows are asked 3 times, then once per 10 min; interval/price rows are asked every pass", async () => {
    const k = await loadShippedExecutor()
    const rows = rowsOf(6)
    const answers = new Map([
      [rows[0].id, [false, "Insufficient balance"]],
      [rows[1].id, [false, "Insufficient allowance"]],
      [rows[2].id, [false, "DCA interval not reached"]],
      [rows[3].id, [false, "Price below floor"]],
      [rows[4].id, [false, "Stale price feed"]],
      [rows[5].id, [true, ""]],
    ])
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, answerBy(answers))
    const cycles = 45 // 22.5 minutes at 30 s
    const { perCycle, windowLines } = await runCycles(k, db, chain, cycles)
    const askedAt = (id) => perCycle.flatMap((ids, c) => (ids.includes(id) ? [c] : []))
    // 3 answers (cycles 0,1,2) ⇒ slowed until 10 min after the 3rd ⇒ asked again at cycle 22, then 42.
    assert.deepEqual(askedAt(rows[0].id), [0, 1, 2, 22, 42])
    assert.deepEqual(askedAt(rows[1].id), [0, 1, 2, 22, 42])
    for (const r of rows.slice(2)) assert.equal(askedAt(r.id).length, cycles, `${answers.get(r.id)[1] || "true"} must never be slowed`)
    assert.match(windowLines[5][0], /window=6 examined=4 slowed=2 wrap=yes$/)
  })

  test("a slowed row that is funded again is examined at the next due pass and leaves the slow-down", async () => {
    const k = await loadShippedExecutor()
    const rows = rowsOf(2)
    const answers = new Map([[rows[0].id, [false, "Insufficient balance"]], [rows[1].id, [false, "DCA interval not reached"]]])
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, answerBy(answers))
    const { perCycle } = await runCycles(k, db, chain, 30, { onBeforeCycle: (c) => c === 10 && answers.set(rows[0].id, [false, "DCA interval not reached"]) })
    const askedAt = perCycle.flatMap((ids, c) => (ids.includes(rows[0].id) ? [c] : []))
    assert.deepEqual(askedAt.slice(0, 5), [0, 1, 2, 22, 23], "funded at cycle 10, seen at the next due pass (22), then every pass")
  })
})

describe("[SEC-4] shipped cycle — one window line per cycle, counts only", () => {
  test("exactly one `Active window:` line per cycle; no address, no signature, no id; fetch's old per-query lines are gone", async () => {
    const k = await loadShippedExecutor()
    const rows = [...rowsOf(10), ...rowsOf(10, 20, { type: "dca" })]
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, (row) => (row.order_type === "dca" ? [false, "DCA interval not reached"] : [false, "Insufficient balance"]))
    const { windowLines, lines } = await runCycles(k, db, chain, 5)
    assert.deepEqual(windowLines.map((w) => w.length), [1, 1, 1, 1, 1])
    for (const [w] of windowLines) {
      assert.match(w, /Active window: active=20 window=15 examined=\d+ slowed=\d+ wrap=(yes|no)$/)
      assert.doesNotMatch(w, /0x|[0-9a-f]{8}-[0-9a-f]{4}-/i, "no address, signature or id")
    }
    assert.match(windowLines[0][0], /examined=15 slowed=0 wrap=no$/)
    assert.match(windowLines[1][0], /window=15 examined=15 slowed=0 wrap=yes$/, "5 tail rows + 10 head rows: the scan passed the newest row")
    assert.equal(lines.some((l) => /Querying:|Supabase returned|First order:/.test(l)), false)
  })
})

describe("[SEC-4] shipped cycle — the window query rejected by Supabase (owner answer: fall back to the oldest 15)", () => {
  test("a 400 on the keyset query ⇒ today's exact query for that cycle, flagged on the window line, detail logged once", async () => {
    const k = await loadShippedExecutor()
    const rows = rowsOf(20)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    await runCycles(k, db, chain, 1) // cursor now set ⇒ the next read carries or=(…)
    db.failNextMatching(/[?&]or=/, 400, '{"code":"PGRST100","message":"failed to parse logic tree"}', "GET")
    const second = await runCycles(k, db, chain, 1)
    assert.deepEqual(second.perCycle[0], rows.slice(0, 15).map((r) => r.id), "the 15 oldest, as before this change")
    const legacy = db.requests.filter((r) => r.search === "?status=eq.active&chain_id=eq.8453&select=*&order=created_at.asc&limit=15")
    assert.equal(legacy.length, 1, "today's query, byte for byte")
    assert.match(second.windowLines[0][0], /keyset=rejected\(400\) fallback=oldest$/)
    assert.equal(second.lines.filter((l) => l.includes("Active window query REJECTED")).length, 1)
    db.failNextMatching(/[?&]or=/, 400, "again", "GET")
    const third = await runCycles(k, db, chain, 1)
    assert.equal(third.lines.filter((l) => l.includes("Active window query REJECTED")).length, 0, "logged once per process")
    assert.match(third.windowLines[0][0], /keyset=rejected\(400\)/)
  })

  test("both the window query and today's query fail ⇒ today's handling: log, no rows, the cursor is kept", async () => {
    const k = await loadShippedExecutor()
    const rows = rowsOf(20)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "DCA interval not reached"])
    await runCycles(k, db, chain, 1)
    const realFetch = db.fetch
    let failures = 0
    db.fetch = async (input, init) => (String(input).includes("/rest/v1/orders?") && (init?.method ?? "GET") === "GET" && failures++ < 2 ? new Response("down", { status: 503 }) : realFetch(input, init))
    const down = await runCycles(k, db, chain, 1)
    assert.deepEqual(down.returned, [0])
    assert.ok(down.lines.some((l) => l.includes("Supabase fetch error: 503")))
    db.fetch = realFetch
    const next = await runCycles(k, db, chain, 1)
    assert.equal(next.perCycle[0][0], rows[15].id, "the cursor survived the failed cycle")
  })
})

// ── shipped cycle: seeded property ────────────────────────────────────────────────────────────────

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

describe("[SEC-4] shipped cycle — seeded property (random tables, churn, random answers)", () => {
  const SEEDS = [0x51c4, 0x2b07, 0x9e3d, 0x0f11, 0x7a5a, 0x3c90]
  test("every row present for ceil(M/15)+1 cycles is examined (slowed rows: within 10 min + one rotation); ≤ 15 per cycle; never another chain", async () => {
    const summary = []
    for (const seed of SEEDS) {
      const rand = mulberry32(seed)
      const M0 = 1 + Math.floor(rand() * 400)
      let n = 1
      const persona = new Map()
      const pick = () => ["interval", "price", "unfunded", "no-allowance", "true", "mixed"][Math.floor(rand() * 6)]
      const mk = (opts = {}) => {
        const p = pick()
        const row = makeRow(n++, { type: p === "interval" ? "dca" : "limit", ...opts })
        persona.set(row.id, p)
        return row
      }
      const initial = Array.from({ length: M0 }, () => mk())
      const db = createFakePostgrest([...initial, ...rowsOf(25, 900_000, { chainId: OTHER_CHAIN_ID })])
      const answer = (row) => {
        switch (persona.get(row.id)) {
          case "interval": return [false, "DCA interval not reached"]
          case "price": return [false, "Price below floor"]
          case "unfunded": return [false, "Insufficient balance"]
          case "no-allowance": return [false, "Insufficient allowance"]
          case "true": return [true, ""]
          default: return rand() < 0.5 ? [false, "Insufficient balance"] : [false, "DCA interval not reached"]
        }
      }
      const chain = createFakeChain(db, answer)
      const k = await loadShippedExecutor()
      const cycles = 2 * Math.ceil((M0 + 60) / WINDOW) + 24
      const present = []
      const run = await runCycles(k, db, chain, cycles, {
        onBeforeCycle: (c) => {
          if (c > 0) {
            for (let i = Math.floor(rand() * 3); i > 0; i--) {
              const mine = db.table.filter((r) => r.chain_id === 8453)
              if (mine.length) db.remove(mine[Math.floor(rand() * mine.length)].id)
            }
            for (let i = Math.floor(rand() * 3); i > 0; i--) {
              const r = rand()
              const mine = db.table.filter((x) => x.chain_id === 8453)
              const createdAt = r < 0.15 && mine.length ? mine[Math.floor(rand() * mine.length)].created_at : undefined // a tie
              db.insert(mk(createdAt ? { createdAt } : { createdAt: isoAtFor(n + 100_000) }))
            }
          }
          present.push(new Set(db.table.filter((r) => r.chain_id === 8453 && r.status === "active").map((r) => r.id)))
        },
      })
      const theirs = new Set(db.table.filter((r) => r.chain_id !== 8453).map((r) => r.id))
      let checks = 0
      let slowChecks = 0
      for (const [c, ids] of run.perCycle.entries()) {
        assert.ok(ids.length <= WINDOW, `seed ${seed} cycle ${c}: ${ids.length} examined`)
        assert.equal(ids.some((id) => theirs.has(id)), false, `seed ${seed}: another chain's row examined`)
      }
      // A row that answered balance/allowance can be legitimately slowed: its bound is 10 min (20 cycles) + one rotation.
      const slowable = (id) => ["unfunded", "no-allowance", "mixed"].includes(persona.get(id))
      // Index (cheap to check, so this test stays light beside timing-sensitive files): each row is present
      // over one interval [first, last] (removed rows never come back — asserted), the distinct rows of
      // cycles s..j are |present_s| plus the rows first present in s+1..j, and each row's examined cycles.
      const first = new Map()
      const last = new Map()
      const newAt = new Array(cycles).fill(0)
      const examinedAt = new Map()
      for (let t = 0; t < cycles; t++) {
        for (const id of present[t]) {
          if (!first.has(id)) {
            first.set(id, t)
            if (t > 0) newAt[t]++
          } else assert.equal(last.get(id), t - 1, `row ${id} came back after leaving`)
          last.set(id, t)
        }
        for (const id of run.perCycle[t]) {
          if (!examinedAt.has(id)) examinedAt.set(id, [])
          examinedAt.get(id).push(t)
        }
      }
      const boundK = (s) => {
        let M = present[s].size
        for (let j = s; j < cycles; j++) {
          if (j > s) M += newAt[j]
          if (j - s + 1 >= Math.ceil(M / WINDOW) + 1) return j - s + 1
        }
        return 0
      }
      const boundKBySets = (s) => {
        const seen = new Set()
        for (let j = s; j < cycles; j++) {
          for (const id of present[j]) seen.add(id)
          if (j - s + 1 >= Math.ceil(seen.size / WINDOW) + 1) return j - s + 1
        }
        return 0
      }
      for (let s = 0; s < cycles; s++) {
        const K = boundK(s)
        if (s % 13 === 0) assert.equal(K, boundKBySets(s), `seed ${seed} s=${s}: indexed K differs from the definition`)
        if (!K) break
        for (const id of present[s]) {
          const span = slowable(id) ? 20 + K : K
          if (s + span > cycles) continue
          if (last.get(id) < s + span - 1) continue // not present throughout
          if (slowable(id)) slowChecks++
          else checks++
          const examined = (examinedAt.get(id) ?? []).some((t) => t >= s && t < s + span)
          assert.ok(examined, `seed ${seed}: ${persona.get(id)} row present in cycles ${s}..${s + span - 1} never examined`)
        }
      }
      summary.push(`seed ${seed.toString(16)}: M0=${M0}, ${cycles} cycles, ${checks}+${slowChecks} checks`)
      assert.ok(checks > 0)
    }
    console.log(`  shipped-cycle property: ${summary.join("; ")}`)
  })
})

describe("[SEC-4] executor.js wiring (source anchors)", () => {
  test("the paused branch neither moves the cursor nor feeds the slow-down (it examined nothing)", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(new URL("./executor.js", import.meta.url), "utf8")
    const a = src.indexOf("const pausedState = rpcAuthMonitor ? rpcAuthMonitor.state().paused : null")
    const b = src.indexOf("return orders.length", a)
    const paused = src.slice(a, b)
    assert.ok(a > 0 && b > a)
    assert.equal(paused.includes("advanceActiveWindow("), false)
    assert.equal(paused.includes("noteCanExecuteAnswer("), false)
    assert.ok(paused.includes("activeWindowLogLine("), "the paused cycle still prints its window line")
  })
  test("the window size is today's: MAX_BATCH * 3 rows, MAX_BATCH = 5", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(new URL("./executor.js", import.meta.url), "utf8")
    assert.match(src, /^const MAX_BATCH = 5 /m)
    assert.match(src, /const windowSize = MAX_BATCH \* 3\n/)
  })
})

function isoAtFor(n) {
  return new Date(Date.parse("2026-08-01T00:00:00.000Z") + n * 1000).toISOString().slice(0, 19) + ".000000+00:00"
}
