/**
 * revert-decode.js — unwrap the TeraSwapOrderExecutor `SwapFailed(bytes reason)`
 * revert (selector 0xff9fa595) into a human-readable inner reason.
 *
 * executeOrder() does `(ok, result) = order.router.call(routerData); if (!ok)
 * revert SwapFailed(result);` — so `result` is the inner DEX-router revert. The
 * keeper logged only the raw blob; this decodes the inner Error(string) /
 * Panic(uint256) / empty / raw bytes so the keeper log shows WHY the router call
 * failed (e.g. "transfer amount exceeds allowance" → amount/approval mismatch;
 * empty → the router rejected foreign calldata, i.e. order.router ≠ calldata's
 * target router). [chore/dca-swapfailed]
 */
import { decodeErrorResult, isHex } from "viem"

export const SWAP_FAILED_SELECTOR = "0xff9fa595"

const SWAP_FAILED_ABI = [{ type: "error", name: "SwapFailed", inputs: [{ type: "bytes", name: "reason" }] }]
const STD_ERROR_ABI = [
  { type: "error", name: "Error", inputs: [{ type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ type: "uint256" }] },
]

/** Decode the inner revert bytes (Error/Panic/empty/raw) into a string. */
function decodeInner(inner) {
  if (!inner || inner === "0x") {
    return "empty revert — the router rejected the calldata (commonly: order.router does not match the calldata's target router, or an unknown selector)"
  }
  try {
    const d = decodeErrorResult({ abi: STD_ERROR_ABI, data: inner })
    if (d.errorName === "Error") return `Error(string): ${d.args[0]}`
    if (d.errorName === "Panic") return `Panic(0x${BigInt(d.args[0]).toString(16)})`
  } catch { /* not a standard Error/Panic — fall through to raw */ }
  return `raw bytes: ${inner}`
}

/**
 * Decode a raw revert blob if it is `SwapFailed(bytes)`.
 * @param {string} data hex revert data (e.g. from a viem ContractFunctionRevertedError)
 * @returns {{ selector: string, innerHex: string, reason: string } | null}
 *          null when `data` is absent / not hex / not a SwapFailed revert.
 */
export function decodeSwapFailed(data) {
  if (typeof data !== "string" || !isHex(data)) return null
  if (!data.toLowerCase().startsWith(SWAP_FAILED_SELECTOR)) return null
  let inner
  try {
    const d = decodeErrorResult({ abi: SWAP_FAILED_ABI, data })
    if (d.errorName !== "SwapFailed") return null
    inner = d.args[0]
  } catch {
    return null
  }
  return { selector: SWAP_FAILED_SELECTOR, innerHex: inner, reason: decodeInner(inner) }
}

// [FIX-P1B-M01] The executor's own no-arg custom errors that a triggered non-DCA v3 order can hit
// AFTER canExecute's pre-check passed (a race between the read and the tx landing): output
// dropped below max(oracleFloor, minAmountOut) between check and execution, or the Chainlink price
// crossed back over the target in the same window. Both are MARKET reverts — the pinned route is
// still valid, the moment just wasn't — not a reason to fail the order. Selectors are
// keccak256("InsufficientOutput()")/keccak256("PriceConditionNotMet()") — no-arg errors have no
// payload to ABI-decode, so a raw selector match is sufficient and exact.
export const EXECUTOR_MARKET_REVERT_SELECTORS = {
  InsufficientOutput: "0xbb2875c3", // TeraSwapOrderExecutorV3.sol:278, reverted at :610
  PriceConditionNotMet: "0x3bef7afd", // TeraSwapOrderExecutorV3.sol:275
}

/**
 * Decode a raw revert blob as one of the executor's own market/route custom errors (as opposed to
 * SwapFailed, which wraps the ROUTER's revert). Returns null for anything else, including the
 * executor's PERMANENT-cause errors (OrderExpired, RouterNotWhitelisted, InsufficientBalance, ...)
 * — those are deliberately NOT in this table, so they keep falling through to the existing
 * failure-ladder classification unchanged.
 * @param {string} data hex revert data
 * @returns {{ selector: string, name: string } | null}
 */
export function decodeExecutorMarketRevert(data) {
  if (typeof data !== "string" || !isHex(data)) return null
  const selector = data.slice(0, 10).toLowerCase()
  for (const [name, sel] of Object.entries(EXECUTOR_MARKET_REVERT_SELECTORS)) {
    if (selector === sel.toLowerCase()) return { selector: sel, name }
  }
  return null
}

/**
 * Best-effort extraction of raw revert data from a viem error chain, so the
 * caller can feed it to decodeSwapFailed(). Returns null if none is found.
 * @param {unknown} err
 * @returns {string | null}
 */
export function extractRevertData(err) {
  let e = err
  const seen = new Set()
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e)
    if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data
    if (typeof e.raw === "string" && e.raw.startsWith("0x")) return e.raw
    e = e.cause
  }
  return null
}
