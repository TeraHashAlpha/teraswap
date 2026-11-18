// [SEC-4 / A88 audit of PR #714, round 2] Every probe of the audit as a test of the SHIPPED cycle
// (executor-cycle.fixture.mjs), plus the owner's 40-unanswerable-rows test. Each probe failed on the audited
// head a9f12d9a (the round-1 rotating 15-row window); the outputs are in the branch's feedback tables (R1).
//
//   S-1  flood: 15, 16 and 30 new unexecutable rows per cycle never hide an older row
//   S-2  a 503 on the scan query (0.5 %, 2 %, 10 % of cycles) never restarts the rotation
//   S-3  two overlapping cycles (A waits for a receipt, B starts, A ends, C) never prune an active row's streak
//   S-4  the count and the wrap reads throwing or hanging never stop or hang a cycle
//   S-5  a gas SKIP for one cycle: the ready order executes the next cycle
//   S-8  restart loops never starve the rows behind the first pages
//
// "Asked" = canExecute asked for the row by either route (the pre-screen through Multicall3, or the per-order
// path). Scaled tests rewrite SCAN_CAP (and the read time limit) in the temp copy only — the fixture's optional
// constant edit, skipped on a head that has no such constant; one test per probe also runs at full size.
//
// Run: node --test contracts/order-engine/executor/active-scan-probes.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { HttpRequestError } from "viem"

import { createFakePostgrest, createFakeChain, makeRow, mulberry32, withFakes } from "./executor-cycle.fixture.mjs"
import { CYCLE_MS, T0, loadKeeper, runCycle, settles, evenSchedule, checkScreenBound } from "./active-scan.testlib.mjs"

const SCAN = 1000 // the design's SCAN_CAP
const rowsOf = (n, from = 1, opts = {}) => Array.from({ length: n }, (_, i) => makeRow(from + i, opts))
const activeIds = (db) => new Set(db.table.filter((r) => r.chain_id === 8453 && r.status === "active").map((r) => r.id))
const notReady = () => [false, "Insufficient balance"]

/** Run `cycles` cycles; `before(c)` mutates the table; returns presentAt / askedAt per cycle and the run. */
async function drive(k, db, chain, cycles, { before = null, random = null, fallbackAt = [] } = {}) {
  const presentAt = []
  const askedAt = []
  const runs = []
  for (let c = 0; c < cycles; c++) {
    if (before) before(c)
    presentAt.push(activeIds(db))
    const r = await runCycle(k, db, chain, c, { random })
    askedAt.push(r.asked)
    runs.push(r)
  }
  return { presentAt, askedAt, fallbackAt, runs }
}

describe("[A88 S-1] flood: new unexecutable rows every cycle never hide an older row", () => {
  for (const rate of [15, 16, 30]) {
    test(`${rate} new rows per cycle (scan scaled to 100 rows): every row is asked within ceil(M/100) cycles`, async () => {
      const k = await loadKeeper({ constants: { SCAN_CAP: 100 } })
      const db = createFakePostgrest(rowsOf(60))
      const chain = createFakeChain(db, notReady)
      let n = 1000
      const run = await drive(k, db, chain, 40, {
        random: mulberry32(rate),
        before: (c) => {
          if (c > 0) for (let i = 0; i < rate; i++) db.insert(makeRow(n++))
        },
      })
      const oldest = db.table[0].id
      const oldestAt = run.askedAt.flatMap((ids, c) => (ids.includes(oldest) ? [c] : []))
      const { checked } = checkScreenBound({ ...run, scan: 100, label: `flood ${rate}/cycle (oldest row asked at cycles ${oldestAt.join(",") || "none"})` })
      assert.ok(checked > 1000, `${checked} checks`)
    })
  }

  test("30 new rows per cycle at full size (SCAN_CAP 1000, 980 rows growing to 1190): every row within ceil(M/1000) cycles", async () => {
    const k = await loadKeeper()
    const db = createFakePostgrest(rowsOf(980))
    const chain = createFakeChain(db, notReady)
    let n = 5000
    const run = await drive(k, db, chain, 8, {
      random: mulberry32(30),
      before: (c) => {
        if (c > 0) for (let i = 0; i < 30; i++) db.insert(makeRow(n++))
      },
    })
    const { checked } = checkScreenBound({ ...run, scan: SCAN, label: "flood 30/cycle at SCAN_CAP 1000" })
    assert.ok(checked > 3000)
  })
})

