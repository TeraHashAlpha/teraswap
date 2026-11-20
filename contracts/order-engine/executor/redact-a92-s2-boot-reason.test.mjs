// [A92 S-2] (Medium, new in round 1) A boot refusal lost its revert reason. chain-verify.js's errText embedded viem's
// short message, which for a revert is TWO lines ("The contract function "X" reverted with the following reason:" then
// the reason), and executor.js prints the refusal through redactError, which keeps the first line of a message: the
// operator read "…reverted with the following reason:" and nothing after it. errText is one line now.
//
// The two boots below are the REAL executor.js against a JSON-RPC double whose `ORDER_TYPEHASH()` (the chain gate,
// executor.js:2444) or `whitelistedExecutors(signer)` (the instance gate, executor.js:2477) reverts with a reason; the
// signer comes from a KMS double serving the public key of a throwaway test key (as in boot-identity.test.mjs).
//
// Run: node --test contracts/order-engine/executor/redact-a92-s2-boot-reason.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeAbiParameters, hexToBytes, toFunctionSelector } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import { EXPECTED_ORDER_TYPEHASH_V3, verifyChainBinding } from "./chain-verify.js"
import { revertStringData } from "./viem-wrapped-errors.fixture.mjs"

const EXECUTOR = fileURLToPath(new URL("./executor.js", import.meta.url))
const ARBITRUM = 42161
const V3_ADDRESS = "0x0000000000000000000000000000000000000a92"
const SOME_CODE = "0x60806040" + "00".repeat(64)
const SEL_ORDER_TYPEHASH = toFunctionSelector("ORDER_TYPEHASH()")
const SEL_WHITELISTED = toFunctionSelector("whitelistedExecutors(address)")
const BOOL_TRUE = encodeAbiParameters([{ type: "bool" }], [true])
// A throwaway test key (never a literal 64-hex secret): 0x1111…11 is a valid secp256k1 scalar. Only its PUBLIC key
// leaves this file, through the KMS double; a boot never signs.
const TEST_ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`)
const SPKI_HEADER = "3056301006072a8648ce3d020106052b8104000a034200"
const PUBKEY_DER = Buffer.concat([Buffer.from(SPKI_HEADER, "hex"), Buffer.from(hexToBytes(TEST_ACCOUNT.publicKey))])

const TYPEHASH_REASON = "A92 typehash gate says no"
const WHITELIST_REASON = "A92 whitelist read says no"
const revert = (id, reason) => ({ jsonrpc: "2.0", id, error: { code: 3, message: `execution reverted: ${reason}`, data: revertStringData(reason) } })

const cwds = []
after(() => {
  for (const dir of cwds) rmSync(dir, { recursive: true, force: true })
})

/** Boot executor.js; `revertAt` is "ORDER_TYPEHASH" or "whitelistedExecutors" (that read reverts with a reason). */
async function boot(revertAt) {
  const seen = []
  const rpc = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const answer = (call) => {
        seen.push(call.method)
        if (call.method === "eth_chainId") return { jsonrpc: "2.0", id: call.id, result: `0x${ARBITRUM.toString(16)}` }
        if (call.method === "eth_getCode") return { jsonrpc: "2.0", id: call.id, result: SOME_CODE }
        if (call.method === "eth_call") {
          const data = String(call.params?.[0]?.data || "")
          if (data.startsWith(SEL_ORDER_TYPEHASH)) {
            return revertAt === "ORDER_TYPEHASH" ? revert(call.id, TYPEHASH_REASON) : { jsonrpc: "2.0", id: call.id, result: EXPECTED_ORDER_TYPEHASH_V3 }
          }
          if (data.startsWith(SEL_WHITELISTED)) {
            seen.push("eth_call:whitelistedExecutors")
            return revertAt === "whitelistedExecutors" ? revert(call.id, WHITELIST_REASON) : { jsonrpc: "2.0", id: call.id, result: BOOL_TRUE }
          }
        }
        // Everything past the gates errors, so the child exits on its own.
        return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: `test double: ${call.method} not served` } }
      }
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.writeHead(400).end("{}")
        return
      }
      const out = Array.isArray(payload) ? payload.map(answer) : answer(payload)
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out))
    })
  })
  const kms = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      const op = String(req.headers["x-amz-target"] || "").split(".")[1] || ""
      seen.push(`kms:${op}`)
      if (op === "GetPublicKey") {
        res.writeHead(200, { "content-type": "application/x-amz-json-1.1" }).end(
          JSON.stringify({ KeyId: "arn:aws:kms:eu-north-1:000000000000:key/test-double", PublicKey: PUBKEY_DER.toString("base64"), KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY", SigningAlgorithms: ["ECDSA_SHA_256"] }),
        )
        return
      }
      res.writeHead(400, { "content-type": "application/x-amz-json-1.1" }).end(JSON.stringify({ __type: "ValidationException", message: `test double: ${op} not served` }))
    })
  })
  await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve))
  await new Promise((resolve) => kms.listen(0, "127.0.0.1", resolve))
  const cwd = mkdtempSync(join(tmpdir(), "a92-s2-boot-"))
  cwds.push(cwd)
  const child = spawn(process.execPath, [EXECUTOR], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RPC_URL: `http://127.0.0.1:${rpc.address().port}`,
      CHAIN_ID: String(ARBITRUM),
      ORDER_EXECUTOR_V3_ADDRESS: V3_ADDRESS,
      SUPABASE_URL: "http://127.0.0.1:9/unused",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      KMS_KEY_ID: "alias/test-double",
      KMS_REGION: "eu-north-1",
      AWS_ENDPOINT_URL_KMS: `http://127.0.0.1:${kms.address().port}`,
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_EC2_METADATA_DISABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (c) => (stdout += c))
  child.stderr.on("data", (c) => (stderr += c))
  const exitCode = await new Promise((resolve) => {
    // A guard against a boot that never ends, not a wait: each refusal takes a few seconds (3 attempts, 1 s apart).
    const kill = setTimeout(() => {
      child.kill("SIGKILL")
      resolve("KILLED")
    }, 25_000)
    child.on("exit", (code) => {
      clearTimeout(kill)
      resolve(code)
    })
  })
  await new Promise((resolve) => rpc.close(resolve))
  await new Promise((resolve) => kms.close(resolve))
  return { exitCode, stdout, stderr, seen }
}

