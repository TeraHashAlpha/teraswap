// [A73b S-7 / S-8] The cause table against the REAL viem 2.47.10 error objects the keeper receives —
// wrapped exactly as viem wraps them at the two execution sites (built by viem's own clients from
// this directory's node_modules against a local JSON-RPC stub; viem-wrapped-errors.fixture.mjs):
//
//   read  — publicClient.readContract(canExecute)     executor.js "Check via contract"
//   write — walletClient.writeContract(executeOrder)  executor.js "TX sent" (fails at eth_estimateGas
//           — the keeper passes no `gas` — or at eth_sendRawTransaction)
//
// A73b: the viem WRAPPERS (ContractFunctionExecutionError, CallExecutionError,
// EstimateGasExecutionError, TransactionExecutionError) wrap EVERY failure of a contract call — a
// provider 503, a timeout, the node's "insufficient funds" — so their names are not evidence of a
// revert. A revert needs POSITIVE evidence anywhere in the `cause` chain: a name matching /Revert/
// (ContractFunctionRevertedError, ExecutionRevertedError) or revert text. Everything the chain says
// about transport / HTTP / timeout / the keeper's nonce / the keeper's funds is OURS (infra).
//
// Pure: imports retry-policy.js + the fixture only (executor.js auto-runs main() on import).
// Run: node --test contracts/order-engine/executor/wrapped-viem-errors.test.mjs

import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  NonceTooLowError,
  TimeoutError,
  TransactionExecutionError,
} from "viem"

import { MISS_CAUSE, classifyMissCause, planFailureHandling } from "./retry-policy.js"
import { startRpcStub, chainNames, revertStringData, INSUFFICIENT_OUTPUT_DATA } from "./viem-wrapped-errors.fixture.mjs"

const infra = (reason) => ({ cause: MISS_CAUSE.INFRA, reason })
const order = (reason) => ({ cause: MISS_CAUSE.ORDER, reason })
const NOW = "2026-11-05T10:00:00.000Z"
const NOW_SEC = Math.floor(Date.parse(NOW) / 1000)
const dbOrder = (over = {}) => ({ id: "o-wrapped", order_type: "dca", status: "active", expiry: NOW_SEC + 86_400, consecutive_failures: 3, last_attempt_at: null, ...over })

// The node's / the provider's answers (viem-wrapped-errors.fixture.mjs `spec`).
const PROVIDER_503 = { http: 503, body: "Service Unavailable" }
const PROVIDER_429 = { http: 429, body: "Too Many Requests" }
const PROVIDER_HANG = { hang: true }
const NODE_INSUFFICIENT_FUNDS = { rpc: { code: -32000, message: "insufficient funds for gas * price + value: balance 0, tx cost 21000000000000" } }
const NODE_NONCE_TOO_LOW = { rpc: { code: -32000, message: "nonce too low: next nonce 7, tx nonce 5" } }
const REVERT_CUSTOM = { rpc: { code: 3, message: "execution reverted", data: INSUFFICIENT_OUTPUT_DATA } }
const REVERT_GETH = { rpc: { code: -32000, message: "execution reverted: InsufficientOutput" } }
const REVERT_FUNDS_TEXT = { rpc: { code: 3, message: "execution reverted: insufficient funds for transfer", data: revertStringData("insufficient funds for transfer") } }

let stub
before(async () => {
  stub = await startRpcStub()
})
after(async () => {
  await stub.stop()
})

/** Every error in the chain, outermost first (viem's BaseError.walk). */
const chain = (err) => chainNames(err).join(" > ")
const hasInChain = (err, Cls) => err instanceof BaseError && err.walk((e) => e instanceof Cls) !== null