describe("[A88 S-2] a failed scan query never restarts the rotation", () => {
  // The fallback request is main's: `order=created_at.asc` without the id tie-break; the scan's own reads order by
  // created_at.asc,id.asc. Only the cycle's FIRST scan read fails (the page), as a 503 from the gateway would.
  const isScanRead = (req) => req.method === "GET" && req.path === "/rest/v1/orders" && /order=created_at\.asc%2Cid\.asc/.test(req.search)

  for (const rate of [0.005, 0.02, 0.1]) {
    test(`503 on ${rate * 100} % of cycles (100 rows, scan scaled to 25): the scan continues where it was, every row within ceil(M/25) + fallback cycles`, async () => {
      const k = await loadKeeper({ constants: { SCAN_CAP: 25 } })
      const rows = rowsOf(100)
      const db = createFakePostgrest(rows)
      const chain = createFakeChain(db, () => [false, "Price below floor"])
      const cycles = 200
      const failAt = evenSchedule(cycles, rate)
      let current = -1
      let failedThisCycle = false
      db.failWhen((req) => {
        if (!failAt.has(current) || failedThisCycle || !isScanRead(req)) return null
        failedThisCycle = true
        return { status: 503, body: "upstream connect error" }
      })
      const fallbackAt = []
      const run = await drive(k, db, chain, cycles, {
        random: mulberry32(Math.round(rate * 1000)),
        before: (c) => {
          current = c
          failedThisCycle = false
          fallbackAt[c] = failAt.has(c)
        },
      })
      run.fallbackAt = fallbackAt
      // Continuity: the first row asked after a fallback cycle follows the last row the previous scan asked.
      const index = new Map(rows.map((r, i) => [r.id, i]))
      let lastScanned = null
      for (let c = 0; c < cycles; c++) {
        const asked = run.askedAt[c]
        if (fallbackAt[c]) continue
        if (lastScanned !== null && fallbackAt[c - 1]) {
          const expected = (index.get(lastScanned) + 1) % rows.length
          assert.equal(
            index.get(asked[0]),
            expected,
            `after the fallback cycle ${c - 1} the scan restarted at row ${index.get(asked[0])} instead of continuing at row ${expected}`,
          )
        }
        lastScanned = asked[asked.length - 1]
      }
      const { checked } = checkScreenBound({ ...run, scan: 25, label: `503 on ${rate * 100} % of cycles` })
      assert.ok(checked > 5000)
    })
  }

})

describe("[A88 S-3] two overlapping cycles never prune an active row's ADR-026 streak", () => {
  test("A waits for a receipt, B starts (a tick), A ends, C: one cycle at a time, and the 10 streak rows keep their streak", async () => {
    const k = await loadKeeper()
    // The audit's sequence, on 45 rows (oldest first). Rows 16..25 miss for OUR reason (a 503 from the RPC) each
    // time the path asks them: an ADR-026 infra streak each, from cycle 1 at the latest. Row 31 is ready from
    // cycle 2 (A) and really executes; A is held in its receipt wait while the next tick (B) fires. On the round-1
    // window (15 rows) A's page is exactly the newest 15 rows, B's page is one row short (row 31 is `executing`),
    // B wraps and resets the rotation, A then moves the cursor to the newest row, and C prunes rows 16..30.
    const rows = rowsOf(45, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const streakRows = new Set(rows.slice(15, 25).map((r) => r.id))
    const ready = rows[30].id
    let phase = 0
    const transport = () => new HttpRequestError({ url: "https://base-mainnet.example/v2/KEY", status: 503, details: "Service Unavailable" })
    let release
    const gate = new Promise((r) => (release = r))
    let holdReceipt = false
    const chain = createFakeChain(
      db,
      (row, _state, route) => {
        if (streakRows.has(row.id)) return route === "screen" ? [true, ""] : { throw: transport() }
        if (row.id === ready && phase >= 2) return [true, ""]
        return [false, "Price below floor"]
      },
      { wallet: true, receiptGate: () => (holdReceipt ? gate : undefined) },
    )
    const tick = k.runOneCycleAtATime__opt ?? ((fn) => fn()) // what main's setInterval runs: guarded, or (a9f12d9a) not
    let running = 0
    let maxRunning = 0
    const cycleAt = (c) => async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      try {
        return await withFakes(db, () => k.executeCycle(chain.publicClient, chain.walletClient, null, null, null, null), { nowMs: T0 + c * CYCLE_MS })
      } finally {
        running--
      }
    }
    const streaksMissing = () => [...streakRows].filter((id) => !k.orderInfraMisses.has(id))

    await tick(cycleAt(0))
    await tick(cycleAt(1))
    assert.deepEqual(streaksMissing(), [], "rows 16..25 have an infra streak after cycles 0 and 1")
    phase = 2
    holdReceipt = true
    const A = tick(cycleAt(2)) // A sends row 31 and waits for its receipt
    for (let i = 0; i < 5000 && chain.executions.length === 0; i++) await new Promise((r) => setImmediate(r))
    assert.equal(chain.executions.length, 1, "A is inside its receipt wait")
    await tick(cycleAt(3)) // B: the next tick, while A is still running
    holdReceipt = false
    release()
    await A // A ends
    for (let c = 4; c < 14; c++) {
      await tick(cycleAt(c)) // C and on
      assert.deepEqual(streaksMissing().length, 0, `after cycle ${c}, ${streaksMissing().length} of the 10 active rows lost their ADR-026 streak`)
    }
    assert.equal(maxRunning, 1, `${maxRunning} cycles ran at the same time`)
  })
})

