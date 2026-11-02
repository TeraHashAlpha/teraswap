// [A71 L-2] An HTTP status that is present and is NOT 401/403 decides the class: TRANSIENT, with no
// body matching. The audited head matched the body first, so a 429 / 5xx page that merely contains
// "unauthorized" (a CDN or proxy error page) was classed as a rejected key ⇒ paused + a HIGH alert.
//
// Errors come from viem 2.47 talking to a local HTTP server (no network). A JSON-RPC body carries NO
// HTTP status in viem's error chain, so the whitelist case is still decided by the provider's words.
//
// Run: node --test contracts/order-engine/executor/rpc-auth-status.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { HttpRequestError, createPublicClient, http } from "viem"
import { classifyRpcError, RPC_AUTH, RPC_TRANSIENT } from "./rpc-auth.js"

const KEY = "TESTKEY"
const answers = {
  "text503-unauthorized": [503, "text/plain", "Service Unavailable: unauthorized upstream"],
  "text429-unauthorized": [429, "text/plain", "Too Many Requests (unauthorized burst)"],
  "html502-invalid-key": [502, "text/html", "<html><body>Bad Gateway: invalid api key at origin</body></html>"],
  "text401": [401, "text/plain", "Must be authenticated!"],
  "html403": [403, "text/html", "<html>Forbidden</html>"],
  "json403-whitelist": [403, "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Unspecified origin not on whitelist." } })],
}
let mode
const srv = createServer((_req, res) => {
  const [status, type, body] = answers[mode]
  res.writeHead(status, { "content-type": type })
  res.end(body)
})
await new Promise((r) => srv.listen(0, "127.0.0.1", r))
after(() => srv.close())
const client = createPublicClient({ transport: http(`http://127.0.0.1:${srv.address().port}/v2/${KEY}`, { retryCount: 0 }) })
async function viemError(m) {
  mode = m
  return client.getBlockNumber().then(() => assert.fail("expected a rejection"), (e) => e)
}

describe("[A71 L-2] a non-401/403 HTTP status is transient — its body is never matched", () => {
  for (const m of ["text503-unauthorized", "text429-unauthorized", "html502-invalid-key"]) {
    test(`${m} → transient`, async () => {
      const err = await viemError(m)
      assert.equal(err.name, "HttpRequestError", "viem keeps the HTTP status for a non-JSON body")
      assert.deepEqual(classifyRpcError(err), { kind: RPC_TRANSIENT, signal: null })
    })
  }

  test("the same words with a 401/403, or with no HTTP status at all (JSON-RPC body), are still auth", async () => {
    assert.deepEqual(classifyRpcError(await viemError("text401")), { kind: RPC_AUTH, signal: "HTTP 401" })
    assert.deepEqual(classifyRpcError(await viemError("html403")), { kind: RPC_AUTH, signal: "HTTP 403" })
    const json = await viemError("json403-whitelist")
    assert.equal(json.status, undefined, "viem drops the 403 when the body is JSON-RPC")
    assert.deepEqual(classifyRpcError(json), { kind: RPC_AUTH, signal: "not on whitelist" })
  })

  test("a status anywhere in the cause chain counts (a wrapped 503 with auth words is transient)", () => {
    const inner = new HttpRequestError({ url: `https://base-mainnet.g.alchemy.com/v2/${KEY}`, status: 503, details: "unauthorized" })
    const outer = new Error("readContract failed: unauthorized", { cause: inner })
    assert.equal(classifyRpcError(outer).kind, RPC_TRANSIENT)
  })
})
