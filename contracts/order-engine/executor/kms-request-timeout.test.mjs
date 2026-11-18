// [A91 / owner answer 3 of 2026-11-18] Every external await of the keeper's cycle has a limit. The AWS SDK sets none
// on its requests by default (smithy node-http-handler: requestTimeout 0, socketTimeout 0), so a KMS endpoint that
// accepts the connection and never answers held the signing call — and the one-at-a-time cycle — forever.
// kms-signer.js now sends every KMS request with an abortSignal (KMS_REQUEST_TIMEOUT_MS, 10 s).
//
// A local HTTP server that accepts and never answers stands in for KMS (AWS_ENDPOINT_URL_KMS; fixture credentials;
// nothing leaves 127.0.0.1). FAILED on 16fb740c (no limit: the request hung).
//
// Run: node --test contracts/order-engine/executor/kms-request-timeout.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import * as kmsSigner from "./kms-signer.js"

const VARS = ["AWS_ENDPOINT_URL_KMS", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]

test("a KMS endpoint that never answers: the request is aborted at its limit (10 s by default; 300 ms here), never a hang", async () => {
  const sockets = new Set()
  let requests = 0
  const server = createServer(() => {
    requests++ // accepted, never answered
  })
  server.on("connection", (s) => sockets.add(s))
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]))
  process.env.AWS_ENDPOINT_URL_KMS = `http://127.0.0.1:${server.address().port}`
  process.env.AWS_ACCESS_KEY_ID = "fixture-access-key-id" // not a key shape (the SDK does not check it)
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-not-a-key"
  delete process.env.AWS_SESSION_TOKEN
  delete process.env.AWS_PROFILE
  const HUNG = Symbol("hung")
  let timer
  try {
    const t0 = performance.now()
    const outcome = await Promise.race([
      kmsSigner.createKmsAccount("fixture-key", "us-east-1", { requestTimeoutMs: 300 }).then(
        () => "resolved",
        (err) => err,
      ),
      new Promise((r) => (timer = setTimeout(() => r(HUNG), 8_000))),
    ])
    const ms = performance.now() - t0
    assert.notEqual(outcome, HUNG, "the KMS request was still waiting after 8 s")
    assert.ok(outcome instanceof Error, `expected the request to fail, got ${String(outcome)}`)
    assert.match(`${outcome.name} ${outcome.message}`, /abort/i)
    assert.ok(ms < 5_000, `${Math.round(ms)} ms`)
    assert.ok(requests >= 1, "the request reached the stand-in endpoint")
    assert.equal(kmsSigner.KMS_REQUEST_TIMEOUT_MS, 10_000, "the production limit")
  } finally {
    clearTimeout(timer)
    for (const [v, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[v]
      else process.env[v] = val
    }
    for (const s of sockets) s.destroy()
    await new Promise((r) => server.close(r))
  }
})
