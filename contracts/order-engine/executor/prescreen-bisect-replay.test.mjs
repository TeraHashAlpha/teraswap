// [A91 R2-1 / design 120c "Tests that must exist"] The keeper side of the bisect replay (prescreen-bisect.replay.mjs):
// the SHIPPED executor.js, run with every Multicall3 call and alone-ask answered FROM test/PrescreenBisectReplay.sol —
// the outcomes PrescreenBisect.t.sol checks on the real Multicall3 runtime code and the real V3 executor — must make
// exactly the recorded calls, quarantine the gas-burning rows (1 burner: its chunk answers, only its own call fails),
// and answer every healthy row in that cycle. A change to the bisect fails here until the recording is regenerated
// (prescreen-bisect.replay.gen.mjs) and the Foundry replay passes again.
//
// Run: node --test contracts/order-engine/executor/prescreen-bisect-replay.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { parseSolidity, runScenario, KIND } from "./prescreen-bisect.replay.mjs"

const SOL = readFileSync(new URL("../test/PrescreenBisectReplay.sol", import.meta.url), "utf8")
const recorded = parseSolidity(SOL)

test("the recording holds the four scenarios the design names (1, 2 and 10 burners in one 50-row chunk; caps 50M and 550M)", () => {
  assert.deepEqual(recorded.map((r) => [r.name, r.cap, r.kinds.length, r.kinds.filter((k) => k >= KIND.BURN_TOKEN).length]), [
    ["one burner, cap 50M", 50_000_000, 50, 1],
    ["two burners, cap 50M", 50_000_000, 50, 2],
    ["ten burners, cap 50M", 50_000_000, 50, 10],
    ["ten burners, cap 550M", 550_000_000, 50, 10],
  ])
})

for (const sc of recorded) {
  test(`${sc.name}: the shipped keeper makes exactly the ${sc.calls.length} recorded call(s), isolates the burners and answers every healthy row in that cycle`, async () => {
    const r = await runScenario(sc, { replay: sc.calls })
    const burners = sc.kinds.flatMap((k, i) => (k >= KIND.BURN_TOKEN ? [i] : []))
    const healthy = sc.kinds.flatMap((k, i) => (k < KIND.BURN_TOKEN ? [i] : []))
    assert.deepEqual(r.answered, healthy, "every healthy row answered by the pre-screen")
    if (burners.length === 1) {
      assert.deepEqual(r.quarantined, [], "one burner never fails its chunk: only its own call fails (the one-by-one budget's)")
      assert.equal(sc.calls.length, 1)
    } else {
      assert.deepEqual(r.quarantined, burners, "the burners, quarantined")
    }
    for (const s of r.chain.singleCalls) assert.equal(s.gas, 3_000_000n)
    assert.ok(sc.calls.length - 1 <= 40, "within the 40-call bisect budget")
    assert.equal(r.chain.pathCalls.filter((id) => burners.includes(r.rows.findIndex((x) => x.id === id)) && burners.length > 1).length, 0, "a quarantined burner is never walked")
  })
}
