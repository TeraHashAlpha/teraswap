// [A91 R2-4] Hand-run measurement (not a node:test file): the worst gap between two screenings of a row when the
// keeper restarts every cycle or every 2 cycles (a crash loop), against no restart. Each restart is a fresh module
// instance of the SHIPPED executor.js (in-memory state lost; S-8: a fresh process with M > SCAN_CAP starts at a random
// page). Gap = for every row and every start cycle s, the cycles until the row is next asked canExecute.
//
//   node contracts/order-engine/executor/active-scan-restart.measure.mjs [--cycles 60] [--seeds 5]

import { createFakePostgrest, createFakeChain, makeRow, mulberry32 } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle } from "./active-scan.testlib.mjs"

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const CYCLES = Number(args.cycles ?? 60)
const SEEDS = Number(args.seeds ?? 5)
process.setMaxListeners(0)

async function worstGap(M, every, seed) {
  const rand = mulberry32(seed)
  const rows = Array.from({ length: M }, (_, i) => makeRow(i + 1))
  const db = createFakePostgrest(rows)
  const chain = createFakeChain(db, () => [false, "Price below floor"])
  const askedAt = new Map()
  let k = null
  for (let c = 0; c < CYCLES; c++) {
    if (k === null || (every > 0 && c % every === 0)) k = await loadKeeper()
    const r = await runCycle(k, db, chain, c, { random: rand })
    for (const id of new Set(r.asked)) (askedAt.get(id) ?? askedAt.set(id, []).get(id)).push(c)
  }
  let worst = 0
  const horizon = 20
  for (const row of rows) {
    const list = askedAt.get(row.id) ?? []
    for (let s = 0; s < CYCLES - horizon; s++) {
      const next = list.find((c) => c >= s)
      worst = Math.max(worst, next === undefined ? CYCLES - s : next - s + 1)
    }
  }
  return worst
}

for (const M of [1500, 2500]) {
  for (const every of [0, 1, 2]) {
    const out = []
    for (let s = 0; s < SEEDS; s++) out.push(await worstGap(M, every, 0x5e57a + s * 104_729 + M))
    console.log(`M=${M} (ceil(M/1000) = ${Math.ceil(M / 1000)}), ${every === 0 ? "no restart" : `a restart every ${every} cycle(s)`}: worst gap ${Math.max(...out)} cycles (per seed ${out.join(",")})`)
  }
}
