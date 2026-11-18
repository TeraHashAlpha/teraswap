// [A93 R2-3] (Low, pre-existing) chain-verify's errText read viem's short message only: for a JSON-RPC error that is
// generic ("Missing or invalid parameters.") and the provider's own words — viem's `details` — never reached the boot
// refusal. They are now appended (` — details: …`), redacted (redactUrls, then every configured secret by value), cut to
// 300 characters after the scrub, and the refusal stays one line.
//
// The configured RPC_URL carries the DUMMY key; it is set before redact.js is first used (the list is built once).
//
// Run: node --test contracts/order-engine/executor/redact-a93-r2-3-boot-details.test.mjs

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"

const KEY = "A93bootKeyT6v1Rq8Ws3"
process.env.RPC_URL = `https://base-mainnet.g.alchemy.example/v2/${KEY}`

const { verifyChainBinding, createRpcProbe, EXPECTED_ORDER_TYPEHASH_V3 } = await import("./chain-verify.js")
const { redactError } = await import("./redact.js")
const { createPublicClient, http } = await import("viem")

const ADDRESS = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"

/** The ChainVerificationError a provider whose eth_chainId throws `err` produces (one attempt). */
async function refusal(err) {
  const provider = {
    getChainId: async () => {
      throw err
    },
    getCode: async () => "0x60",
    readContract: async () => EXPECTED_ORDER_TYPEHASH_V3,
  }
  const out = await verifyChainBinding({
    provider,
    chainId: 8453,
    contracts: [{ label: "v3", address: ADDRESS, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V3 }],
    attempts: 1,
    sleep: async () => {},
  }).then(
    () => null,
    (e) => e,
  )
  assert.equal(out?.name, "ChainVerificationError")
  assert.ok(!/[\r\n]/.test(out.message), `not one line: ${JSON.stringify(out.message)}`)
  assert.ok(!out.message.includes(KEY), out.message)
  return out
}
const viemLike = (shortMessage, details) => Object.assign(new Error(`${shortMessage}\n\nDetails: ${details}\nVersion: viem@2.47.10`), { shortMessage, details })

describe("[A93 R2-3] a boot refusal carries the provider's words, redacted, on one line", () => {
  test("a path echoed with no host: the key goes, the words stay", async () => {
    const err = await refusal(viemLike("Missing or invalid parameters.", `no route for /v2/${KEY}`))
    assert.ok(err.message.includes(`after 1 attempt(s): Missing or invalid parameters. — details: no route for /v2/<redacted> — refusing to boot`), err.message)
  })

  test("a full URL in the details is redacted whole (redactUrls)", async () => {
    const err = await refusal(viemLike("RPC Request failed.", `upstream refused https://rpc.example.org/v2/${KEY}`))
    assert.ok(err.message.includes("— details: upstream refused <redacted-url> —"), err.message)
  })

  test("multi-line details become one line", async () => {
    const err = await refusal(viemLike("RPC Request failed.", "first line\r\n  second line\n\nthird"))
    assert.ok(err.message.includes("— details: first line second line third —"), err.message)
  })

  test("details the short message already says are not repeated; no details, no suffix", async () => {
    const same = await refusal(Object.assign(new Error("boom"), { shortMessage: "provider said boom", details: "boom" }))
    assert.ok(same.message.includes(": provider said boom — refusing to boot"), same.message)
    const none = await refusal(new Error("plain failure"))
    assert.ok(none.message.includes(": plain failure — refusing to boot"), none.message)
    const throwing = Object.defineProperty(new Error("getter"), "details", {
      get() {
        throw new Error("hostile")
      },
    })
    assert.ok((await refusal(throwing)).message.includes(": getter — refusing to boot"))
  })

  test("long details are cut to 300 characters AFTER the scrub: a key at the cut is never left in half", async () => {
    // Raw, the key spans characters 290-310: a cut at 300 before the scrub would leave its first 10 characters.
    const details = `${"x".repeat(285)} /v2/${KEY} ${"y".repeat(400)}`
    const err = await refusal(viemLike("RPC Request failed.", details))
    const after = err.message.split(" — details: ")[1]
    assert.ok(after.startsWith(`${"x".repeat(285)} /v2/<redacted>… —`), after.slice(0, 340))
    for (let i = 0; i + 6 <= KEY.length; i++) assert.ok(!err.message.includes(KEY.slice(i, i + 6)), `a fragment of the key: ${KEY.slice(i, i + 6)}`)
  })
})

describe("[A93 R2-3] a real viem error from a JSON-RPC provider, and the line executor.js prints", () => {
  const sockets = new Set()
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const call = JSON.parse(raw)
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: `no route for /v2/${KEY}` } }))
    })
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  after(async () => {
    for (const s of sockets) s.destroy()
    if (server.listening) {
      server.close()
      await once(server, "close")
    }
  })

  test("eth_chainId answered with a JSON-RPC error", async () => {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${server.address().port}/v2/${KEY}`, { retryCount: 0 }) })
    const err = await refusal(await createRpcProbe(client).getChainId().then(() => assert.fail("no error"), (e) => e))
    assert.ok(err.message.includes("— details: no route for /v2/<redacted> — refusing to boot"), err.message)
    const printed = redactError(err) // executor.js:2444
    assert.ok(!printed.includes("\n") && !printed.includes(KEY), printed)
    assert.ok(printed.includes("Missing or invalid parameters. Double check you have provided the correct parameters. — details: no route for /v2/<redacted> —"), printed)
  })
})
