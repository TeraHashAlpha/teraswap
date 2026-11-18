// Hand-run generator (not a test): writes contracts/order-engine/test/PrescreenBisectReplay.sol from the shipped
// executor.js (see prescreen-bisect.replay.mjs). Re-run it whenever the bisect changes, then run the Foundry test:
//
//   node contracts/order-engine/executor/prescreen-bisect.replay.gen.mjs
//   (cd contracts/order-engine && forge test --match-path test/PrescreenBisect.t.sol -vv)

import { writeFileSync } from "node:fs"

import { scenarios, runScenario, renderSolidity } from "./prescreen-bisect.replay.mjs"

process.setMaxListeners(0)
const recorded = []
for (const s of scenarios()) {
  const r = await runScenario(s)
  recorded.push({ ...s, calls: r.calls })
  console.log(`${s.name}: ${r.calls.length} call(s) (${r.calls.filter((c) => c.type === "alone").length} alone), quarantined [${r.quarantined}], answered ${r.answered.length}`)
}
const file = new URL("../test/PrescreenBisectReplay.sol", import.meta.url)
writeFileSync(file, renderSolidity(recorded))
console.log(`wrote ${file.pathname}`)
