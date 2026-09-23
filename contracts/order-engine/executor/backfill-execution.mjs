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
// [FIX-BACKFILL-EXECUTION-NUMBER-AND-TIMESTAMP] execution_number and created_at are DERIVED FROM
// THE CHAIN, not guessed: every OrderExecuted log for this order's hash is fetched (reusing
// list-missing-fills.mjs's scanLogsChunked/resolveBlockFromTimestamp — same chunking + block-range
// safety as the missing-fills scanner), sorted by (blockNumber, logIndex), and this tx's 1-based
// rank in that ordering is the execution number; created_at comes from this tx's own block
// timestamp. Previously execution_number was hard-coded to 1 for every backfilled fill (wrong for
// any order's 2nd+ chunk) and created_at silently defaulted to insert time (the backfill run's
// clock, not when the fill happened) — see docs/feedback/fix-backfill-execution-number-and-timestamp.md.
//
// --repair: for a tx whose order_executions row ALREADY exists (e.g. backfilled before this fix),
// PATCH only execution_number/created_at to the chain-derived values. Never touches amounts,
// status, or the parent order. Refuses unless exactly one row matches tx_hash.
//
// Usage (load creds from your .env.executor / .env.production first):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   [BACKFILL_RPC_URL=https://mainnet.base.org] \
//   node backfill-execution.mjs <txHash> [expectedOrderIdPrefix]
//   node backfill-execution.mjs <txHash> --repair
//
// No secrets are embedded; everything comes from env.

// [KEEPER-ENV-ORDER] MUST stay the first import (see env.js) — loads .env.executor
// from cwd before the module-scope env reads below; explicit shell env still wins.
import "./env.js"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { createPublicClient, http } from "viem"
import { decodeOrderExecuted, ORDER_EXECUTED_EVENT, buildExecutionRow, recordExecutionRow } from "./record-execution.js"
import { scanLogsChunked, resolveBlockFromTimestamp } from "./list-missing-fills.mjs"

// ── Pure / injectable helpers (exported for backfill-execution.test.mjs; no client, no network) ──

// 1-based rank of `txHash`'s OrderExecuted log among every OrderExecuted log this order hash has
// ever emitted, ordered by (blockNumber, logIndex) — matches the live keeper's fill sequence
// regardless of the order the backfill hashes are processed in. `getLogs`/`getLatestBlock`/
// `getBlockTimestamp` are injected (same shape as list-missing-fills.mjs's scanLogsChunked /
// resolveBlockFromTimestamp) so this is testable without a live RPC.
export async function computeExecutionNumber({
  orderHash, txHash, sinceTs, chunkSize = 10000,
  getLogs, getLatestBlock, getBlockTimestamp, log = () => {},
}) {
  const latestBlock = await getLatestBlock()
  const fromBlock =
    sinceTs != null
      ? await resolveBlockFromTimestamp({ targetTs: sinceTs, latestBlock, getBlockTimestamp })
      : 0
  const rawLogs = await scanLogsChunked({ getLogs, fromBlock, toBlock: latestBlock, chunkSize, log })
  const sorted = [...rawLogs].sort((a, b) => {
    const byBlock = Number(a.blockNumber) - Number(b.blockNumber)
    return byBlock !== 0 ? byBlock : Number(a.logIndex) - Number(b.logIndex)
  })
  const rank = sorted.findIndex(
    (lg) => String(lg.transactionHash).toLowerCase() === String(txHash).toLowerCase(),
  )
  if (rank === -1) {
    throw new Error(
      `tx ${txHash} not found among ${sorted.length} on-chain OrderExecuted log(s) for order ${orderHash}`,
    )
  }
  return { executionNumber: rank + 1, totalOnChain: sorted.length }
}

// Parent-order patch for a CHAIN-DERIVED execution number (generalizes the old hard-coded-1 logic
// to any 1-based fill index). Only (re)sets status from a non-terminal state so a repaired/replayed
// backfill never reactivates a cancelled/expired order; dca_last_exec is set only if not already
// present, so a later out-of-order backfill never regresses it.
export function computeOrderPatch({ order, executionNumber, blockIso }) {
  const currentExec = Number(order.dca_executed || 0)
  const total = Math.max(Number(order.dca_total) || 1, 1)
  const wantStatus =
    order.order_type === "dca" ? (executionNumber >= total ? "executed" : "active") : "executed"

  const patch = {}
  if (currentExec < executionNumber) patch.dca_executed = executionNumber
  if (["active", "executing", null, undefined].includes(order.status)) patch.status = wantStatus
  if (blockIso && !order.dca_last_exec) patch.dca_last_exec = blockIso
  if (Object.keys(patch).length) patch.updated_at = new Date().toISOString()
  return patch
}

