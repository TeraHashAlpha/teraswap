// [A96 R3-3] (Low) chain-verify's errText scrubbed the provider's `details` by value but not the HEAD of the boot refusal:
// the head went through redactUrls and `flatten` (a line break becomes a plain space) and never through the secret scrub.
// A revert reason with the key split over two lines became `half half`, which no scrub can rejoin (a plain space that
// touches no line break is an ordinary character), and the dedupe `head.includes(details)` compared the unscrubbed head
// with the scrubbed details and missed, so the provider's words printed twice. The head now gets the literal scrub FIRST
// (before redactUrls, before the flatten); head and details are then both scrubbed and the dedupe compares like with like.
//
// The configured RPC_URL carries the DUMMY key; it is set before redact.js is first used (the list is built once).
//
// Run: node --test contracts/order-engine/executor/redact-a96-r3-3-boot-head.test.mjs

import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"

const KEY = "A96bootHeadKeyW7p3Zt9Q"
process.env.RPC_URL = `https://base-mainnet.g.alchemy.example/v2/${KEY}`

const { verifyChainBinding, createRpcProbe, EXPECTED_ORDER_TYPEHASH_V3 } = await import("./chain-verify.js")
const { redactError } = await import("./redact.js")
const { createPublicClient, http } = await import("viem")

const ADDRESS = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
const WORDS = "vault refused the caller"

/** The ChainVerificationError a provider whose `method` throws `err` produces (one attempt). */
async function refusal(err, method = "getChainId") {
  const provider = {
    getChainId: async () => 8453,
    getCode: async () => "0x60",
    readContract: async () => EXPECTED_ORDER_TYPEHASH_V3,
    [method]: async () => {
      throw err
    },
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
  return out
}
const viemLike = (shortMessage, details) => Object.assign(new Error(`${shortMessage}\n\nDetails: ${details}\nVersion: viem@2.47.10`), { shortMessage, details })

/** No 12-character run of the key (any case, blanks and breaks removed) anywhere in `text`. */
function assertNoKeyRun(text, label) {
  const flat = text.toLowerCase().replace(/[ \t]*[\r\n][\r\n \t]*/g, "")
  const key = KEY.toLowerCase()
  for (let i = 0; i + 12 <= key.length; i++) assert.ok(!flat.includes(key.slice(i, i + 12)), `${label}: a 12-character run of the key (${key.slice(i, i + 12)}) is in:\n${text}`)
  // The halves too: the part before the break is on the boot line only if the head was not scrubbed.
  assert.ok(!flat.includes(key.slice(0, 11)) && !flat.includes(key.slice(11)), `${label}: a half of the key is in:\n${text}`)
}

const count = (text, word) => text.split(word).length - 1

describe("[A96 R3-3] the head of a boot refusal is scrubbed by value, before the flatten", () => {
  const SPLITS = {
    "LF": (a, b) => `${a}\n${b}`,
    "LF and indentation": (a, b) => `${a}\n      ${b}`,
    "CRLF": (a, b) => `${a}\r\n${b}`,
    "a lone CR": (a, b) => `${a}\r${b}`,
  }

  for (const [name, split] of Object.entries(SPLITS)) {
    test(`a revert reason with the key split by ${name}: no run of the key on the boot line, the provider's words once`, async () => {
      const reason = `${WORDS}: ${split(KEY.slice(0, 11), KEY.slice(11))}`
      // viem: shortMessage = the reason on the following line(s); details = the node's own words, the same reason.
      const err = viemLike(`The contract function "ORDER_TYPEHASH" reverted with the following reason:\n${reason}`, reason)
      const refused = await refusal(err, "readContract")
      assertNoKeyRun(refused.message, name)
      assert.equal(count(refused.message, WORDS), 1, `the provider's words must be printed once:\n${refused.message}`)
      assert.ok(refused.message.includes(`${WORDS}: <redacted>`), refused.message)
      assert.ok(!refused.message.includes("— details:"), `the details the head already says are not repeated:\n${refused.message}`)
    })
  }

  test("the same, at eth_chainId and at eth_getCode", async () => {
    for (const method of ["getChainId", "getCode"]) {
      const reason = `${WORDS}: ${KEY.slice(0, 8)}\n${KEY.slice(8)}`
      const refused = await refusal(viemLike(`RPC Request failed.\n${reason}`, reason), method)
      assertNoKeyRun(refused.message, method)
      assert.equal(count(refused.message, WORDS), 1, `${method}:\n${refused.message}`)
    }
  })

  test("the key whole in the head is removed too (the head had no scrub by value at all), and the words are printed once", async () => {
    const reason = `${WORDS}: ${KEY}`
    const refused = await refusal(viemLike(`reverted with the following reason:\n${reason}`, reason), "readContract")
    assert.ok(!refused.message.includes(KEY), refused.message)
    assert.equal(count(refused.message, WORDS), 1, refused.message)
  })

  test("what is not a secret stays in the head: tx hash, address, revert reason, RPC host", async () => {
    const TX = `0x${"ab12".repeat(16)}`
    const head = `Order 0b3c9e1a tx ${TX} to ${ADDRESS} reverted with the following reason:\nOrder expired via https://rpc.example.org`
    const refused = await refusal(Object.assign(new Error(head), { shortMessage: head }), "readContract")
    // the 64-hex tx hash is the one thing chain-verify's own redactUrls always masks (HEX_SECRET); the rest stays
    for (const kept of [ADDRESS, "0b3c9e1a", "Order expired"]) assert.ok(refused.message.includes(kept), `lost ${kept}:\n${refused.message}`)
  })

  test("the provider's words, when the details add something, are still appended once", async () => {
    const refused = await refusal(viemLike("Missing or invalid parameters.", `${WORDS}: ${KEY.slice(0, 11)}\n${KEY.slice(11)}`))
    assertNoKeyRun(refused.message, "details")
    assert.equal(count(refused.message, WORDS), 1, refused.message)
    assert.ok(refused.message.includes(`Missing or invalid parameters. — details: ${WORDS}: <redacted> —`), refused.message)
  })
})

describe("[A96 R3-3] a REAL viem HttpRequestError whose body holds the key split by a line break, at the boot refusal", () => {
  const sockets = new Set()
  const server = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(404, { "content-type": "text/plain" }).end(`${WORDS}: /v2/${KEY.slice(0, 11)}\n   ${KEY.slice(11)} (404)`)
    })
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  before(async () => {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
  })
  after(async () => {
    for (const s of sockets) s.destroy()
    if (server.listening) {
      server.close()
      await once(server, "close")
    }
  })

  test("eth_chainId answered with an HTTP 404 page: details is the JSON-quoted body, the break is a backslash-n", async () => {
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${server.address().port}/v2/${KEY}`, { retryCount: 0 }) })
    const real = await createRpcProbe(client).getChainId().then(() => assert.fail("no error"), (e) => e)
    assert.equal(real.name, "HttpRequestError")
    assert.ok(/\\n/.test(real.details) && !/\n/.test(real.details), `fixture: the body is JSON-quoted:\n${real.details}`)
    const refused = await refusal(real)
    assertNoKeyRun(refused.message, "real HttpRequestError")
    assert.ok(refused.message.includes(`${WORDS}: /v2/<redacted> (404)`), refused.message)
    const printed = redactError(refused) // executor.js: the line the keeper prints at boot
    assertNoKeyRun(printed, "printed")
  })
})
