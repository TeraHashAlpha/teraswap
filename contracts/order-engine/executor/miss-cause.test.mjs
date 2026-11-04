// [fix/infra-failures-dont-burn-orders / ADR-026] Every order miss is tagged with its CAUSE:
//   infra — OUR side could not complete the attempt (RPC auth/allowlist, RPC transport / timeout /
//           5xx / 429, the keeper paused, Supabase or /api/swap unreachable, the keeper wallet out of
//           gas, a keeper config gap, a sent tx whose receipt we could not fetch);
//   order — the ORDER is why it did not fill (a revert — mined or simulated — attributable to the
//           order: slippage / minOut / floor, allowance, balance, nonce; expired; our API answered
//           and there is no acceptable route for this pair).
// Ambiguous: `infra` only when the keeper itself could not complete the attempt (no tx sent); any
// SENT-and-REVERTED tx is `order`. Positive evidence is required for `order`; a miss with NO evidence
// at all keeps today's counting (order:unknown) so an untouched call site cannot silently stop counting.
//
// Pure: imports retry-policy.js only (executor.js auto-runs main() on import).
// Run: node --test contracts/order-engine/executor/miss-cause.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { HttpRequestError, TimeoutError } from "viem"

import { MISS_CAUSE, classifyMissCause, classifySwapApiMiss, planFailureHandling, FAILURE_REASON } from "./retry-policy.js"

const URL_ = "https://base-mainnet.g.alchemy.com/v2/TESTKEY"
const http = (status, details) => new HttpRequestError({ url: URL_, status, body: { method: "eth_call" }, details })
const named = (name, message) => Object.assign(new Error(message), { name })
const NOW = "2026-11-04T12:00:00.000Z"
const NOW_SEC = Math.floor(Date.parse(NOW) / 1000)
const order = (over = {}) => ({ id: "o-1", order_type: "dca", status: "active", expiry: NOW_SEC + 86_400, consecutive_failures: 0, last_attempt_at: null, ...over })

const infra = (reason) => ({ cause: MISS_CAUSE.INFRA, reason })
const orderCause = (reason) => ({ cause: MISS_CAUSE.ORDER, reason })

