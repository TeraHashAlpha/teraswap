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
