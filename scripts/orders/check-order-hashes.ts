/**
 * [fix/orders-server-side-order-hash, audit 2026-11-16 S-5] Read-only check of stored order hashes.
 *
 *   node --no-warnings scripts/orders/check-order-hashes.ts < rows.json
 *
 * stdin: a JSON array of `orders` rows (id, chain_id, order_hash, order_data, signature), e.g. a PostgREST
 * `select=id,chain_id,order_hash,order_data,signature` export. The signature is read to group rows; it is never
 * printed.
 * stdout: one JSON line per finding, nothing else:
 *   {"verdict":"differs",…}        the stored order_hash is not the hash computed from the row's order_data
 *   {"verdict":"non-canonical",…}  [A86 S-2] it names that hash but is not byte-equal to it (upper case, 0X, no 0x):
 *                                  UNIQUE(order_hash) compares bytes, so such a row does not stop a second one
 *   {"group":"same-computed-hash","computed":…,"ids":[…]}  two or more rows hold one order
 *   {"group":"same-signature","ids":[…]}                   two or more rows hold one signature (any of its 4 texts)
 * stderr: one line per row that cannot be computed or has no signature, then a summary.
 * Exit: 0 at least one row, every row byte-equal, no group, every row signed · 1 anything else, including an empty
 * array [A86 S-8] · 2 unreadable input.
 *
 * A stored text is printed only when it has the shape of a hash or a UUID, otherwise as `<string len N>`; as a last
 * guard every printed line has any run of 130+ hex characters replaced.
 *
 * Reads stdin only. No network, no database, no environment, no writes: rows found here are for the
 * owner to decide on (this change deliberately ships no migration and no backfill).
 */
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { checkRows, groupRows, safeText } from './check-order-hashes-lib.ts'

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

/** Never a signature on screen, whatever slipped through: a 65-byte signature is 130 hex characters. */
const redact = (line: string) => line.replace(/(?:0[xX])?[0-9a-fA-F]{130,}/g, (m) => `<redacted len ${m.length}>`)
const out = (o: unknown) => console.log(redact(JSON.stringify(o)))
const err = (s: string) => console.error(redact(s))

const input = await readStdin()
let rows: unknown[]
let verdicts
try {
  const parsed = JSON.parse(input)
  verdicts = checkRows(parsed)
  rows = parsed
} catch (e) {
  err(`check-order-hashes: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
}

const count = { match: 0, 'non-canonical': 0, differs: 0, uncomputable: 0 }
for (const v of verdicts) {
  count[v.verdict]++
  if (v.verdict === 'differs') {
    out({ verdict: 'differs', id: v.id, chain_id: v.chain_id, stored: safeText(v.stored), computed: v.computed, version: v.version })
  } else if (v.verdict === 'non-canonical') {
    out({ verdict: 'non-canonical', id: v.id, chain_id: v.chain_id, stored: safeText(v.stored), computed: v.computed })
  } else if (v.verdict === 'uncomputable') {
    err(`uncomputable ${JSON.stringify({ id: v.id, chain_id: v.chain_id, stored: safeText(v.stored), reason: v.reason })}`)
  }
}
const groups = groupRows(rows, verdicts)
for (const g of groups.sameComputedHash) out({ group: 'same-computed-hash', computed: g.computed, ids: g.ids })
for (const g of groups.sameSignature) out({ group: 'same-signature', ids: g.ids })
for (const id of groups.withoutSignature) err(`no-signature ${JSON.stringify({ id })}`)

if (verdicts.length === 0) err('check-order-hashes: 0 rows: an empty export proves nothing')
err(
  `checked ${verdicts.length} rows: ${count.match} match, ${count['non-canonical']} non-canonical, ${count.differs} differ, ` +
  `${count.uncomputable} uncomputable, ${groups.withoutSignature.length} without signature; ` +
  `${groups.sameComputedHash.length} same-computed-hash groups, ${groups.sameSignature.length} same-signature groups`,
)
const clean = verdicts.length > 0 && count.match === verdicts.length &&
  groups.sameComputedHash.length === 0 && groups.sameSignature.length === 0 && groups.withoutSignature.length === 0
process.exit(clean ? 0 : 1)