describe("classifyMissCause — the cause table (ADR-026 §2)", () => {
  test("MISS_CAUSE is the two-value contract the row and the ADR share", () => {
    assert.deepEqual(MISS_CAUSE, { INFRA: "infra", ORDER: "order" })
  })

  describe("infra — the keeper could not complete the attempt", () => {
    test("keeper paused (rpc-auth) ⇒ infra, before anything else", () => {
      assert.deepEqual(classifyMissCause({ paused: "rpc-auth", err: named("ContractFunctionRevertedError", "execution reverted") }), infra("paused:rpc-auth"))
    })
    test("RPC auth/allowlist — reuses rpc-auth.js: HTTP 403, HTTP 401, and the provider's words with no status", () => {
      assert.deepEqual(classifyMissCause({ err: http(403, "Unspecified origin not on whitelist.") }), infra("rpc-auth"))
      assert.deepEqual(classifyMissCause({ err: http(401, "Must be authenticated!") }), infra("rpc-auth"))
      assert.deepEqual(classifyMissCause({ err: new Error("Unspecified origin not on whitelist.") }), infra("rpc-auth"))
    })
    test("RPC transport — HTTP 5xx / 429 from the provider, a viem timeout, a socket error", () => {
      assert.deepEqual(classifyMissCause({ err: http(503, "Service Unavailable") }), infra("rpc-transport"))
      assert.deepEqual(classifyMissCause({ err: http(429, "Too Many Requests") }), infra("rpc-transport"))
      assert.deepEqual(classifyMissCause({ err: new TimeoutError({ body: { method: "eth_call" }, url: URL_ }) }), infra("rpc-transport"))
      assert.deepEqual(classifyMissCause({ err: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }) }), infra("rpc-transport"))
    })
    test("Supabase unreachable mid-attempt is the same shape: a bare fetch failure ⇒ infra", () => {
      assert.deepEqual(classifyMissCause({ err: new TypeError("fetch failed") }), infra("rpc-transport"))
    })
    test("keeper wallet out of gas (viem InsufficientFundsError / the node's words) ⇒ infra keeper-gas, NOT the user's balance", () => {
      assert.deepEqual(classifyMissCause({ err: named("InsufficientFundsError", "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.") }), infra("keeper-gas"))
      assert.deepEqual(classifyMissCause({ err: new Error("insufficient funds for gas * price + value") }), infra("keeper-gas"))
    })
    test("[A73 S-2] a REVERT whose text happens to say 'insufficient funds' is the contract talking ⇒ order, never keeper-gas", () => {
      assert.deepEqual(classifyMissCause({ err: named("ContractFunctionRevertedError", "execution reverted: insufficient funds for transfer") }), orderCause("revert"))
      assert.deepEqual(classifyMissCause({ err: new Error("execution reverted: exceeds the balance of the account") }), orderCause("revert"))
      assert.deepEqual(classifyMissCause({ err: named("ContractFunctionExecutionError", 'The contract function "executeOrder" reverted.\n\nError: insufficient funds for gas') }), orderCause("revert"))
      // the node's own insufficient-funds verdict (no revert anywhere in the chain) is still ours
      assert.deepEqual(classifyMissCause({ err: Object.assign(named("InsufficientFundsError", "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."), { cause: new Error("insufficient funds for gas * price + value") }) }), infra("keeper-gas"))
    })
    test("a SENT tx whose receipt could not be fetched ⇒ infra receipt-unavailable (the chain decides; the next cycle re-reads it)", () => {
      assert.deepEqual(classifyMissCause({ txSent: true, err: named("WaitForTransactionReceiptTimeoutError", "Timed out while waiting for transaction") }), infra("receipt-unavailable"))
      assert.deepEqual(classifyMissCause({ txSent: true, err: http(502, "Bad Gateway") }), infra("receipt-unavailable"))
    })
    test("no route because OUR swap API was unavailable (5xx / 429 / network / config / oracle) ⇒ infra", () => {
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 503 }) }), infra("swap-api:503"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 429 }) }), infra("swap-api:429"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ networkError: true }) }), infra("swap-api:network"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ configMissing: true }) }), infra("keeper-config"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ misroute: true }) }), infra("swap-api:misroute"))
      // [A73 S-1] by CODE, not status: our oracle being down is ours; a payload/config 400 is ours
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 422, code: "ORACLE_UNAVAILABLE" }) }), infra("swap-api:oracle-unavailable"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 400, code: "INVALID_SOURCE" }) }), infra("keeper-config"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 400 }) }), infra("keeper-config"))
    })
    test("an unknown thrown error with NO tx sent ⇒ infra unclassified (the keeper did not complete the attempt)", () => {
      assert.deepEqual(classifyMissCause({ err: new TypeError("Cannot read properties of undefined (reading 'x')") }), infra("unclassified"))
    })
  })

  describe("order — the order is why it did not fill", () => {
    test("a MINED revert (tx sent, receipt.status reverted) ⇒ order reverted — the sent-and-reverted rule", () => {
      assert.deepEqual(classifyMissCause({ minedRevert: true }), orderCause("reverted"))
      assert.deepEqual(classifyMissCause({ minedRevert: true, txSent: true, err: http(503, "x") }), orderCause("reverted"), "minedRevert is positive evidence; a stray error does not re-tag it")
    })
    test("a simulated revert (estimateGas / canExecute) ⇒ order revert, named by the executor error or SwapFailed reason", () => {
      assert.deepEqual(classifyMissCause({ err: named("ContractFunctionRevertedError", 'The contract function "executeOrder" reverted.') }), orderCause("revert"))
      assert.deepEqual(classifyMissCause({ err: new Error("execution reverted"), executorErrorName: "InsufficientOutput" }), orderCause("revert:InsufficientOutput"))
      assert.deepEqual(classifyMissCause({ err: new Error("execution reverted"), swapReason: "Too little received" }), orderCause("revert:swap-failed"))
      assert.deepEqual(classifyMissCause({ executorErrorName: "PriceConditionNotMet" }), orderCause("revert:PriceConditionNotMet"), "a decoded executor error is a revert even without an error object")
    })
    test("a revert that happens to say 'not on whitelist' is the CONTRACT talking ⇒ order, never rpc-auth", () => {
      assert.deepEqual(classifyMissCause({ err: named("ContractFunctionRevertedError", "execution reverted: router not on whitelist") }), orderCause("revert"))
    })
    test("permanent causes (allowance / balance / nonce) ⇒ order with the FAILURE_REASON code", () => {
      assert.deepEqual(classifyMissCause({ err: new Error("ERC20: transfer amount exceeds allowance") }), orderCause(FAILURE_REASON.INSUFFICIENT_ALLOWANCE))
      assert.deepEqual(classifyMissCause({ err: new Error("ERC20: transfer amount exceeds balance") }), orderCause(FAILURE_REASON.INSUFFICIENT_BALANCE))
      assert.deepEqual(classifyMissCause({ swapReason: "InvalidNonce()" }), orderCause(FAILURE_REASON.NONCE_INVALID))
    })
    test("our API answered with a CODE that names the order (NO_ROUTE / unpriced_ack_required / PRICE_GUARD) ⇒ order no-route", () => {
      // [A73 S-1] by CODE, not status — a 422 is NO_ROUTE only when it says so
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 422, code: "NO_ROUTE" }) }), orderCause("no-route"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 409, code: "unpriced_ack_required" }) }), orderCause("no-route:unpriced-ack"))
      assert.deepEqual(classifyMissCause({ noRoute: true, noRouteCause: classifySwapApiMiss({ status: 422, code: "PRICE_GUARD" }) }), orderCause("no-route:price-guard"))
    })
    test("noRoute with NO cause object keeps today's counting (order:no-route)", () => {
      assert.deepEqual(classifyMissCause({ noRoute: true }), orderCause("no-route"))
    })
    test("a miss with NO evidence at all keeps today's counting: order:unknown (never silently infra)", () => {
      assert.deepEqual(classifyMissCause({}), orderCause("unknown"))
      assert.deepEqual(classifyMissCause(), orderCause("unknown"))
    })
  })
})