describe("[A92 S-2] a boot refusal prints the revert reason on the refusal line", { concurrency: true }, () => {
  test("ORDER_TYPEHASH() reverts with a reason (executor.js:2444)", { timeout: 60_000 }, async () => {
    const run = await boot("ORDER_TYPEHASH")
    assert.equal(run.exitCode, 1, run.stderr)
    const line = run.stderr.split("\n").find((l) => l.includes("could not read ORDER_TYPEHASH()"))
    assert.ok(line, `no refusal line in:\n${run.stderr}`)
    assert.ok(line.includes(`reverted with the following reason: ${TYPEHASH_REASON}`), `the reason is not on the printed line: ${line}`)
    assert.match(run.stderr, /Refusing to boot/)
    assert.ok(!run.seen.includes("kms:GetPublicKey"), "the chain gate refused before the signer")
  })

  test("whitelistedExecutors(signer) reverts with a reason (executor.js:2477)", { timeout: 60_000 }, async () => {
    const run = await boot("whitelistedExecutors")
    assert.equal(run.exitCode, 1, run.stderr)
    assert.ok(run.seen.includes("eth_call:whitelistedExecutors"), `the boot never reached the instance gate: ${run.seen.join(", ")}\n${run.stderr}`)
    const line = run.stderr.split("\n").find((l) => l.includes("could not read whitelistedExecutors("))
    assert.ok(line, `no refusal line in:\n${run.stderr}`)
    assert.ok(line.includes(TEST_ACCOUNT.address), "the line names the signer")
    assert.ok(line.includes(`reverted with the following reason: ${WHITELIST_REASON}`), `the reason is not on the printed line: ${line}`)
    assert.match(run.stderr, /Refusing to boot/)
  })
})

describe("[A92 S-2] errText is one line, whatever the line breaks", () => {
  test("\\n, \\r\\n, a lone \\r and blank lines become single spaces", async () => {
    const provider = {
      getChainId: async () => ARBITRUM,
      getCode: async () => SOME_CODE,
      readContract: async () => {
        throw Object.assign(new Error("unused"), { shortMessage: "first:\r\nsecond\rthird\n\n   fourth  " })
      },
    }
    const err = await verifyChainBinding({
      provider,
      chainId: ARBITRUM,
      contracts: [{ label: "v3", address: V3_ADDRESS, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V3 }],
      attempts: 1,
      sleep: async () => {},
    }).then(
      () => null,
      (e) => e,
    )
    assert.equal(err?.name, "ChainVerificationError")
    assert.ok(err.message.includes("after 1 attempt(s): first: second third fourth — the address"), err.message)
    assert.ok(!/[\r\n]/.test(err.message), JSON.stringify(err.message))
  })
})
