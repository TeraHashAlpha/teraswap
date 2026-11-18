/**
 * [fix/orders-server-side-order-hash, audit 2026-11-16 S-5] Read-only check of stored order hashes.
 *
 *   node --no-warnings scripts/orders/check-order-hashes.ts < rows.json
 *
 * stdin: a JSON array of `orders` rows (at least id, chain_id, order_hash, order_data), e.g. a
 * PostgREST `select=id,chain_id,order_hash,order_data` export.
 * stdout: one JSON line per row whose stored order_hash differs from the hash computed from its
 * order_data with the server function (src/lib/order-engine/order-hash.ts), nothing else.
 * stderr: one line per row that cannot be computed, then a summary.
 * Exit: 0 every row matches · 1 at least one row differs or cannot be computed · 2 unreadable input.
 *
 * Reads stdin only. No network, no database, no environment, no writes: rows found here are for the
 * owner to decide on (this change deliberately ships no migration and no backfill).
 */
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { checkRows } from './check-order-hashes-lib.ts'

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

const input = await readStdin()
let verdicts
try {
  verdicts = checkRows(JSON.parse(input))
} catch (err) {
  console.error(`check-order-hashes: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
}

let differs = 0
let uncomputable = 0
for (const v of verdicts) {
  if (v.verdict === 'differs') {
    differs++
    console.log(JSON.stringify({ id: v.id, chain_id: v.chain_id, stored: v.stored, computed: v.computed, version: v.version }))
  } else if (v.verdict === 'uncomputable') {
    uncomputable++
    console.error(`uncomputable ${JSON.stringify({ id: v.id, chain_id: v.chain_id, stored: v.stored, reason: v.reason })}`)
  }
}
console.error(`checked ${verdicts.length} rows: ${verdicts.length - differs - uncomputable} match, ${differs} differ, ${uncomputable} uncomputable`)
process.exit(differs > 0 || uncomputable > 0 ? 1 : 0)