describe("classifySwapApiMiss — by response CODE first, status second [A73 S-1]", () => {
  test("codes: NO_ROUTE / unpriced_ack_required / PRICE_GUARD name the order; ORACLE_UNAVAILABLE, config codes and our 0x throttle are ours", () => {
    assert.deepEqual(classifySwapApiMiss({ status: 422, code: "NO_ROUTE" }), orderCause("no-route"))
    assert.deepEqual(classifySwapApiMiss({ status: 200, code: "no_route" }), orderCause("no-route"), "case-insensitive; the status does not matter")
    assert.deepEqual(classifySwapApiMiss({ status: 409, code: "unpriced_ack_required" }), orderCause("no-route:unpriced-ack"))
    assert.deepEqual(classifySwapApiMiss({ status: 422, code: "PRICE_GUARD" }), orderCause("no-route:price-guard"))
    assert.deepEqual(classifySwapApiMiss({ status: 422, code: "ORACLE_UNAVAILABLE" }), infra("swap-api:oracle-unavailable"))
    for (const code of ["INVALID_SOURCE", "CHAIN_UNSUPPORTED", "CHAIN_COMING_SOON"]) assert.deepEqual(classifySwapApiMiss({ status: 400, code }), infra("keeper-config"), code)
    assert.deepEqual(classifySwapApiMiss({ status: 429, code: "ZEROX_QUOTE_CAP_EXCEEDED" }), infra("swap-api:429"))
    assert.deepEqual(classifySwapApiMiss({ status: 418, code: "SOMETHING_NEW" }), infra("swap-api:418"), "an unknown code is contract drift: ours, never the order")
  })
  test("no code: 429 / 5xx ⇒ infra swap-api:<status>; a payload/config 400 ⇒ keeper-config; any other 4xx ⇒ ours (no positive evidence)", () => {
    assert.deepEqual(classifySwapApiMiss({ status: 500 }), infra("swap-api:500"))
    assert.deepEqual(classifySwapApiMiss({ status: 504 }), infra("swap-api:504"))
    assert.deepEqual(classifySwapApiMiss({ status: 429 }), infra("swap-api:429"))
    assert.deepEqual(classifySwapApiMiss({ status: 400 }), infra("keeper-config"))
    assert.deepEqual(classifySwapApiMiss({ status: 404 }), infra("swap-api:404"))
    assert.deepEqual(classifySwapApiMiss({ status: 422 }), infra("swap-api:422"), "a 422 without a code is an older API deploy: not counted until it says NO_ROUTE")
    assert.deepEqual(classifySwapApiMiss({ status: 502 }), infra("swap-api:502"), "today's no-route 502 (before the API deploy) is never counted")
  })
  test("network / config / misroute / a 2xx without tx data are ours; no evidence at all keeps today's counting", () => {
    assert.deepEqual(classifySwapApiMiss({ networkError: true }), infra("swap-api:network"))
    assert.deepEqual(classifySwapApiMiss({ configMissing: true }), infra("keeper-config"))
    assert.deepEqual(classifySwapApiMiss({ misroute: true }), infra("swap-api:misroute"))
    assert.deepEqual(classifySwapApiMiss({ missingData: true }), infra("swap-api:no-tx-data"))
    assert.deepEqual(classifySwapApiMiss({}), orderCause("no-route"))
  })
})

