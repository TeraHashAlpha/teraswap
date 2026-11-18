// [A91 R2-1 / design 120c §6] Hand-run measurement (not a node:test file): the bisect against P poisoned (gas-burning)
// rows among M, on the SHIPPED cycle (executor-cycle.fixture.mjs; gas model at a 50,000,000 eth_call cap). Per
// configuration and seed it reports the bisect calls per cycle, the rows quarantined per cycle, the cycles until no
// chunk fails, and the WORST DELAY of a healthy row: over every healthy row and every start cycle s, how many cycles
// pass from s until the keeper next gets an answer for it (an answered pre-screen call, or the path asking it) — the
// delay of a row that becomes ready at s.
//
//   node contracts/order-engine/executor/active-scan-poison.measure.mjs [--cycles 40] [--seeds 5] [--configs 600x24,1000x200]

import { createFakePostgrest, createFakeChain, makeRow, mulberry32 } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle } from "./active-scan.testlib.mjs"

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const CYCLES = Number(args.cycles ?? 40)
const SEEDS = Number(args.seeds ?? 5)
const CONFIGS = (args.configs ?? "600x24,1000x24,1200x24,600x200,1000x200,1200x200").split(",").map((s) => s.split("x").map(Number))
process.setMaxListeners(0)

async function measure(M, P, seed) {
  const k = await loadKeeper()
  const rand = mulberry32(seed)
  const rows = Array.from({ length: M }, (_, i) => makeRow(i + 1))
  const burners = new Set()
  while (burners.size < P) burners.add(rows[Math.floor(rand() * M)].id)
  const db = createFakePostgrest(rows)
  const chain = createFakeChain(db, (row) => (burners.has(row.id) ? { burn: true } : [false, "Price below floor"]))
  const answeredAt = new Map() // healthy id -> cycles it got an answer
  const per = []
  for (let c = 0; c < CYCLES; c++) {
    const d0 = chain.delivered.length
    const p0 = chain.pathCalls.length
    const b0 = k.stats.bisectCalls ?? 0
    const q0 = k.stats.quarantinedRows ?? 0
    const r = await runCycle(k, db, chain, c, { random: rand })
    const got = new Set([...chain.delivered.slice(d0).filter((x) => x.result !== "unanswered").map((x) => x.id), ...chain.pathCalls.slice(p0)])
    for (const id of got) if (!burners.has(id)) (answeredAt.get(id) ?? answeredAt.set(id, []).get(id)).push(c)
    per.push({ bisect: (k.stats.bisectCalls ?? 0) - b0, quarantined: k.stats.quarantinedRows ?? 0, newlyQuarantined: (k.stats.quarantinedRows ?? 0) - q0, failed: /prescreen-(\d+)of/.exec(r.scanLine ?? "")?.[1] ?? "0" })
  }
  // Worst delay over start cycles s in [0, CYCLES - horizon): the next answer at or after s.
  const horizon = Math.ceil(M / 1000) + 2
  let worst = 0
  for (const row of rows) {
    if (burners.has(row.id)) continue
    const list = answeredAt.get(row.id) ?? []
    for (let s = 0; s < CYCLES - horizon; s++) {
      const next = list.find((c) => c >= s)
      worst = Math.max(worst, next === undefined ? CYCLES - s : next - s)
    }
  }
  const lastFail = per.map((x) => Number(x.failed)).lastIndexOf(per.map((x) => Number(x.failed)).find((f) => f > 0) ?? -1)
  const settled = per.findIndex((x, i) => i > 0 && per.slice(i).every((y) => y.failed === "0"))
  return { worst, settled, maxBisect: Math.max(...per.map((x) => x.bisect)), quarantined: per.at(-1).quarantined, perCycleQ: per.slice(0, 6).map((x) => x.newlyQuarantined).join("/"), lastFail }
}

for (const [M, P] of CONFIGS) {
  const out = []
  for (let s = 0; s < SEEDS; s++) out.push(await measure(M, P, 0xb15ec7 + s * 7919 + M + P))
  const worst = Math.max(...out.map((o) => o.worst))
  console.log(
    `M=${M} P=${P}: worst healthy-row delay ${worst} cycle(s) (per seed ${out.map((o) => o.worst).join(",")}); ` +
      `no chunk fails from cycle ${out.map((o) => (o.settled < 0 ? "never" : o.settled)).join(",")}; ` +
      `max bisect calls/cycle ${Math.max(...out.map((o) => o.maxBisect))}; quarantined at the end ${out.map((o) => o.quarantined).join(",")}; ` +
      `newly quarantined in cycles 0-5 (seed 1) ${out[0].perCycleQ}`,
  )
}
