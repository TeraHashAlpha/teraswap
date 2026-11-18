// [A91 R2-1 / design 120c "Tests that must exist"] The keeper's bisect against the REAL Multicall3 bytecode and the V3
// executor. Shared by the hand-run generator (prescreen-bisect.replay.gen.mjs) and the keeper test
// (prescreen-bisect-replay.test.mjs); the Foundry side is contracts/order-engine/test/PrescreenBisect.t.sol.
//
//   1. The generator runs ONE shipped pre-screen cycle (executor-cycle.fixture.mjs) over a 50-row chunk with 1, 2 or 10
//      gas-burning rows, the fate of every Multicall3 call coming from the calibrated gas model, and writes the exact
//      calls the keeper made — row indices, whether the call answered, each row's success — to
//      test/PrescreenBisectReplay.sol.
//   2. PrescreenBisect.t.sol replays every recorded call in the EVM (real Multicall3 runtime code, the real
//      TeraSwapOrderExecutorV3, real signed orders, the same eth_call gas cap) and asserts each outcome.
//   3. prescreen-bisect-replay.test.mjs runs the shipped keeper again with every outcome taken FROM that file: the keeper
//      must make exactly the recorded calls, isolate the burners, and answer every healthy row in that cycle.
// Together: on the real EVM the keeper's bisect makes these calls, gets these answers, and isolates these rows.
//
// Row kinds (one byte each, the same in Solidity): 0 DCA (true), 1 LIMIT (true), 2 STOP_LOSS (true), 3 LIMIT (false:
// price below target), 4 burner token (DCA whose tokenIn.balanceOf burns all gas), 5 burner feed (LIMIT whose
// priceFeed.latestRoundData burns all gas).
// Call record bytes: [type 0 = aggregate3, 1 = alone][n][n row indices][ok 0/1] then, for an aggregate3 that answered,
// n result bytes (0 = that row's call failed, 1 = answered false, 2 = answered true).

import { createFakePostgrest, createFakeChain, makeRow, mulberry32 } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle } from "./active-scan.testlib.mjs"

export const V3_EXECUTOR = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
export const KIND = { DCA: 0, LIMIT: 1, STOP: 2, LIMIT_FALSE: 3, BURN_TOKEN: 4, BURN_FEED: 5 }
const isBurner = (k) => k === KIND.BURN_TOKEN || k === KIND.BURN_FEED

/** The scenarios the design names: 1, 2 and 10 gas-burning rows in one 50-row chunk. */
export function scenarios() {
  const healthy = (i) => [KIND.DCA, KIND.LIMIT, KIND.STOP, KIND.LIMIT_FALSE][i % 4]
  const kinds = (burners) => Array.from({ length: 50 }, (_, i) => (burners.includes(i) ? (i % 2 ? KIND.BURN_FEED : KIND.BURN_TOKEN) : healthy(i)))
  const ten = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45]
  return [
    { name: "one burner, cap 50M", cap: 50_000_000, kinds: kinds([17]) },
    { name: "two burners, cap 50M", cap: 50_000_000, kinds: kinds([3, 41]) },
    { name: "ten burners, cap 50M", cap: 50_000_000, kinds: kinds(ten) },
    { name: "ten burners, cap 550M", cap: 550_000_000, kinds: kinds(ten) },
  ]
}

/** Rows (V3 orders) for a scenario, in scan order; row i is makeRow(i + 1). */
function rowsFor(kinds) {
  return kinds.map((k, i) => {
    const type = k === KIND.DCA || k === KIND.BURN_TOKEN ? "dca" : "limit"
    const r = makeRow(i + 1, { type, pinned: type !== "dca" })
    r.order_data.maxSlippageBps = 100
    if (k === KIND.STOP) r.order_data.orderType = 1
    return r
  })
}

const answerOf = (k) => (isBurner(k) ? { burn: true } : k === KIND.LIMIT_FALSE ? [false, "Price below target"] : [true, ""])

/**
 * One shipped pre-screen cycle over the scenario. `replay` (optional) supplies every call's outcome from a recording;
 * otherwise the calibrated gas model decides. Returns the calls the keeper made, in order, and the cycle's result.
 */
