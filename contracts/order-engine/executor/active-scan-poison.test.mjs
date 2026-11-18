// [A91 R2-1 / design 120c] The round-2 audit's poisoned-row scenarios as tests of the SHIPPED cycle
// (executor-cycle.fixture.mjs). A "burner" row's canExecute burns all the gas it is given — what a hostile
// tokenIn.balanceOf or priceFeed.latestRoundData does; order creation accepts such a token (the audit, R2-1).
// Inside Multicall3 the fate of a call comes from multicallGasModel (calibrated in Foundry on the real Multicall3
// bytecode and the V3 executor) at an eth_call cap of 50,000,000 (geth's RPCGasCap).
//
// Each test FAILED on the audited head 16fb740c (round 2: a failed chunk HELD the scan; the output is in the
// round-3 tables file).
//
//   1. 1200 rows, two burners fail the same chunk every cycle: rows #300, #350, #420, ready from cycle 10,
//      execute within ceil(1200 / 1000) = 2 cycles (16fb740c: the scan holds at that chunk; ~200 rows are
//      never asked again, those three included).
//   2. 24 burners among 600 and among 1000 rows (two in each of the first 12 chunks): a ready row in the last
//      poisoned chunk executes within ceil(M / 1000) + ceil(7 * 24 / 40) = 6 cycles — isolating P burners costs
//      at most 7P calls of the 40-call bisect budget (active-window.js bisectFailedChunks); 16fb740c delayed it
//      19 and 67 cycles.
//
// Run: node --test contracts/order-engine/executor/active-scan-poison.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { createFakePostgrest, createFakeChain, makeRow, mulberry32 } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle } from "./active-scan.testlib.mjs"

const SCAN = 1000
const BISECT = 40
const rowsOf = (n, from = 1, opts = {}) => Array.from({ length: n }, (_, i) => makeRow(from + i, opts))

describe("[A91 R2-1] two burners fail the same chunk every cycle (1200 rows, rotating)", () => {
  test("rows #300, #350 and #420, ready from cycle 10, execute within ceil(1200/1000) = 2 cycles; the burners are quarantined, never executed", async () => {
    const k = await loadKeeper()
    const rows = rowsOf(1200, 1, { pinned: true })
    const db = createFakePostgrest(rows)
    const burners = new Set([rows[479].id, rows[480].id]) // #480 and #481: one chunk on every page alignment but one
    const targets = [299, 349, 419].map((i) => rows[i].id)
    let cycle = 0
    const chain = createFakeChain(
      db,
      (row) => (burners.has(row.id) ? { burn: true } : cycle >= 10 && targets.includes(row.id) ? [true, ""] : [false, "Price below floor"]),
      { wallet: true },
    )
    const random = mulberry32(1200)
    const executedAt = new Map()
    const lines = []
    for (cycle = 0; cycle < 12; cycle++) {
      const r = await runCycle(k, db, chain, cycle, { random })
      lines.push(r.scanLine)
      for (const id of r.executed) executedAt.set(id, cycle)
    }
    for (const [n, id] of [[300, targets[0]], [350, targets[1]], [420, targets[2]]]) {
      const at = executedAt.get(id)
      assert.ok(at !== undefined && at >= 10 && at < 10 + Math.ceil(1200 / SCAN), `row #${n} ready from cycle 10 executed at cycle ${at ?? "never (within 12 cycles)"}; lines:\n${lines.slice(8).join("\n")}`)
    }
    for (const id of burners) assert.equal(executedAt.has(id), false, "a burner is never executed")
    assert.equal(db.table.filter((r) => burners.has(r.id) && r.status !== "active").length, 0, "quarantine never changes a status")
  })
})

describe("[A91 R2-1] 24 burners among 600 and 1000 rows: a ready row in a poisoned chunk executes on time", () => {
  for (const total of [600, 1000]) {
    test(`${total} rows, two burners in each of the first 12 chunks: the ready row #591 executes within ceil(${total}/1000) + ceil(7*24/40) = ${Math.ceil(total / SCAN) + Math.ceil((7 * 24) / BISECT)} cycles`, async () => {
      const k = await loadKeeper()
      const rows = rowsOf(total, 1, { pinned: true })
      const db = createFakePostgrest(rows)
      const burners = new Set(Array.from({ length: 24 }, (_, j) => rows[12 + 25 * j].id))
      const ready = rows[590].id
      const chain = createFakeChain(db, (row) => (burners.has(row.id) ? { burn: true } : row.id === ready ? [true, ""] : [false, "Price below floor"]), { wallet: true })
      const bound = Math.ceil(total / SCAN) + Math.ceil((7 * burners.size) / BISECT)
      let executedAt = null
      const lines = []
      for (let c = 0; c < bound && executedAt === null; c++) {
        const r = await runCycle(k, db, chain, c)
        lines.push(r.scanLine)
        if (r.executed.includes(ready)) executedAt = c
      }
      assert.ok(executedAt !== null, `the ready row #591 was not executed within ${bound} cycles; lines:\n${lines.join("\n")}`)
      assert.equal(chain.executions.filter((id) => burners.has(id)).length, 0, "a burner is never executed")
    })
  }
})