// --repair guard: exactly one existing order_executions row for this tx_hash, or refuse. Narrow by
// design — --repair only ever patches execution_number/created_at on a row it can uniquely identify.
export function resolveRepairTarget(existingRows) {
  if (!Array.isArray(existingRows) || existingRows.length !== 1) {
    return { ok: false, count: Array.isArray(existingRows) ? existingRows.length : 0 }
  }
  return { ok: true, row: existingRows[0] }
}

// ── Entrypoint (never runs on import — only when invoked as `node backfill-execution.mjs`) ──────

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  const RPC_URL = process.env.BACKFILL_RPC_URL || "https://mainnet.base.org"
  const APPLY = process.env.BACKFILL_APPLY === "1"
  const rawChunk = Number(process.env.LOGS_CHUNK || "10000")
  const LOGS_CHUNK = Number.isFinite(rawChunk) && rawChunk > 0 ? rawChunk : 10000

  const rawArgs = process.argv.slice(2)
  const REPAIR = rawArgs.includes("--repair")
  const positional = rawArgs.filter((a) => a !== "--repair")
  const txHash = positional[0]
  const expectedPrefix = positional[1] || ""

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.")
    process.exit(1)
  }
  if (!txHash) {
    console.error("Usage: node backfill-execution.mjs <txHash> [expectedOrderIdPrefix]")
    console.error("       node backfill-execution.mjs <txHash> --repair")
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

  console.log(`\n=== Backfill ${txHash} (apply=${APPLY}${REPAIR ? ", repair" : ""}) via RPC ${RPC_URL} ===`)

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

  // [FIX-BACKFILL-EXECUTION-NUMBER-AND-TIMESTAMP] Chain-derived 1-based execution number — this
  // tx's rank among every OrderExecuted log this order hash has emitted. Scan from the order's
  // creation time (when available) to bound the eth_getLogs range; from genesis otherwise.
  const sinceTs = order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : undefined
  const { executionNumber, totalOnChain } = await computeExecutionNumber({
    orderHash: decoded.orderHash,
    txHash,
    sinceTs,
    chunkSize: LOGS_CHUNK,
    getLogs: (from, to) =>
      client.getLogs({
        address: receipt.to,
        event: ORDER_EXECUTED_EVENT,
        args: { orderHash: decoded.orderHash },
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
      }),
    getLatestBlock: async () => Number(await client.getBlockNumber()),
    getBlockTimestamp: async (n) => Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp),
    log: (msg) => console.log(msg),
  })

  // Block timestamp for both order_executions.created_at and dca_last_exec.
  let blockTimestamp = null
  let blockIso = null
  try {
    const block = await client.getBlock({ blockNumber: receipt.blockNumber })
    blockTimestamp = Number(block.timestamp)
    blockIso = new Date(blockTimestamp * 1000).toISOString()
  } catch {
    /* non-fatal */
  }

  const execRow = buildExecutionRow({ dbOrder: order, txHash, receipt, decoded, executionNumber, blockTimestamp })
  console.log(
    `chain-derived: execution_number=${executionNumber} of ${totalOnChain} on-chain fill(s), ` +
      `created_at=${execRow.created_at || "(block timestamp unavailable)"}`,
  )
  console.log("order_executions row to write:", execRow)

  if (REPAIR) {
    const existingRes = await supabaseFetch(`order_executions?tx_hash=eq.${txHash}&select=id`)
    if (!existingRes.ok) {
      console.error(`FATAL: order_executions lookup failed: HTTP ${existingRes.status} ${await existingRes.text()}`)
      process.exit(1)
    }
    const existingRows = await existingRes.json()
    const target = resolveRepairTarget(existingRows)
    if (!target.ok) {
      console.error(
        `FATAL: --repair requires exactly 1 existing order_executions row for tx_hash=${txHash} (found ${target.count})`,
      )
      process.exit(1)
    }
    const patch = { execution_number: execRow.execution_number, created_at: execRow.created_at }
    console.log("order_executions REPAIR patch to apply:", patch)

    if (!APPLY) {
      console.log("\nDRY RUN — nothing written. Re-run with BACKFILL_APPLY=1 to apply.\n")
      process.exit(0)
    }

    const pres = await supabaseFetch(`order_executions?tx_hash=eq.${txHash}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    })
    console.log(`order_executions repair: ok=${pres.ok} status=${pres.status}`)
    console.log("\nDone.\n")
    process.exit(0)
  }

  const orderPatch = computeOrderPatch({ order, executionNumber, blockIso })
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
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  main().catch((err) => {
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