export async function runScenario(s, { replay = null } = {}) {
  const k = await loadKeeper({ env: { ORDER_EXECUTOR_V3_ADDRESS: V3_EXECUTOR }, optionalExports: ["runOneCycleAtATime", "rowQuarantine"] })
  const rows = rowsFor(s.kinds)
  const index = new Map(rows.map((r, i) => [r.id, i]))
  const db = createFakePostgrest(rows)
  const calls = []
  let cursor = 0
  // A call the recording does not hold is a test failure, never an outcome: the keeper would swallow a thrown error
  // (a failure it cannot read leaves the row unresolved), so mismatches are collected and thrown after the cycle.
  const mismatches = []
  const fromRecording = replay
    ? (fakeType, ids) => {
        const type = fakeType === "single" ? "alone" : fakeType // the fake's name for an alone-ask
        const want = replay[cursor++]
        const got = ids.map((id) => index.get(id))
        if (!want || want.type !== type || JSON.stringify(want.rows) !== JSON.stringify(got)) {
          mismatches.push(`call ${cursor - 1}: the keeper asked ${type} [${got}] but the recording has ${want ? `${want.type} [${want.rows}]` : "no more calls"}`)
          return { ok: false, success: [] }
        }
        return { ok: want.ok, success: want.results ? want.results.map((x) => x !== 0) : [] }
      }
    : null
  const chain = createFakeChain(db, (row) => answerOf(s.kinds[index.get(row.id)]), { gasCap: s.cap, replay: fromRecording })
  // Record what the keeper asked and what it got (the fake's own bookkeeping, in order).
  const read = chain.publicClient.readContract.bind(chain.publicClient)
  chain.publicClient.readContract = async (req) => {
    const isAgg = req.functionName === "aggregate3"
    const isAlone = req.functionName === "canExecute" && req.gas !== undefined
    const before = chain.delivered.length
    const aggBefore = chain.aggregateCalls.length
    try {
      const out = await read(req)
      if (isAgg) {
        const ids = chain.aggregateCalls[aggBefore].ids
        const got = new Map(chain.delivered.slice(before).map((d) => [d.id, d.result]))
        calls.push({ type: "aggregate", rows: ids.map((id) => index.get(id)), ok: true, results: ids.map((id) => ({ unanswered: 0, false: 1, true: 2 })[got.get(id)]) })
      } else if (isAlone) {
        calls.push({ type: "alone", rows: [index.get(chain.singleCalls.at(-1).id)], ok: true, gas: req.gas })
      }
      return out
    } catch (err) {
      if (isAgg) calls.push({ type: "aggregate", rows: chain.aggregateCalls[aggBefore].ids.map((id) => index.get(id)), ok: false })
      else if (isAlone) calls.push({ type: "alone", rows: [index.get(chain.singleCalls.at(-1).id)], ok: false, gas: req.gas })
      throw err
    }
  }
  const r = await runCycle(k, db, chain, 0, { random: mulberry32(1) })
  if (mismatches.length) throw new Error(`the keeper's calls differ from the recording:\n${mismatches.join("\n")}`)
  if (replay && cursor !== replay.length) throw new Error(`the keeper made ${cursor} calls; the recording has ${replay.length}`)
  const quarantined = [...k.rowQuarantine__opt.snapshot().keys()].map((id) => index.get(id)).sort((a, b) => a - b)
  const answered = [...new Set(chain.delivered.filter((d) => d.result !== "unanswered").map((d) => index.get(d.id)))].sort((a, b) => a - b)
  return { calls, quarantined, answered, cycle: r, chain, rows }
}

/** The call records as bytes (see the header), hex without 0x. */
export function encodeCalls(calls) {
  const out = []
  for (const c of calls) {
    out.push(c.type === "aggregate" ? 0 : 1, c.rows.length, ...c.rows, c.ok ? 1 : 0)
    if (c.type === "aggregate" && c.ok) out.push(...c.results)
  }
  return Buffer.from(out).toString("hex")
}

/** Parse the call records back (from a hex string). */
export function decodeCalls(hex) {
  const b = Buffer.from(hex, "hex")
  const calls = []
  for (let p = 0; p < b.length; ) {
    const type = b[p++] === 0 ? "aggregate" : "alone"
    const n = b[p++]
    const rows = [...b.subarray(p, p + n)]
    p += n
    const ok = b[p++] === 1
    let results
    if (type === "aggregate" && ok) {
      results = [...b.subarray(p, p + n)]
      p += n
    }
    calls.push({ type, rows, ok, ...(results ? { results } : {}) })
  }
  return calls
}

/** The generated Solidity data file. */
export function renderSolidity(recorded) {
  const lines = [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.20;",
    "",
    "// GENERATED by contracts/order-engine/executor/prescreen-bisect.replay.gen.mjs from the shipped executor.js — do not edit.",
    "// The exact calls the keeper's pre-screen bisect made for each scenario, with the outcome it got (see",
    "// executor/prescreen-bisect.replay.mjs for the byte layout). PrescreenBisect.t.sol replays each call in the EVM; the",
    "// keeper test prescreen-bisect-replay.test.mjs checks the shipped keeper still makes exactly these calls.",
    "",
    "library PrescreenBisectReplay {",
    "    struct Scenario {",
    "        string name;",
    "        uint256 cap;",
    "        bytes kinds;",
    "        bytes calls;",
    "    }",
    "",
    `    function scenarios() internal pure returns (Scenario[] memory s) {`,
    `        s = new Scenario[](${recorded.length});`,
  ]
  recorded.forEach((r, i) => {
    lines.push(`        s[${i}] = Scenario({`)
    lines.push(`            name: "${r.name}",`)
    lines.push(`            cap: ${r.cap},`)
    lines.push(`            kinds: hex"${Buffer.from(r.kinds).toString("hex")}",`)
    lines.push(`            calls: hex"${encodeCalls(r.calls)}"`)
    lines.push(`        });`)
  })
  lines.push("    }", "}", "")
  return lines.join("\n")
}

/** Parse the generated Solidity data file back into { name, cap, kinds, calls }[]. */
export function parseSolidity(text) {
  const re = /name: "([^"]+)",\s*cap: (\d+),\s*kinds: hex"([0-9a-f]*)",\s*calls: hex"([0-9a-f]*)"/g
  const out = []
  for (const m of text.matchAll(re)) out.push({ name: m[1], cap: Number(m[2]), kinds: [...Buffer.from(m[3], "hex")], calls: decodeCalls(m[4]) })
  return out
}
