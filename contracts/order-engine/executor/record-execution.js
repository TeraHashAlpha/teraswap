// [CHORE-KEEPER-RECORD-EXECUTIONS] Pure helpers that turn a CONFIRMED
// executeOrder receipt into ONE idempotent `order_executions` row and the
// parent order's exec-count/status transition.
//
// Why this module exists: executor.js auto-runs main() on import, so the
// recording logic is factored out here (side-effect-free) to be unit-tested
// directly — same pattern as swap-route.js / revert-decode.js. The only I/O
// helper, recordExecutionRow(), takes an INJECTED supabaseFetch so it is
// testable without a real PostgREST endpoint.
//
// Root cause this fixes: the old recordExecution() POSTed a non-existent
// `executed_at` column and omitted the NOT-NULL `execution_number`/`fee_amount`
// columns, so PostgREST 400'd every insert — and the response was never checked,
// so the failure was swallowed and `order_executions` stayed empty. The
// per-chunk amount_in/amount_out/fee are read from the on-chain OrderExecuted
// event (the authoritative confirmed values), never fabricated.

import { decodeEventLog } from "viem"

// OrderExecuted(bytes32 indexed orderHash, address indexed owner,
//               OrderType indexed orderType, address tokenIn, address tokenOut,
//               uint256 amountIn, uint256 amountOut, uint256 fee)
// — TeraSwapOrderExecutor.sol. OrderType is a uint8 enum (indexed).
export const ORDER_EXECUTED_EVENT = {
  type: "event",
  name: "OrderExecuted",
  inputs: [
    { name: "orderHash", type: "bytes32", indexed: true },
    { name: "owner", type: "address", indexed: true },
    { name: "orderType", type: "uint8", indexed: true },
    { name: "tokenIn", type: "address", indexed: false },
    { name: "tokenOut", type: "address", indexed: false },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "fee", type: "uint256", indexed: false },
  ],
}

// Decode the single OrderExecuted log our OrderExecutor emits for this tx.
// Returns { orderHash, tokenIn, tokenOut, amountIn, amountOut, fee } as decimal
// strings, or null when no matching log is present (RPC returned no logs, the
// log came from another contract, etc.). Never throws.
export function decodeOrderExecuted(logs, contractAddress) {
  if (!Array.isArray(logs) || !contractAddress) return null
  const target = String(contractAddress).toLowerCase()
  for (const lg of logs) {
    if (!lg || typeof lg.address !== "string") continue
    if (lg.address.toLowerCase() !== target) continue
    try {
      const decoded = decodeEventLog({
        abi: [ORDER_EXECUTED_EVENT],
        data: lg.data,
        topics: lg.topics,
      })
      if (decoded.eventName !== "OrderExecuted") continue
      const a = decoded.args
      return {
        orderHash: a.orderHash,
        tokenIn: a.tokenIn,
        tokenOut: a.tokenOut,
        amountIn: a.amountIn.toString(),
        amountOut: a.amountOut.toString(),
        fee: a.fee.toString(),
      }
    } catch {
      // Not an OrderExecuted log (e.g. an ERC-20 Transfer from the contract) —
      // topic0 won't match our single-event ABI, so decodeEventLog throws. Skip.
      continue
    }
  }
  return null
}

// Confirmed-only predicate. viem normalizes receipt.status to the STRING
// "success" | "reverted" (not 1/0). Only a mined, successful receipt is recorded.
export function shouldRecord(receipt) {
  return !!receipt && receipt.status === "success"
}

// 1-based execution index for this fill. DCA: completed-so-far + 1.
// Limit / Stop-Loss are single-fill → always 1.
export function executionNumberFor(dbOrder) {
  if (dbOrder && dbOrder.order_type === "dca") {
    return Number(dbOrder.dca_executed || 0) + 1
  }
  return 1
}

// Parent-order status/exec-count transition after a confirmed fill.
// DCA cycles active⇄active until the final chunk, then 'executed'.
// Limit / Stop-Loss complete on their single fill.
export function nextOrderStatus(dbOrder) {
  if (dbOrder && dbOrder.order_type === "dca") {
    const newExecCount = Number(dbOrder.dca_executed || 0) + 1
    const total = Math.max(Number(dbOrder.dca_total) || 1, 1)
    const complete = newExecCount >= total
    return { status: complete ? "executed" : "active", dca_executed: newExecCount, complete }
  }
  return { status: "executed", complete: true }
}