describe("planFailureHandling carries the cause on every plan (commit 1: tagging only)", () => {
  test("expired ⇒ cause order:expired", () => {
    const plan = planFailureHandling({ dbOrder: order({ expiry: NOW_SEC - 1 }), noRoute: true, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "expired")
    assert.equal(plan.cause, MISS_CAUSE.ORDER)
    assert.equal(plan.causeReason, FAILURE_REASON.EXPIRED)
  })
  test("a sent-and-reverted miss ⇒ order:reverted, counted as before", () => {
    const plan = planFailureHandling({ dbOrder: order({ consecutive_failures: 2 }), minedRevert: true, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "retry")
    assert.equal(plan.failures, 3)
    assert.deepEqual([plan.cause, plan.causeReason], [MISS_CAUSE.ORDER, "reverted"])
  })
  test("a permanent cause ⇒ fail now, cause order:<code>", () => {
    const plan = planFailureHandling({ dbOrder: order(), err: new Error("ERC20: transfer amount exceeds allowance"), nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "fail")
    assert.deepEqual([plan.cause, plan.causeReason], [MISS_CAUSE.ORDER, FAILURE_REASON.INSUFFICIENT_ALLOWANCE])
  })
  test("an RPC auth miss is TAGGED infra:rpc-auth (the counter change is commit 2)", () => {
    const plan = planFailureHandling({ dbOrder: order(), err: http(403, "Unspecified origin not on whitelist."), nowSec: NOW_SEC, nowIso: NOW })
    assert.deepEqual([plan.cause, plan.causeReason], [MISS_CAUSE.INFRA, "rpc-auth"])
  })
})

// ─── executor.js wiring (source anchors — executor.js auto-runs main() on import) ─────────────
import { readFileSync } from "node:fs"
const executorSource = () => readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
const sliceBetween = (src, start, end) => {
  const a = src.indexOf(start)
  assert.notEqual(a, -1, `anchor not found: ${start}`)
  const b = src.indexOf(end, a)
  assert.notEqual(b, -1, `end anchor not found: ${end}`)
  return src.slice(a, b)
}

describe("executor.js wiring — every miss site passes its evidence to the plan", () => {
  test("no-route: fetchSwapRoute returns a classified miss (never a bare null) and the site forwards it", () => {
    const fn = sliceBetween(executorSource(), "async function fetchSwapRoute(", "\n// [chore/dca-deviation-guard] Best-of-N")
    assert.equal(/return null\b/.test(fn), false, "every failure return carries { miss: classifySwapApiMiss(…) }")
    assert.ok(fn.includes("miss: classifySwapApiMiss({ configMissing: true })"), "no API URL / no source for the router ⇒ keeper-config")
    assert.ok(fn.includes("miss: classifySwapApiMiss({ status: res.status, code })"), "a non-2xx carries its status AND the body's code [A73 S-1]")
    assert.ok(fn.includes("code = parsed?.code") || fn.includes("code = JSON.parse(body)?.code"), "the code is read from the JSON error body")
    assert.ok(fn.includes("miss: classifySwapApiMiss({ missingData: true })"))
    assert.ok(fn.includes("miss: classifySwapApiMiss({ misroute: true })"))
    assert.ok(fn.includes("miss: classifySwapApiMiss({ networkError: true })"), "a thrown fetch ⇒ swap-api:network")
    assert.ok(executorSource().includes("await handleExecutionFailure(dbOrder, { noRoute: true, noRouteCause: swapData?.miss ?? null }, obsCtx)"))
  })
  test("mined revert: the site says so (sent-and-reverted ⇒ order)", () => {
    assert.ok(executorSource().includes("await handleExecutionFailure(dbOrder, { minedRevert: true }, obsCtx)"))
  })
  test("thrown path: the site says whether a tx was sent (receipt-unavailable ⇒ infra)", () => {
    const src = executorSource()
    assert.ok(src.includes("let sentTxHash = null"), "declared per order, before the try")
    assert.ok(src.includes("sentTxHash = txHash"), "set the moment writeContract returns")
    assert.ok(src.includes("await handleExecutionFailure(dbOrder, { err, swapReason, executorErrorName, txSent: sentTxHash !== null }, obsCtx)"))
  })
  test("handleExecutionFailure forwards the evidence + the paused state and logs the cause", () => {
    const body = sliceBetween(executorSource(), "async function handleExecutionFailure(", "\nasync function unlockStaleOrders")
    for (const k of ["noRouteCause,", "minedRevert,", "txSent,", "paused: rpcAuthMonitor ? rpcAuthMonitor.state().paused : null,"]) {
      assert.ok(body.includes(k), `plan input must carry ${k}`)
    }
    assert.ok(body.includes("cause=${plan.cause}:${plan.causeReason}"), "every miss log line names its cause")
  })
})
