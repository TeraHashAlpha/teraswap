// [A73d L-2] A JSON-RPC -32603 that carries the provider's auth words is an AUTH rejection.
//
// viem's getContractError wraps ANY -32603 (InternalRpcError) in a ContractFunctionRevertedError — a
// GUESS: no contract code ran. classifyRpcError took that name as a revert ("never auth") and
// labelled a provider's `Unspecified origin not on whitelist.` TRANSIENT, so classifyMissCause said
// `rpc-transport` instead of `rpc-auth` and the monitor never counted it: no paused state, no alert
// (the miss was still infra, never the order's). retry-policy.js already refuses viem's guess
// (A73c S-12: an InternalRpcError chain is a revert only with an ExecutionRevertedError or hex revert
// data); the auth check now sees through it the same way.
//
// Errors are REAL viem 2.47.10 objects: publicClient.readContract(canExecute) /
// walletClient.writeContract(executeOrder) against the local JSON-RPC stub (no network).
//
// Run: node --test contracts/order-engine/executor/rpc-auth-internal-rpc-error.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { startRpcStub, chainNames, revertStringData } from "./viem-wrapped-errors.fixture.mjs"
import { classifyRpcError, createRpcAuthMonitor, RPC_AUTH, RPC_TRANSIENT } from "./rpc-auth.js"
import { classifyMissCause } from "./retry-policy.js"

const stub = await startRpcStub()
after(() => stub.stop())

const WHITELIST = "Unspecified origin not on whitelist."
const REVERT_DATA = revertStringData("not on whitelist") // a genuine Error(string) revert payload

describe("[A73d L-2] -32603 + auth words ⇒ auth (still infra)", () => {
  test("readContract: the real chain is ContractFunctionRevertedError over an InternalRpcError (viem's guess)", async () => {
    const err = await stub.readError({ rpc: { code: -32603, message: WHITELIST } })
    const names = chainNames(err)
    assert.ok(names.includes("ContractFunctionRevertedError") && names.includes("InternalRpcError"), names.join(">"))
    assert.ok(!names.includes("ExecutionRevertedError"))
    assert.deepEqual(classifyRpcError(err), { kind: RPC_AUTH, signal: "not on whitelist" })
    assert.deepEqual(classifyMissCause({ err }), { cause: "infra", reason: "rpc-auth" })
  })

  test("writeContract (eth_estimateGas) and the same body on an HTTP 403 ⇒ auth too", async () => {
    const w = await stub.writeError({ rpc: { code: -32603, message: WHITELIST } })
    assert.deepEqual(classifyRpcError(w), { kind: RPC_AUTH, signal: "not on whitelist" })
    assert.equal(classifyMissCause({ err: w }).reason, "rpc-auth")
    const http = await stub.readError({ http: 403, rpc: { code: -32603, message: WHITELIST } })
    assert.equal(http.status, undefined, "viem drops the 403 when the body is JSON-RPC")
    assert.deepEqual(classifyRpcError(http), { kind: RPC_AUTH, signal: "not on whitelist" })
  })

  test("the other auth words under -32603 (unauthorized, invalid api key, must be authenticated)", async () => {
    for (const [message, signal] of [
      ["Unauthorized", "unauthorized"],
      ["invalid API key", "invalid api key"],
      ["Must be authenticated!", "must be authenticated"],
    ]) {
      const err = await stub.readError({ rpc: { code: -32603, message } })
      assert.deepEqual(classifyRpcError(err), { kind: RPC_AUTH, signal }, message)
    }
  })

  test("the runtime monitor: 3 such errors from one origin ⇒ paused: rpc-auth and ONE alert", async () => {
    const alerts = []
    const m = createRpcAuthMonitor({ chainId: 8453, alert: async (p) => alerts.push(p) })
    const err = await stub.readError({ rpc: { code: -32603, message: WHITELIST } })
    for (let i = 0; i < 3; i++) await m.onRpcError("balance-read", err)
    assert.equal(m.state().paused, "rpc-auth")
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].signal, "not on whitelist")
  })
})

describe("[A73d L-2] what must NOT become auth", () => {
  test("a plain -32603 'Internal error' stays transient (rpc-transport)", async () => {
    const err = await stub.readError({ rpc: { code: -32603, message: "Internal error" } })
    assert.deepEqual(classifyRpcError(err), { kind: RPC_TRANSIENT, signal: null })
    assert.equal(classifyMissCause({ err }).reason, "rpc-transport")
  })

  test("-32603 with hex revert data: a contract revert, even when its reason says 'not on whitelist'", async () => {
    const err = await stub.readError({ rpc: { code: -32603, message: "not on whitelist", data: REVERT_DATA } })
    assert.equal(classifyRpcError(err).kind, RPC_TRANSIENT)
    assert.notEqual(classifyMissCause({ err }).reason, "rpc-auth")
  })

  test("a node revert (code 3, ExecutionRevertedError) saying 'not on whitelist' is the contract talking", async () => {
    const err = await stub.readError({ rpc: { code: 3, message: "execution reverted: not on whitelist", data: REVERT_DATA } })
    assert.ok(chainNames(err).includes("ExecutionRevertedError"))
    assert.equal(classifyRpcError(err).kind, RPC_TRANSIENT)
  })

  test("-32603 whose message says 'execution reverted' is a revert even with auth words next to it", async () => {
    const err = await stub.readError({ rpc: { code: -32603, message: "execution reverted: unauthorized" } })
    assert.equal(classifyRpcError(err).kind, RPC_TRANSIENT)
  })

  test("a non-401/403 HTTP status wins (A71 L-2 unchanged): a 503 page with auth words is transient", async () => {
    const err = await stub.readError({ http: 503, body: "Service Unavailable: unauthorized upstream" })
    assert.equal(classifyRpcError(err).kind, RPC_TRANSIENT)
  })

  test("control: the same words under -32600 were already auth", async () => {
    const err = await stub.readError({ rpc: { code: -32600, message: WHITELIST } })
    assert.deepEqual(classifyRpcError(err), { kind: RPC_AUTH, signal: "not on whitelist" })
  })
})