// Fallback per-chunk amount_in = floor(total / dca_total). Matches the analytics
// route's perChunkAmount() so the stored value is consistent with how #228 values
// a chunk. Only used when the OrderExecuted event can't be decoded. Never throws.
export function perChunkAmountIn(dbOrder) {
  try {
    const total = BigInt(String(dbOrder?.amount_in ?? "0").split(".")[0] || "0")
    const n = BigInt(Math.max(Number(dbOrder?.dca_total) || 1, 1))
    return (total / n).toString()
  } catch {
    return "0"
  }
}

// Build the order_executions row from CONFIRMED data. Populates every NOT-NULL
// column (order_id, execution_number, tx_hash, amount_in, amount_out, fee_amount,
// status). amount_in/amount_out/fee come from the decoded on-chain event; when
// the event can't be decoded, amount_in falls back to the per-chunk computation
// and amount_out/fee default to "0" (never fabricated). Does NOT include the
// phantom `executed_at` column that caused the original insert to 400.
//
// [CHORE-DCA-AGGREGATION-VALUE] `nextBestOut`/`nextBestSource` are ADDITIVE,
// nullable telemetry (the runner-up source/amount from the SAME unconstrained
// quote round the deviation guard already fetches, captured in executor.js
// POST-execution) — purely for the settlement receipt's "aggregation value"
// line, never a routing/execution input. Both columns are OMITTED from the row
// entirely (not written as explicit NULL) unless BOTH are present together —
// an amount without its source label (or vice versa) is a malformed pair and
// is dropped rather than persisted half-formed.
export function buildExecutionRow({
  dbOrder, txHash, receipt, decoded, executionNumber, priceAtExecution,
  nextBestOut, nextBestSource,
}) {
  const execNum = executionNumber ?? executionNumberFor(dbOrder)
  const amountIn = decoded?.amountIn ?? perChunkAmountIn(dbOrder)
  const amountOut = decoded?.amountOut ?? "0"
  const fee = decoded?.fee ?? "0"
  const row = {
    order_id: dbOrder.id,
    execution_number: execNum,
    tx_hash: txHash,
    amount_in: String(amountIn),
    amount_out: String(amountOut),
    fee_amount: String(fee),
    gas_used: receipt && receipt.gasUsed != null ? receipt.gasUsed.toString() : "0",
    status: "confirmed",
  }
  if (priceAtExecution != null) row.price_at_execution = String(priceAtExecution)
  if (nextBestOut != null && nextBestSource != null) {
    row.next_best_out = String(nextBestOut)
    row.next_best_source = String(nextBestSource)
  }
  return row
}

// Idempotent insert of a confirmed fill, keyed by tx_hash. Best-effort dedup:
// GET order_executions?tx_hash=eq.<hash>; skip the POST if a row already exists
// (so re-processing a tx — keeper restart, backfill re-run — never duplicates).
// Confirmed-only is enforced by the CALLER via shouldRecord(). Unlike the old
// recordExecution(), this CHECKS res.ok and reports failures instead of swallowing
// them. Returns { recorded:boolean, reason?:string, error?:string }.
export async function recordExecutionRow(supabaseFetch, row) {
  try {
    const existing = await supabaseFetch(
      `order_executions?tx_hash=eq.${row.tx_hash}&select=id&limit=1`,
    )
    if (existing && existing.ok) {
      const rows = await existing.json()
      if (Array.isArray(rows) && rows.length > 0) {
        return { recorded: false, reason: "duplicate" }
      }
    }
  } catch {
    // Idempotency check failed (transient) — fall through and attempt the insert.
    // A duplicate row is harmless (analytics dedups by tx_hash); a MISSING row is
    // the bug we are fixing, so favor recording.
  }

  // [CHORE-DCA-AGGREGATION-VALUE] Found while proving "recording never blocks a fill": this POST
  // was the one call in this function NOT wrapped in try/catch — a hard network failure (as
  // opposed to a non-ok HTTP response, already handled below) would have THROWN out of
  // recordExecutionRow and into executor.js's unguarded call site, right after a real, confirmed,
  // already-executed fill. Caught here so every failure mode resolves to {recorded:false,...},
  // matching the idempotency check's posture above.
  let res
  try {
    res = await supabaseFetch("order_executions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(row),
    })
  } catch (err) {
    return { recorded: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!res || !res.ok) {
    let detail = ""
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
    return { recorded: false, error: `HTTP ${res ? res.status : "?"}${detail ? " " + detail.slice(0, 200) : ""}` }
  }
  return { recorded: true }
}