describe("[A88 S-4] the count and the wrap reads, throwing or hanging, never stop or hang a cycle", () => {
  const isOrdersGet = (req) => req.method === "GET" && req.path === "/rest/v1/orders"
  for (const [what, outcome] of [
    ["count", "throw"],
    ["count", "hang"],
    ["wrap", "throw"],
    ["wrap", "hang"],
  ]) {
    test(`the ${what} read ${outcome === "throw" ? "throws (fetch failed)" : "never answers"}: every cycle finishes, asks rows, and the scan still covers the table`, async () => {
      const k = await loadKeeper({ constants: { SCAN_CAP: 50, SUPABASE_READ_TIMEOUT_MS: 100 } })
      const rows = rowsOf(120)
      const db = createFakePostgrest(rows)
      const chain = createFakeChain(db, () => [false, "Price below floor"])
      let failing = false
      let ordersGets = 0
      db.failWhen((req) => {
        if (!failing) return null
        if (what === "count") return req.method === "HEAD" ? outcome : null
        if (!isOrdersGet(req)) return null
        ordersGets++
        const wrapRead = ordersGets > 1 && /order=created_at\.asc%2Cid\.asc/.test(req.search) && !/[?&]or=/.test(req.search) && !/[?&]offset=/.test(req.search)
        return wrapRead ? outcome : null
      })
      const random = mulberry32(120)
      for (let c = 0; c < 2; c++) await runCycle(k, db, chain, c, { random })
      failing = true
      const seen = new Set()
      for (let c = 2; c < 10; c++) {
        ordersGets = 0
        const r = await settles(runCycle(k, db, chain, c, { random }), 3000, `cycle ${c}`).catch((err) => assert.fail(`cycle ${c}: ${err.message}`))
        assert.ok(r.asked.length > 0, `cycle ${c} asked no row`)
        for (const id of r.asked) seen.add(id)
      }
      assert.equal(seen.size, rows.length, `${rows.length - seen.size} rows never asked in 8 cycles`)
    })
  }
})

describe("[A88 S-5] a gas SKIP for one cycle: the ready order executes the next cycle", () => {
  for (const [label, constants, total] of [
    ["300 rows, the whole chain scanned every cycle", {}, 300],
    ["300 rows, scan scaled to 50 (the carried row is re-read by id next cycle)", { SCAN_CAP: 50 }, 300],
  ]) {
    test(label, async () => {
      const k = await loadKeeper({ constants })
      const rows = rowsOf(total, 1, { pinned: true })
      const db = createFakePostgrest(rows)
      const ready = rows[149].id
      let spikes = 1
      const chain = createFakeChain(db, (row) => (row.id === ready ? [true, ""] : [false, "Price below floor"]), {
        wallet: true,
        gasPriceWei: () => (spikes-- > 0 ? 1_000_000_000n : 10_000_000n), // 1 gwei > Base's URGENT 0.3: SKIP, once
      })
      const random = mulberry32(5)
      let skipCycle = null
      for (let c = 0; c < 40; c++) {
        const r = await runCycle(k, db, chain, c, { random })
        if (skipCycle === null && r.path.includes(ready)) {
          skipCycle = c
          assert.deepEqual(r.executed, [], "the SKIP cycle executes nothing")
          continue
        }
        if (skipCycle !== null && c === skipCycle + 1) {
          assert.deepEqual(r.executed, [ready], `the ready order skipped by gas in cycle ${skipCycle} was not executed in cycle ${c}`)
          return
        }
      }
      assert.fail(`the ready order was never asked by the path in 40 cycles (skip cycle ${skipCycle})`)
    })
  }
})