describe("[A73b S-7] wrapped keeper-side node errors — the viem wrappers are not revert evidence", () => {
  test("write site: the node's 'insufficient funds' at eth_estimateGas arrives as CFEE > TEE > InsufficientFundsError > EGEE > … ⇒ infra keeper-gas", async () => {
    const err = await stub.writeError(NODE_INSUFFICIENT_FUNDS)
    assert.ok(err instanceof ContractFunctionExecutionError, chain(err))
    assert.ok(hasInChain(err, TransactionExecutionError) && hasInChain(err, EstimateGasExecutionError) && hasInChain(err, InsufficientFundsError), chain(err))
    assert.equal(chain(err), "ContractFunctionExecutionError > TransactionExecutionError > InsufficientFundsError > EstimateGasExecutionError > InsufficientFundsError > InvalidInputRpcError > RpcRequestError > <rpc body>")
    assert.deepEqual(classifyMissCause({ err }), infra("keeper-gas"))
  })
  test("write site: the node's 'insufficient funds' at eth_sendRawTransaction (CFEE > TEE > InsufficientFundsError > …) ⇒ infra keeper-gas", async () => {
    const err = await stub.writeError(NODE_INSUFFICIENT_FUNDS, { failAt: "eth_sendRawTransaction" })
    assert.equal(chain(err), "ContractFunctionExecutionError > TransactionExecutionError > InsufficientFundsError > InvalidInputRpcError > RpcRequestError > <rpc body>")
    assert.deepEqual(classifyMissCause({ err }), infra("keeper-gas"))
  })
  test("read site: the node's 'insufficient funds' on eth_call (CFEE > CallExecutionError > InsufficientFundsError > …) ⇒ infra keeper-gas", async () => {
    const err = await stub.readError(NODE_INSUFFICIENT_FUNDS)
    assert.equal(chain(err), "ContractFunctionExecutionError > CallExecutionError > InsufficientFundsError > InvalidInputRpcError > RpcRequestError > <rpc body>")
    assert.deepEqual(classifyMissCause({ err }), infra("keeper-gas"))
  })
  test("write site: the keeper's tx nonce rejected (CFEE > TEE > NonceTooLowError > …) at estimate and at send ⇒ infra keeper-nonce", async () => {
    const atEstimate = await stub.writeError(NODE_NONCE_TOO_LOW)
    assert.ok(hasInChain(atEstimate, NonceTooLowError), chain(atEstimate))
    assert.equal(chain(atEstimate), "ContractFunctionExecutionError > TransactionExecutionError > NonceTooLowError > EstimateGasExecutionError > NonceTooLowError > InvalidInputRpcError > RpcRequestError > <rpc body>")
    assert.deepEqual(classifyMissCause({ err: atEstimate }), infra("keeper-nonce"))
    const atSend = await stub.writeError(NODE_NONCE_TOO_LOW, { failAt: "eth_sendRawTransaction" })
    assert.equal(chain(atSend), "ContractFunctionExecutionError > TransactionExecutionError > NonceTooLowError > InvalidInputRpcError > RpcRequestError > <rpc body>")
    assert.deepEqual(classifyMissCause({ err: atSend }), infra("keeper-nonce"))
  })
  test("S-7 end to end: a wrapped keeper-gas miss leaves the ladder untouched (kind infra, count 3 stays 3, order active)", async () => {
    const err = await stub.writeError(NODE_INSUFFICIENT_FUNDS)
    const plan = planFailureHandling({ dbOrder: dbOrder(), err, prevFailures: 3, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "infra")
    assert.equal(plan.cause, MISS_CAUSE.INFRA)
    assert.equal(plan.causeReason, "keeper-gas")
    assert.equal(plan.failures, 3)
    assert.equal(plan.patch.status, "active")
    assert.equal("consecutive_failures" in plan.patch, false)
  })

  describe("the [A73 S-2] guard still holds with REAL reverts — positive evidence in the chain", () => {
    test("read site: a coded revert (code 3 + InsufficientOutput data) arrives as CFEE > ContractFunctionRevertedError > … ⇒ order revert", async () => {
      const err = await stub.readError(REVERT_CUSTOM)
      assert.ok(hasInChain(err, ContractFunctionRevertedError), chain(err))
      assert.equal(chain(err), "ContractFunctionExecutionError > ContractFunctionRevertedError > CallExecutionError > ExecutionRevertedError > RpcRequestError > <rpc body>")
      assert.deepEqual(classifyMissCause({ err }), order("revert"))
      assert.deepEqual(classifyMissCause({ err, executorErrorName: "InsufficientOutput" }), order("revert:InsufficientOutput"))
    })
    test("write site: a coded revert at eth_estimateGas (CFEE > CFRE > TEE > ExecutionRevertedError > EGEE > …) ⇒ order revert", async () => {
      const err = await stub.writeError(REVERT_CUSTOM)
      assert.ok(hasInChain(err, ContractFunctionRevertedError) && hasInChain(err, ExecutionRevertedError), chain(err))
      assert.equal(chain(err), "ContractFunctionExecutionError > ContractFunctionRevertedError > TransactionExecutionError > ExecutionRevertedError > EstimateGasExecutionError > ExecutionRevertedError > RpcRequestError > <rpc body>")
      assert.deepEqual(classifyMissCause({ err }), order("revert"))
    })
    test("both sites: a geth-style revert (-32000 'execution reverted: …', no data) ⇒ order revert", async () => {
      const read = await stub.readError(REVERT_GETH)
      assert.ok(hasInChain(read, ExecutionRevertedError), chain(read))
      assert.deepEqual(classifyMissCause({ err: read }), order("revert"))
      const write = await stub.writeError(REVERT_GETH)
      assert.ok(hasInChain(write, ExecutionRevertedError), chain(write))
      assert.deepEqual(classifyMissCause({ err: write }), order("revert"))
    })
    test("both sites: a revert whose Error(string) says 'insufficient funds for transfer' is the CONTRACT talking ⇒ order revert, never keeper-gas", async () => {
      const read = await stub.readError(REVERT_FUNDS_TEXT)
      assert.ok(hasInChain(read, ContractFunctionRevertedError), chain(read))
      assert.deepEqual(classifyMissCause({ err: read }), order("revert"))
      const write = await stub.writeError(REVERT_FUNDS_TEXT)
      assert.ok(hasInChain(write, ContractFunctionRevertedError), chain(write))
      assert.deepEqual(classifyMissCause({ err: write }), order("revert"))
    })
  })

  test("the error objects are viem's own (this directory's node_modules), not hand-built", async () => {
    const err = await stub.writeError(PROVIDER_503)
    assert.ok(err instanceof BaseError && err instanceof ContractFunctionExecutionError)
    assert.ok(hasInChain(err, HttpRequestError))
    assert.equal(typeof err.walk, "function")
    assert.equal(err.version, (await import("viem/package.json", { with: { type: "json" } })).default.version)
  })
  test("fixture sanity: a hung provider yields viem's TimeoutError inside the wrappers, at both sites", async () => {
    const read = await stub.readError(PROVIDER_HANG)
    assert.ok(hasInChain(read, TimeoutError), chain(read))
    const write = await stub.writeError(PROVIDER_HANG)
    assert.ok(hasInChain(write, TimeoutError), chain(write))
  })
  test("fixture sanity: a 429 provider page is an HttpRequestError(429) inside the wrappers", async () => {
    const read = await stub.readError(PROVIDER_429)
    assert.ok(hasInChain(read, HttpRequestError), chain(read))
    assert.equal(read.walk((e) => e instanceof HttpRequestError).status, 429)
  })
})

describe("[A73b S-8] wrapped provider / transport failures at both executor sites ⇒ infra, never a revert", () => {
  const SITES = [
    ["read canExecute (executor.js readContract)", (spec) => stub.readError(spec)],
    ["write executeOrder @ eth_estimateGas (executor.js writeContract)", (spec) => stub.writeError(spec)],
    ["write executeOrder @ eth_sendRawTransaction", (spec) => stub.writeError(spec, { failAt: "eth_sendRawTransaction" })],
  ]
  // The matrix: the provider's answer → the innermost viem error in the wrapped chain → the class.
  // The last two are provider pages whose words look like a PERMANENT order cause (PERMANENT_SIGNATURES
  // `insufficient balance` / `exceeds allowance`): transport anywhere in the chain decides, before any
  // text rule — a page can say anything, and a terminal `failed` for it would burn the order outright.
  const MATRIX = [
    ["HTTP 503", PROVIDER_503, HttpRequestError, infra("rpc-transport")],
    ["HTTP 429", PROVIDER_429, HttpRequestError, infra("rpc-transport")],
    ["HTTP 502 (an HTML page)", { http: 502, body: "<html><body>502 Bad Gateway</body></html>" }, HttpRequestError, infra("rpc-transport")],
    ["timeout (a hung provider)", PROVIDER_HANG, TimeoutError, infra("rpc-transport")],
    ["HTTP 403 (allowlist)", { http: 403, body: "Unspecified origin not on whitelist." }, HttpRequestError, infra("rpc-auth")],
    ["HTTP 503 whose page says 'insufficient balance'", { http: 503, body: "insufficient balance on this plan — upgrade to continue" }, HttpRequestError, infra("rpc-transport")],
    ["HTTP 402 whose page says 'exceeds allowance'", { http: 402, body: "daily request volume exceeds allowance for this key" }, HttpRequestError, infra("rpc-transport")],
  ]
  for (const [site, build] of SITES) {
    for (const [what, spec, Inner, expected] of MATRIX) {
      test(`${site}: ${what} ⇒ ${expected.cause}:${expected.reason}`, async () => {
        const err = await build(spec)
        assert.ok(err instanceof ContractFunctionExecutionError, chain(err))
        assert.ok(hasInChain(err, Inner), chain(err))
        assert.deepEqual(classifyMissCause({ err }), expected, chain(err))
      })
    }
  }
  test("S-8 end to end: a wrapped 503 at the write site leaves the ladder untouched (kind infra, count 3 stays 3, order active)", async () => {
    const err = await stub.writeError(PROVIDER_503)
    const plan = planFailureHandling({ dbOrder: dbOrder(), err, prevFailures: 3, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "infra")
    assert.equal(plan.causeReason, "rpc-transport")
    assert.equal(plan.failures, 3)
    assert.equal(plan.patch.status, "active")
    assert.equal("consecutive_failures" in plan.patch, false)
  })
  test("S-8 end to end: a wrapped timeout at the read site (canExecute) leaves the ladder untouched", async () => {
    const err = await stub.readError(PROVIDER_HANG)
    const plan = planFailureHandling({ dbOrder: dbOrder({ consecutive_failures: 7 }), err, prevFailures: 7, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "infra")
    assert.equal(plan.causeReason, "rpc-transport")
    assert.equal(plan.failures, 7)
    assert.equal(plan.patch.status, "active")
  })
  test("S-8 end to end: a provider page saying 'insufficient balance' is NOT a terminal failure (the order is not marked failed)", async () => {
    const err = await stub.writeError({ http: 503, body: "insufficient balance on this plan" })
    const plan = planFailureHandling({ dbOrder: dbOrder(), err, prevFailures: 3, nowSec: NOW_SEC, nowIso: NOW })
    assert.equal(plan.kind, "infra")
    assert.notEqual(plan.patch.status, "failed")
    assert.equal(plan.patch.error, undefined)
  })
})
