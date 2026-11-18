/**
 * [fix/orders-server-side-order-hash] Writes contracts/order-engine/test/OrderHashVectors.sol, the
 * expected hashes the Foundry differential compares the executors' own getOrderHash against.
 *
 *   node --no-warnings scripts/orders/gen-order-hash-vectors.ts          (write)
 *   node --no-warnings scripts/orders/gen-order-hash-vectors.ts --check  (exit 1 when the file differs)
 *
 * Pure: no network, no environment. See order-hash-vectors.ts for the derivation.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error TS5097 - Node's native type stripping requires the .ts extension; tsc is noEmit here
import { VECTOR_SETS, renderVectorsSolidity } from './order-hash-vectors.ts'

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/order-engine/test/OrderHashVectors.sol')
const text = renderVectorsSolidity()
const total = VECTOR_SETS.reduce((n, s) => n + s.count, 0)

if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(target, 'utf8') } catch { /* missing = differs */ }
  if (current !== text) {
    console.error(`OrderHashVectors.sol is stale: run node --no-warnings scripts/orders/gen-order-hash-vectors.ts`)
    process.exit(1)
  }
  console.error(`OrderHashVectors.sol up to date (${total} vectors)`)
} else {
  writeFileSync(target, text)
  console.error(`wrote ${target} (${total} vectors: ${VECTOR_SETS.map((s) => `${s.key}=${s.count} seed ${s.seed}`).join(', ')})`)
}
