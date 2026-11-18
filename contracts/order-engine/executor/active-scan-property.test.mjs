// [SEC-4 / A88 round 2, A91 round 3] Seeded property of the SHIPPED cycle (executor-cycle.fixture.mjs) with a fake
// wallet that really executes: random tables and churn, random answers per row and cycle, failed scan reads, failed
// Multicall3 chunks (RPC transport errors and time limits), gas SKIPs, expired rows, rows the pre-screen cannot
// answer, and (round 3) POISONED rows — gas burners whose canExecute burns all the gas it is given.
//
//   1. no order is executed twice;
//   2. never more than MAX_BATCH (5) executions in a cycle;
//   3. every active HEALTHY row is asked canExecute within the stated bound: ceil(M / SCAN_CAP) cycles, plus one per
//      fallback cycle (scan query or wrap read failed), plus ceil(M / SCAN_CAP) per cycle that left pre-screen rows
//      unresolved (/health prescreenUnresolvedRows moved);
//   4. every healthy READY row is ATTEMPTED by the path within that bound plus one cycle per cycle whose loop
//      stopped early (MAX_BATCH fills or a gas SKIP);
//   5. the pre-screen never changes a row: a row is written (PATCH by id) in a cycle only if that cycle's pre-screen
//      said true, could not answer it, or its expiry had passed — i.e. only by the per-order path;
//   6. a quarantined row is asked alone at most once every 30 minutes, and quarantine never changes its status
//      (a quarantined row is written only once it expired: the path marks it `expired`).
//
// Half the seeds rewrite SCAN_CAP to 25 so the scan rotates over tables of up to ~150 rows; the others run the
// shipped 1000. A cycle is one minute of fake time (so 80 cycles cross two 30-minute re-ask marks).
//
// ROUND 3 CHANGED property 3: round 2 allowed +1 cycle per failed pre-screen chunk because the scan HELD its
// position there; the scan no longer holds (A91 R2-1), so a row of an unresolved chunk waits a full pass. Poisoned
// rows are not "healthy": they are excluded from 3 and 4 and checked by 6.
//
// Run: node --test contracts/order-engine/executor/active-scan-property.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"

import { createFakePostgrest, createFakeChain, makeRow, mulberry32 } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle, checkScreenBound } from "./active-scan.testlib.mjs"

const MAX_BATCH = 5
const PERSONAS = ["ready-once", "never", "flaky", "flaky", "unanswerable", "dca", "poison"]
const MINUTE = 60_000

/** A deterministic coin per (seed, row number, cycle): the same answer for the pre-screen and the path in one cycle. */
function coin(seed, n, c, p) {
  return mulberry32((seed * 1_000_003) ^ (n * 7919) ^ (c * 104_729))() < p
}