describe("[A88 S-8] restart loops never starve the rows behind the first pages", () => {
  test("200 rows, a restart every 10 cycles for 30 cycles: every row is asked every cycle (200 <= SCAN_CAP)", async () => {
    const rows = rowsOf(200)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "Price below floor"])
    const random = mulberry32(500)
    const presentAt = []
    const askedAt = []
    let k = null
    for (let c = 0; c < 30; c++) {
      if (c % 10 === 0) k = await loadKeeper() // a new module instance = a restarted process (state in memory only)
      presentAt.push(activeIds(db))
      askedAt.push((await runCycle(k, db, chain, c, { random })).asked)
    }
    const never = rows.filter((r) => !askedAt.some((ids) => ids.includes(r.id))).length
    assert.equal(never, 0, `${never} of 200 rows never asked across 3 processes`)
    checkScreenBound({ presentAt, askedAt, scan: SCAN, label: "restart every 10 cycles" })
  })

  test("300 rows with the scan scaled to 50, a restart every 3 cycles for 15 processes: every row is asked (random first page)", async () => {
    const rows = rowsOf(300)
    const db = createFakePostgrest(rows)
    const chain = createFakeChain(db, () => [false, "Price below floor"])
    const random = mulberry32(300)
    const asked = new Set()
    let k = null
    for (let c = 0; c < 45; c++) {
      if (c % 3 === 0) k = await loadKeeper({ constants: { SCAN_CAP: 50 } })
      for (const id of (await runCycle(k, db, chain, c, { random })).asked) asked.add(id)
    }
    assert.equal(asked.size, rows.length, `${rows.length - asked.size} of 300 rows never asked across 15 processes`)
  })
})

describe("[owner, 2026-11-18] the one-by-one budget rotates: 40 permanently unanswerable rows cannot hold it", () => {
  // Rows 1..40 can never be pre-screened (their stored owner is not an address: the struct cannot be built), so
  // they go through the per-order path from the shared 15-row budget, where the path counts each an infra miss.
  const unanswerable = (n) => {
    const r = makeRow(n, { pinned: true })
    r.order_data.owner = "0xnot-an-address"
    return r
  }

  test("a 41st row the pre-screen cannot answer (its call reverts) but the path can execute is walked within 3 cycles", async () => {
    const k = await loadKeeper()
    const rows = [...Array.from({ length: 40 }, (_, i) => unanswerable(i + 1)), makeRow(41, { pinned: true })]
    const db = createFakePostgrest(rows)
    const target = rows[40].id
    const chain = createFakeChain(db, (row, _s, route) => (row.id === target ? (route === "screen" ? { revert: true } : [true, ""]) : [false, "Price below floor"]), { wallet: true })
    let walkedAt = null
    for (let c = 0; c < 3 && walkedAt === null; c++) {
      const r = await runCycle(k, db, chain, c)
      if (r.path.includes(target)) walkedAt = c
    }
    assert.notEqual(walkedAt, null, "the row was not walked within 3 cycles")
    assert.deepEqual(chain.executions, [target])
  })

  test("a 41st row that becomes answerable (true) at cycle 5 is walked within 3 cycles of it", async () => {
    const k = await loadKeeper()
    const rows = [...Array.from({ length: 40 }, (_, i) => unanswerable(i + 1)), makeRow(41, { pinned: true })]
    const db = createFakePostgrest(rows)
    const target = rows[40].id
    let cycle = 0
    const chain = createFakeChain(
      db,
      (row, _s, route) => {
        if (row.id !== target) return [false, "Price below floor"]
        if (cycle < 5) return route === "screen" ? { revert: true } : [false, "Price below floor"]
        return [true, ""]
      },
      { wallet: true },
    )
    let walkedAt = null
    for (cycle = 0; cycle < 8 && walkedAt === null; cycle++) {
      const r = await runCycle(k, db, chain, cycle)
      if (cycle >= 5 && r.path.includes(target)) walkedAt = cycle
    }
    assert.ok(walkedAt !== null && walkedAt < 8, `walked at ${walkedAt}`)
    assert.deepEqual(chain.executions, [target])
  })
})
