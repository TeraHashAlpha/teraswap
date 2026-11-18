// [A91 R2-2] Hand-run rig (not a node:test file): the DCA freeze read's outcome table, this branch against reference
// executor.js files (origin/main, the audited head). Each row answers the circuit_breaker read one way; the cell says
// whether the DCA row of that cycle was held (FROZEN) or went on to the path's canExecute (passes), and the line logged.
//
//   git show origin/main:contracts/order-engine/executor/executor.js > /tmp/executor.main.js
//   node contracts/order-engine/executor/freeze-read.differential.mjs --ref main=/tmp/executor.main.js [--ref 16fb740c=/tmp/x.js]
//
// The time-limit rows run with the read limit rewritten to 100 ms where the file has one (SUPABASE_READ_TIMEOUT_MS; main
// has none, so main waits); "never answers" is cut by the rig after 2 s and reported as "the cycle hangs".

import { createFakePostgrest, createFakeChain, makeRow } from "./executor-cycle.fixture.mjs"
import { loadKeeper, runCycle, settles } from "./active-scan.testlib.mjs"

const refs = []
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--ref") refs.push(process.argv[++i].split("="))
process.setMaxListeners(0)
const print = console.log.bind(console) // a hung reference cycle never gives console back (withFakes restores it on exit)

const OUTCOMES = [
  ["answer frozen=false", { body: '[{"frozen":false,"reason":null}]' }],
  ["answer frozen=true", { body: '[{"frozen":true,"reason":"maintenance"}]' }],
  ["HTTP 503", { status: 503, body: "upstream" }],
  ["HTTP 404 (no table)", { status: 404, body: '{"code":"PGRST205"}' }],
  ["network error", "throw"],
  ["body not JSON", { body: "<html>" }],
  ["body not a list", { body: '{"frozen":false}' }],
  ["frozen not a boolean", { body: '[{"frozen":"false"}]' }],
  ["no dca row (empty list)", { body: "[]" }],
  ["slow: 300 ms, frozen=false (limit 100 ms)", { body: '[{"frozen":false}]', delayMs: 300 }],
  ["slow: 300 ms, frozen=true (limit 100 ms)", { body: '[{"frozen":true}]', delayMs: 300 }],
  ["never answers", "hang"],
]

async function cell(sourceFile, spec) {
  const k = await loadKeeper({ ...(sourceFile ? { sourceFile } : {}), constants: { SUPABASE_READ_TIMEOUT_MS: 100 } })
  const dca = makeRow(1, { type: "dca" })
  const db = createFakePostgrest([dca, makeRow(2, { pinned: true })])
  db.setFreeze(spec)
  const chain = createFakeChain(db, () => [true, ""], { wallet: true, account: true })
  try {
    const r = await settles(runCycle(k, db, chain, 0), 2_000, "cycle")
    const line = r.lines.find((l) => /freeze read/.test(l))?.replace(/^\[[^\]]+\]\s+WARNING: /, "") ?? "-"
    return `${r.path.includes(dca.id) ? "passes" : "FROZEN"} | ${line.slice(0, 90)}`
  } catch {
    return "the cycle hangs | -"
  }
}

const cols = [["head", null], ...refs]
print(`| freeze read answers | ${cols.map(([n]) => `${n} (DCA row / line)`).join(" | ")} |`)
print(`|---|${cols.map(() => "---").join("|")}|`)
for (const [label, spec] of OUTCOMES) {
  const cells = []
  for (const [, file] of cols) cells.push(await cell(file, spec))
  print(`| ${label} | ${cells.join(" | ")} |`)
}
process.exit(0) // a hung reference cycle keeps its timers alive