async function run(seed) {
  const rand = mulberry32(seed)
  const scan = seed % 2 === 0 ? 25 : 1000
  const constants = { PRESCREEN_CHUNK_TIMEOUT_MS: 25, ...(scan === 1000 ? {} : { SCAN_CAP: scan }) }
  const k = await loadKeeper({ constants, optionalExports: ["runOneCycleAtATime", "rowQuarantine"] })
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
  // [round 3] What the pre-screen said is the LAST answer the keeper actually received for the row this cycle
  // (chain.delivered: an answered aggregate3's results, a single ask that answered) — not what a failed call would
  // have said: a failed chunk's rows may be bisected, asked alone, or left unresolved for the one-by-one budget.
  const chain = createFakeChain(
    db,
    (row, _state, route) => {
      const p = persona.get(row.id)
      const x = numOf.get(row.id)
      let a
      if (p === "poison") a = { burn: true }
      else if (p === "never") a = [false, "Price below floor"]
      else if (p === "ready-once" || p === "dca") a = [true, ""]
      else if (p === "flaky") a = coin(seed, x, cycle, 0.3) ? [true, ""] : [false, "Price below floor"]
      else a = route === "screen" ? { revert: true } : coin(seed, x, cycle, 0.5) ? [true, ""] : [false, "Insufficient balance"]
      return a
    },
    {
      wallet: true,
      gasPriceWei: () => (coin(seed, 0, cycle, 0.05) ? 1_000_000_000n : 10_000_000n),
      aggregate: () => {
        const x = rand()
        return x < 0.03 ? "throw" : x < 0.05 ? "hang" : null
      },
    },
  )
  let scanFails = false
  db.failWhen((req) => (scanFails && req.method === "GET" && /order=created_at\.asc%2Cid\.asc/.test(req.search) ? ((scanFails = false), { status: 503, body: "" }) : null))

  const cycles = 80
  const presentAt = []
  const countAt = []
  const askedAt = []
  const attemptedAt = []
  const fallbackAt = []
  const passPenaltyAt = []
  const earlyStopAt = []
  const executedOnce = new Set()
  const aloneAt = new Map() // id -> minutes of its alone-asks while quarantined
  const quarantinedSince = new Map()
  let executions = 0
  let patchesChecked = 0
  let quarantineChecks = 0
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
    const healthy = (id) => persona.get(id) !== "poison"
    countAt.push(new Set(db.table.filter((r) => r.status === "active").map((r) => r.id)))
    presentAt.push(new Set([...countAt.at(-1)].filter(healthy)))
    const inQuarantine = new Set(k.rowQuarantine__opt.snapshot().keys())
    const unresolved0 = k.stats.prescreenUnresolvedRows
    const singles0 = chain.singleCalls.length
    const delivered0 = chain.delivered.length
    const r = await runCycle(k, db, chain, 2 * cycle, { random: rand }) // one minute per cycle
    const said = new Map()
    for (const d of chain.delivered.slice(delivered0)) said.set(d.id, d.result)
    askedAt.push(r.asked.filter(healthy))
    attemptedAt.push(r.path.filter((id) => persona.get(id) === "ready-once"))
    fallbackAt.push(failedScan || /scan-(\d{3}|timeout|network|error|wrap)/.test(r.scanLine ?? ""))
    passPenaltyAt.push(k.stats.prescreenUnresolvedRows > unresolved0)
    earlyStopAt.push(r.executed.length >= MAX_BATCH || coin(seed, 0, cycle, 0.05))
    // 1 + 2
    assert.ok(r.executed.length <= MAX_BATCH, `seed ${seed} cycle ${cycle}: ${r.executed.length} executions`)
    for (const id of r.executed) {
      assert.notEqual(persona.get(id), "poison", `seed ${seed} cycle ${cycle}: a poisoned row executed`)
      if (persona.get(id) === "dca") continue
      assert.equal(executedOnce.has(id), false, `seed ${seed} cycle ${cycle}: order …${id.slice(-6)} executed twice`)
      executedOnce.add(id)
    }
    executions += r.executed.length
    // 5 + 6 (status)
    for (const q of r.requests) {
      if (q.method !== "PATCH") continue
      const m = /[?&]id=eq\.([0-9a-f-]{36})/.exec(q.search)
      if (!m) continue
      patchesChecked++
      const row = db.table.find((x) => x.id === m[1])
      const last = said.get(m[1])
      const expired = row && Number(row.expiry) < Math.floor(Date.now() / 1000) // the fixture's expiry 1000 is long past
      assert.ok(last === "true" || last === "unanswered" || last === undefined || expired, `seed ${seed} cycle ${cycle}: row …${m[1].slice(-6)} written although the pre-screen said ${last}`)
      if (inQuarantine.has(m[1])) {
        quarantineChecks++
        assert.ok(expired, `seed ${seed} cycle ${cycle}: quarantined row …${m[1].slice(-6)} written although not expired`)
      }
    }
    // 6 (rate)
    for (const [id] of k.rowQuarantine__opt.snapshot()) if (!quarantinedSince.has(id)) quarantinedSince.set(id, cycle)
    for (const s of chain.singleCalls.slice(singles0)) {
      if (!inQuarantine.has(s.id)) continue
      const list = aloneAt.get(s.id) ?? []
      if (list.length) assert.ok(cycle - list[list.length - 1] >= 30, `seed ${seed}: quarantined row …${s.id.slice(-6)} asked alone at minutes ${list.at(-1)} and ${cycle}`)
      list.push(cycle)
      aloneAt.set(s.id, list)
    }
  }
  // 3 + 4
  const { checked } = checkScreenBound({ presentAt, countAt, askedAt, fallbackAt, passPenaltyAt, scan, label: `seed ${seed} (scan ${scan})` })
  // Ready rows: ready-once rows that are not expired (an expired row is marked `expired` by the path, never asked).
  const isReady = (id) => persona.get(id) === "ready-once" && db.table.find((x) => x.id === id)?.expiry !== "1000"
  const ready = presentAt.map((ids) => new Set([...ids].filter(isReady)))
  const { checked: attemptChecks } = checkScreenBound({ presentAt: ready, countAt, askedAt: attemptedAt, fallbackAt, passPenaltyAt, extraAt: earlyStopAt, scan, label: `seed ${seed} (scan ${scan}) ready rows`, what: "attempted by the path" })
  const reasks = [...aloneAt.values()].reduce((s, l) => s + l.length, 0)
  return { checked, attemptChecks, executions, patchesChecked, quarantineChecks, fallbacks: fallbackAt.filter(Boolean).length, penalties: passPenaltyAt.filter(Boolean).length, quarantined: quarantinedSince.size, reasks, scan }
}

test("seeded: no double execution, <= MAX_BATCH per cycle, every healthy row asked (and every ready row attempted) within the stated bound, the pre-screen writes nothing, quarantine at most once per 30 min and never a status", async () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => 0x7e57 + i * 104_729)
  const total = { checked: 0, attemptChecks: 0, executions: 0, patchesChecked: 0, quarantineChecks: 0, fallbacks: 0, penalties: 0, quarantined: 0, reasks: 0 }
  for (const seed of SEEDS) {
    const r = await run(seed)
    for (const key of Object.keys(total)) total[key] += r[key]
  }
  assert.ok(total.checked > 20_000, `${total.checked} bound checks`)
  assert.ok(total.attemptChecks > 200, `${total.attemptChecks} ready-row attempt checks`)
  assert.ok(total.executions > 100, `${total.executions} executions`)
  assert.ok(total.patchesChecked > 500, `${total.patchesChecked} row writes checked`)
  assert.ok(total.fallbacks > 10, `${total.fallbacks} fallback cycles`)
  assert.ok(total.quarantined > 50, `${total.quarantined} rows quarantined`)
  assert.ok(total.reasks > 20, `${total.reasks} re-asks of quarantined rows`)
  // eslint-disable-next-line no-console
  console.log(
    `  active-scan property: ${SEEDS.length} seeds × 80 cycles, ${total.checked} bound checks, ${total.attemptChecks} ready-row attempt checks, ${total.executions} executions, ` +
      `${total.patchesChecked} row writes checked (${total.quarantineChecks} to quarantined rows), ${total.fallbacks} fallback cycles, ${total.penalties} unresolved-pre-screen cycles, ` +
      `${total.quarantined} rows quarantined, ${total.reasks} alone-asks while quarantined`,
  )
})
