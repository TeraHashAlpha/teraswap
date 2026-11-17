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

import { loadShippedExecutor, createFakePostgrest, createFakeChain, makeRow, withFakes } from "./executor-cycle.fixture.mjs"

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

async function runCycles(k, db, chain, cycles) {
  const perCycle = []
  const lines = []
  for (let c = 0; c < cycles; c++) {
    const before = chain.canExecuteCalls.length
    const out = await withFakes(db, () => k.executeCycle(chain.publicClient, null, null, null, null, null))
    lines.push(...out.lines)
    perCycle.push(chain.canExecuteCalls.slice(before))
  }
  return { perCycle, lines }
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
