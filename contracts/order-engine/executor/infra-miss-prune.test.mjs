// [A73b S-9] The in-memory infra streak (executor.js orderInfraMisses, A73 S-1) must not leak or
// outlive its order:
//   - the EXPIRY pre-filter (executor.js "Check if expired") records 'expired' and `continue`s without
//     the failure handler — it dropped orderRetries + quorumSkips but not the infra streak;
//   - a CANCELLED (or filled / failed elsewhere) order simply stops appearing in fetchActiveOrders —
//     the keeper has no cancel path of its own — so every cycle prunes the ids absent from the
//     active set it just fetched.
//
// Pure: imports retry-policy.js + reads executor.js as text (it auto-runs main() on import).
// Run: node --test contracts/order-engine/executor/infra-miss-prune.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { recordInfraMiss, clearInfraMisses, pruneInfraMisses } from "./retry-policy.js"

const T0 = Date.parse("2026-11-05T10:00:00.000Z")
const seed = (ids) => {
  const map = new Map()
  for (const id of ids) recordInfraMiss(map, id, { reason: "rpc-transport", nowMs: T0 })
  return map
}

describe("pruneInfraMisses — drop the streaks of orders that left the active set", () => {
  test("ids absent from the active set are dropped; present ones keep their streak", () => {
    const map = seed(["a", "b", "c"])
    recordInfraMiss(map, "b", { reason: "rpc-transport", nowMs: T0 + 30_000 })
    const pruned = pruneInfraMisses(map, ["b", "c", "d"])
    assert.equal(pruned, 1)
    assert.deepEqual([...map.keys()].sort(), ["b", "c"])
    assert.equal(map.get("b").streak, 2)
  })
  test("an EMPTY active set leaves the map untouched (fetchActiveOrders also returns [] on a Supabase error; a stale entry is bounded by the last active set and dropped on the next non-empty fetch)", () => {
    const map = seed(["a", "b"])
    assert.equal(pruneInfraMisses(map, []), 0)
    assert.equal(map.size, 2)
  })
  test("tolerant of a missing / non-iterable active set and of an empty map", () => {
    const map = seed(["a"])
    assert.equal(pruneInfraMisses(map, null), 0)
    assert.equal(pruneInfraMisses(map, undefined), 0)
    assert.equal(map.size, 1)
    assert.equal(pruneInfraMisses(new Map(), ["a"]), 0)
  })
  test("ids are compared as strings (a row id is a uuid string; a Set or an array both work)", () => {
    const map = seed(["11111111-aaaa", "22222222-bbbb"])
    assert.equal(pruneInfraMisses(map, new Set(["11111111-aaaa"])), 1)
    assert.deepEqual([...map.keys()], ["11111111-aaaa"])
  })
  test("clearInfraMisses + prune together: an expired order's streak is gone even if it is still in the fetched set this cycle", () => {
    const map = seed(["x", "y"])
    clearInfraMisses(map, "x")
    pruneInfraMisses(map, ["x", "y"])
    assert.deepEqual([...map.keys()], ["y"])
  })
})

describe("executor.js wiring (source anchors — executor.js cannot be imported)", () => {
  const src = readFileSync(new URL("./executor.js", import.meta.url), "utf8")
  const lines = src.split("\n")
  const lineOf = (needle, from = 0) => lines.findIndex((l, i) => i >= from && l.includes(needle))

  test("pruneInfraMisses is imported from retry-policy.js", () => {
    const start = src.indexOf('from "./retry-policy.js"')
    const importBlock = src.slice(src.lastIndexOf("import {", start), start)
    assert.ok(importBlock.includes("pruneInfraMisses"), "executor.js must import pruneInfraMisses from ./retry-policy.js")
  })
  test("the expiry pre-filter clears the order's infra streak next to orderRetries / quorumSkips", () => {
    const at = lineOf('await updateOrderStatus(dbOrder.id, "expired")')
    assert.ok(at > 0, "expiry pre-filter not found")
    const window = lines.slice(at, at + 6).join("\n")
    assert.ok(window.includes("orderRetries.delete(dbOrder.id)"), window)
    assert.ok(window.includes("clearInfraMisses(orderInfraMisses, dbOrder.id)"), `expiry branch must clearInfraMisses:\n${window}`)
    assert.ok(window.includes("continue"), window)
  })
  test("every cycle prunes orderInfraMisses to the ids fetchActiveOrders just returned, before the order loop", () => {
    const fetched = lineOf("const orders = await fetchActiveOrders()")
    assert.ok(fetched > 0, "cycle fetch not found")
    const loop = lineOf("for (const dbOrder of orders)", fetched)
    assert.ok(loop > fetched, "order loop not found after the fetch")
    const prune = lineOf("pruneInfraMisses(orderInfraMisses,", fetched)
    assert.ok(prune > fetched && prune < loop, `pruneInfraMisses must run between fetchActiveOrders and the order loop (fetch@${fetched + 1}, prune@${prune + 1}, loop@${loop + 1})`)
    assert.match(lines[prune], /orders\.map\(\(o\) => o\.id\)|orders\.map\(o => o\.id\)/)
  })
})
