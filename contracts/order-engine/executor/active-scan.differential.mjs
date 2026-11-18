// [SEC-4 / A88 round 2] Differential rig, run by hand (not a node:test file): for random tables of at most 15
// active rows and no failures, the orders EXECUTED per cycle — and their order — by this branch's executeCycle must
// equal origin/main's. Both are the SHIPPED text, loaded by executor-cycle.fixture.mjs, each against its own copy of
// the same fake world (same rows, same answers per row and cycle, same gas), with a wallet that really executes.
//
//   git show origin/main:contracts/order-engine/executor/executor.js > /tmp/executor.main.js
//   node contracts/order-engine/executor/active-scan.differential.mjs --reference /tmp/executor.main.js --from 0 --to 500
//
// World: limit orders with a pinned route; personas ready-once (true until filled), never, flaky (true on ~35 % of
// cycles, decided per row and cycle), shared-balance (one owner's balance funds one fill: after it, the others say
// "Insufficient balance"), expired (off-chain expiry passed: the path marks it), DCA (true, never fills: no route
// API in the fixture — an infra miss, the same in both). Gas: a SKIP on ~8 % of cycles. Rows are added between cycles
// while the table stays <= 15. No Supabase or RPC failure ("no failures").
//
// Not modelled (documented in the feedback): an execution that makes ANOTHER row ready within the same cycle — the
// pre-screen asked at the start of the cycle, main asks each row as it reaches it.

import assert from "node:assert/strict"

import { createFakePostgrest, createFakeChain, makeRow, mulberry32 } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle } from "./active-scan.testlib.mjs"

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const reference = args.reference
assert.ok(reference, "--reference <origin/main executor.js> is required")
const from = Number(args.from ?? 0)
const to = Number(args.to ?? 500)
const CYCLES = Number(args.cycles ?? 12)
const SEED0 = 0xd1ff
process.setMaxListeners(0) // every loaded executor adds its SIGINT / SIGTERM handlers

function world(seed) {
  const rand = mulberry32(seed)
  const rows = []
  const persona = new Map()
  const owner = new Map()
  let n = 0
  const mk = () => {
    n++
    const r = rand()
    const p = r < 0.25 ? "ready-once" : r < 0.4 ? "never" : r < 0.65 ? "flaky" : r < 0.8 ? "shared-balance" : r < 0.88 ? "expired" : "dca"
    const row = makeRow(n, { type: p === "dca" ? "dca" : "limit", pinned: true, ...(p === "expired" ? { expiry: 1_000 } : {}) })
    if (p === "shared-balance") {
      row.order_data.owner = "0x" + "5".repeat(40)
      owner.set(row.id, "shared")
    }
    persona.set(row.id, p)
    return row
  }
  const initial = 1 + Math.floor(rand() * 15)
  for (let i = 0; i < initial; i++) rows.push(mk())
  const adds = [] // rows to add before each cycle, decided up front so both worlds get the same
  for (let c = 0; c < CYCLES; c++) {
    const list = []
    for (let i = Math.floor(rand() * 3); i > 0; i--) list.push(mk())
    adds.push(list)
  }
  const gasSkip = Array.from({ length: CYCLES }, () => rand() < 0.08)
  const flaky = new Map() // `${id}:${c}` -> bool
  for (const id of persona.keys()) for (let c = 0; c < CYCLES; c++) flaky.set(`${id}:${c}`, rand() < 0.35)
  return { rows, adds, gasSkip, flaky, persona, owner }
}

async function play(source, w) {
  const k = await loadKeeper(source ? { sourceFile: source } : {})
  const db = createFakePostgrest(w.rows)
  let cycle = 0
  let sharedSpent = false
  const chain = createFakeChain(
    db,
    (row) => {
      const p = w.persona.get(row.id)
      if (p === "never" || p === "expired") return [false, "Price below floor"]
      if (p === "flaky") return w.flaky.get(`${row.id}:${cycle}`) ? [true, ""] : [false, "Price below floor"]
      if (p === "shared-balance") return sharedSpent ? [false, "Insufficient balance"] : [true, ""]
      return [true, ""] // ready-once (the fake answers "Nonce used" once it filled), dca
    },
    { wallet: true, gasPriceWei: () => (w.gasSkip[cycle] ? 1_000_000_000n : 10_000_000n) },
  )
  const writeContract = chain.walletClient.writeContract
  chain.walletClient.writeContract = async (req) => {
    const hash = await writeContract(req)
    const id = chain.executions.at(-1)
    if (w.owner.get(id) === "shared") sharedSpent = true
    return hash
  }
  const perCycle = []
  for (cycle = 0; cycle < CYCLES; cycle++) {
    for (const r of w.adds[cycle]) if (db.table.filter((x) => x.status === "active").length < 15) db.insert(r)
    const r = await runCycle(k, db, chain, cycle)
    perCycle.push(r.executed)
  }
  return { perCycle, statuses: db.table.map((r) => `${r.id.slice(-4)}:${r.status}`).join(",") }
}

let mismatches = 0
let executions = 0
let cycles = 0
for (let i = from; i < to; i++) {
  const seed = SEED0 + i * 7919
  const w = world(seed)
  const main = await play(reference, w)
  const branch = await play(null, world(seed))
  cycles += CYCLES
  executions += main.perCycle.flat().length
  for (let c = 0; c < CYCLES; c++) {
    if (JSON.stringify(main.perCycle[c]) !== JSON.stringify(branch.perCycle[c])) {
      mismatches++
      console.log(`MISMATCH run ${i} seed ${seed} cycle ${c}: main [${main.perCycle[c].map((x) => x.slice(-4))}] branch [${branch.perCycle[c].map((x) => x.slice(-4))}]`)
      break
    }
  }
}
console.log(`differential runs ${from}..${to - 1} (seeds ${SEED0} + i*7919): ${to - from} runs, ${cycles} cycles, ${executions} executions by main, ${mismatches} runs with a different executed list`)
process.exitCode = mismatches ? 1 : 0
