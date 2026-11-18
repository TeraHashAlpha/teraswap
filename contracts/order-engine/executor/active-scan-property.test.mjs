// [SEC-4 / A88 round 2] Seeded property of the SHIPPED cycle (executor-cycle.fixture.mjs) with a fake wallet that
// really executes: random tables and churn, random answers per row and cycle, failed scan reads, failed Multicall3
// chunks, gas SKIPs, expired rows, rows the pre-screen cannot answer.
//
//   1. no order is executed twice;
//   2. never more than MAX_BATCH (5) executions in a cycle;
//   3. every active row is asked canExecute within ceil(M / SCAN_CAP) cycles plus one per fallback cycle;
//   4. the pre-screen never changes a row: a row is written (PATCH by id) in a cycle only if that cycle's
//      pre-screen said true, could not answer it, or its expiry had passed — i.e. only by the per-order path.
//
// Half the seeds rewrite SCAN_CAP to 25 so the scan rotates over tables of up to ~150 rows; the others run the
// shipped 1000.
//
// Run: node --test contracts/order-engine/executor/active-scan-property.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"

import { createFakePostgrest, createFakeChain, makeRow, mulberry32 } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle, checkScreenBound } from "./active-scan.testlib.mjs"

const MAX_BATCH = 5
const PERSONAS = ["ready-once", "never", "flaky", "flaky", "unanswerable", "dca"]

/** A deterministic coin per (seed, row number, cycle): the same answer for the pre-screen and the path in one cycle. */
function coin(seed, n, c, p) {
  return mulberry32((seed * 1_000_003) ^ (n * 7919) ^ (c * 104_729))() < p
}

async function run(seed) {
  const rand = mulberry32(seed)
  const scan = seed % 2 === 0 ? 25 : 1000
  const k = await loadKeeper(scan === 1000 ? {} : { constants: { SCAN_CAP: scan } })
  let n = 0
  const persona = new Map()
  const numOf = new Map()
  const mk = () => {
    n++
    const p = PERSONAS[Math.floor(rand() * PERSONAS.length)]
    const expired = rand() < 0.04
    const row = makeRow(n, { type: p === "dca" ? "dca" : "limit", pinned: true, ...(expired ? { expiry: 1_000 } : {}) })
    persona.set(row.id, p)
    numOf.set(row.id, n)
    return row
  }
  const db = createFakePostgrest(Array.from({ length: 1 + Math.floor(rand() * 120) }, mk))
  let cycle = 0
  const screenAnswer = new Map() // `${cycle}:${id}` -> "true" | "false" | "unanswered"
  const chain = createFakeChain(
    db,
    (row, _state, route) => {
      const p = persona.get(row.id)
      const x = numOf.get(row.id)
      let a
      if (p === "never") a = [false, "Price below floor"]
      else if (p === "ready-once" || p === "dca") a = [true, ""]
      else if (p === "flaky") a = coin(seed, x, cycle, 0.3) ? [true, ""] : [false, "Price below floor"]
      else a = route === "screen" ? { revert: true } : coin(seed, x, cycle, 0.5) ? [true, ""] : [false, "Insufficient balance"]
      if (route === "screen") screenAnswer.set(`${cycle}:${row.id}`, a.revert ? "unanswered" : a[0] ? "true" : "false")
      return a
    },
    {
      wallet: true,
      gasPriceWei: () => (coin(seed, 0, cycle, 0.05) ? 1_000_000_000n : 10_000_000n),
      aggregate: () => (rand() < 0.03 ? "throw" : null),
    },
  )
  let scanFails = false
  db.failWhen((req) => (scanFails && req.method === "GET" && /order=created_at\.asc%2Cid\.asc/.test(req.search) ? ((scanFails = false), { status: 503, body: "" }) : null))

  const cycles = 80
  const presentAt = []
  const askedAt = []
  const fallbackAt = []
  const executedOnce = new Set()
  let executions = 0
  let patchesChecked = 0
  for (cycle = 0; cycle < cycles; cycle++) {
    if (cycle > 0) {
      for (let i = Math.floor(rand() * 3); i > 0; i--) {
        const mine = db.table.filter((r) => r.status === "active")
        if (mine.length) db.remove(mine[Math.floor(rand() * mine.length)].id)
      }
      for (let i = Math.floor(rand() * 4); i > 0; i--) db.insert(mk())
    }
    scanFails = rand() < 0.04
    const failedScan = scanFails
    presentAt.push(new Set(db.table.filter((r) => r.status === "active").map((r) => r.id)))
    const r = await runCycle(k, db, chain, cycle, { random: rand })
    askedAt.push(r.asked)
    fallbackAt.push(failedScan || /prescreen-/.test(r.scanLine ?? "") || /scan-/.test(r.scanLine ?? ""))
    // 1 + 2
    assert.ok(r.executed.length <= MAX_BATCH, `seed ${seed} cycle ${cycle}: ${r.executed.length} executions`)
    for (const id of r.executed) {
      if (persona.get(id) === "dca") continue
      assert.equal(executedOnce.has(id), false, `seed ${seed} cycle ${cycle}: order …${id.slice(-6)} executed twice`)
      executedOnce.add(id)
    }
    executions += r.executed.length
    // 4
    for (const q of r.requests) {
      if (q.method !== "PATCH") continue
      const m = /[?&]id=eq\.([0-9a-f-]{36})/.exec(q.search)
      if (!m) continue
      patchesChecked++
      const row = db.table.find((x) => x.id === m[1])
      const said = screenAnswer.get(`${cycle}:${m[1]}`)
      const expired = row && Number(row.expiry) < Math.floor((Date.now() + 0) / 1000) // the fixture's expiry 1000 is long past
      assert.ok(said === "true" || said === "unanswered" || said === undefined || expired, `seed ${seed} cycle ${cycle}: row …${m[1].slice(-6)} written although the pre-screen said ${said}`)
    }
  }
  // 3
  const { checked } = checkScreenBound({ presentAt, askedAt, fallbackAt, scan, label: `seed ${seed} (scan ${scan})` })
  return { checked, executions, patchesChecked, fallbacks: fallbackAt.filter(Boolean).length, scan }
}

test("seeded: no double execution, <= MAX_BATCH per cycle, every row asked within ceil(M/SCAN_CAP) + fallback cycles, the pre-screen writes nothing", async () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => 0x7e57 + i * 104_729)
  const total = { checked: 0, executions: 0, patchesChecked: 0, fallbacks: 0 }
  for (const seed of SEEDS) {
    const r = await run(seed)
    for (const key of Object.keys(total)) total[key] += r[key]
  }
  assert.ok(total.checked > 20_000, `${total.checked} bound checks`)
  assert.ok(total.executions > 100, `${total.executions} executions`)
  assert.ok(total.patchesChecked > 500, `${total.patchesChecked} row writes checked`)
  assert.ok(total.fallbacks > 10, `${total.fallbacks} fallback cycles`)
  // eslint-disable-next-line no-console
  console.log(`  active-scan property: ${SEEDS.length} seeds × 80 cycles, ${total.checked} bound checks, ${total.executions} executions, ${total.patchesChecked} row writes checked, ${total.fallbacks} fallback cycles`)
})
