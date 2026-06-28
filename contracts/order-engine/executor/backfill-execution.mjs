// [CHORE-KEEPER-RECORD-EXECUTIONS] Backfill one CONFIRMED executeOrder tx into
// order_executions and advance its parent order — using the SAME pure helpers the
// keeper uses (record-execution.js), so valuation, row shape, and idempotency are
// byte-identical to the live path. Reusable for any fill the keeper missed before
// this fix shipped.
//
// READ-ONLY by default (prints the row it WOULD write). Set BACKFILL_APPLY=1 to write.
// Confirmed-only: refuses to record a tx whose receipt status is not "success".
// Idempotent: recordExecutionRow skips if a row with this tx_hash already exists.
//
// Usage (load creds from your .env.executor / .env.production first):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   [BACKFILL_RPC_URL=https://mainnet.base.org] \
//   node backfill-execution.mjs <txHash> [expectedOrderIdPrefix]
//
// No secrets are embedded; everything comes from env.

import { createPublicClient, http } from "viem"
import { decodeOrderExecuted, buildExecutionRow, recordExecutionRow } from "./record-execution.js"

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const RPC_URL = process.env.BACKFILL_RPC_URL || "https://mainnet.base.org"
const APPLY = process.env.BACKFILL_APPLY === "1"

const txHash = process.argv[2]
const expectedPrefix = process.argv[3] || ""

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.")
  process.exit(1)
}
if (!txHash) {
  console.error("Usage: node backfill-execution.mjs <txHash> [expectedOrderIdPrefix]")
  process.exit(1)
}

async function supabaseFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
}

const client = createPublicClient({ transport: http(RPC_URL) })

console.log(`\n=== Backfill ${txHash} (apply=${APPLY}) via RPC ${RPC_URL} ===`)

const receipt = await client.getTransactionReceipt({ hash: txHash })
console.log(
  `receipt: status=${receipt.status} block=${receipt.blockNumber} to=${receipt.to} gasUsed=${receipt.gasUsed}`,
)
if (receipt.status !== "success") {
  console.error("REFUSING: receipt status is not 'success' — never record an un-confirmed execution.")
  process.exit(1)
}

// receipt.to is the OrderExecutor contract the keeper called executeOrder on.
const decoded = decodeOrderExecuted(receipt.logs, receipt.to)
if (!decoded) {
  console.error("FATAL: no OrderExecuted event found in this tx's logs.")
  process.exit(1)
}
console.log("decoded OrderExecuted:", decoded)

// Exact, unique lookup by the on-chain order hash.
const ores = await supabaseFetch(`orders?order_hash=eq.${decoded.orderHash}&select=*`)
if (!ores.ok) {
  console.error(`FATAL: orders lookup failed: HTTP ${ores.status} ${await ores.text()}`)
  process.exit(1)
}
const orders = await ores.json()
const order = Array.isArray(orders) ? orders[0] : null
if (!order) {
  console.error(`FATAL: no order with order_hash=${decoded.orderHash}`)
  process.exit(1)
}
if (expectedPrefix && !String(order.id).startsWith(expectedPrefix)) {
  console.error(`FATAL: order id ${order.id} does not start with expected prefix ${expectedPrefix}`)
  process.exit(1)
}
console.log(
  `order: id=${order.id} type=${order.order_type} status=${order.status} ` +
    `dca_executed=${order.dca_executed} dca_total=${order.dca_total} chain_id=${order.chain_id} ` +
    `pair=${order.token_in_symbol}->${order.token_out_symbol} router=${order.router}`,
)

// This known tx is the order's first executed chunk → execution_number 1.
const EXEC_NUMBER = 1
const execRow = buildExecutionRow({ dbOrder: order, txHash, receipt, decoded, executionNumber: EXEC_NUMBER })
console.log("order_executions row to write:", execRow)

// Block timestamp for an accurate dca_last_exec.
let blockIso = null
try {
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  blockIso = new Date(Number(block.timestamp) * 1000).toISOString()
} catch {
  /* non-fatal */
}

const currentExec = Number(order.dca_executed || 0)
const total = Math.max(Number(order.dca_total) || 1, 1)
const wantStatus =
  order.order_type === "dca"
    ? EXEC_NUMBER >= total
      ? "executed"
      : "active"
    : "executed"

const orderPatch = {}
if (currentExec < EXEC_NUMBER) orderPatch.dca_executed = EXEC_NUMBER
// Only (re)set status from a non-terminal state so we never reactivate a
// cancelled/expired order.
if (["active", "executing", null, undefined].includes(order.status)) orderPatch.status = wantStatus
if (blockIso && !order.dca_last_exec) orderPatch.dca_last_exec = blockIso
if (Object.keys(orderPatch).length) orderPatch.updated_at = new Date().toISOString()
console.log("orders patch to apply:", orderPatch)

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with BACKFILL_APPLY=1 to apply.\n")
  process.exit(0)
}

const rec = await recordExecutionRow(supabaseFetch, execRow)
console.log("order_executions write:", rec)

if (Object.keys(orderPatch).length > 1) {
  const pres = await supabaseFetch(`orders?id=eq.${order.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(orderPatch),
  })
  console.log(`orders patch: ok=${pres.ok} status=${pres.status}`)
} else {
  console.log("orders patch: nothing to change")
}
console.log("\nDone.\n")
