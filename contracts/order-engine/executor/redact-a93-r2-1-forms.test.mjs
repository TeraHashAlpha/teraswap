// [A93 R2-1] (High, pre-existing on origin/main) A provider error that echoes only the request TARGET — `no route for
// /v2/<key>?apikey=<key>`, an Express-style `Cannot POST /v2/<key>` page — kept the key: the URL redaction needs a
// host in front of a path. Every configured secret (redact.js SECRET_ENV_NAMES, read from the environment by name) is
// now removed by its literal value, as the last step of redactError and redactUrl (and so of sendTelegramAlert's final
// pass and alertOps).
//
// Each case goes through every sink that existed on b367f054 (redactError on an Error and on a string, redactUrl,
// sendTelegramAlert with fetch stubbed, alertOps), so this file imports nothing new and runs, red, against b367f054.
// The secrets are DUMMIES, configured below before redact.js is first used (the literal list is built once, lazily).
//
// Run: node --test contracts/order-engine/executor/redact-a93-r2-1-forms.test.mjs

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"

const KEY = "A93pathKeyZq7Rv9Tx4Wm8" // RPC_URL path segment
const QUERY = "A93queryVal5Hs1Jd" // RPC_URL query value
const PASSWORD = "A93userPass3Er8Ty" // BACKFILL_RPC_URL userinfo password
const SHORT_SEGMENT = "rpc12345678" // BACKFILL_RPC_URL path segment: 11 characters, below the floor
const PASTED = "A93pastedIntoTheUrlVar0001" // SUPABASE_URL holding something that is not a URL
const AWS_SECRET = "A93awsSecret/Dummy/Value0001" // a secret with `/` in it
const AWS_SECRET_SLASH_ESCAPED = "A93awsSecret\\/Dummy\\/Value0001" // the same, as an encoder that writes `/` as `\/` prints it
const HOST_LIKE = "A93hc.zqxhost/Tok3nValue01" // AWS_SESSION_TOKEN: a secret that reads as a host and a path
const ESC_TWELVE = "A93twelve12\\" // VAULT_ADDR (not a URL): 12 characters, the last one a backslash
const ESC_TAIL = "A93tail>Secret-0001\\" // TERASWAP_API_URL (not a URL): a `>` inside, a backslash at the end
const AUTH_WORD_KEY = "Unauthorized-A93hk7Zp2" // HEALTH_TOKEN: a key that holds a classifier keyword
const BALANCE_WORD_KEY = "InsufficientBalance-A93cg4" // COINGECKO_API_KEY: same, for retry-policy
const RPC_HOST = "base-mainnet.g.alchemy.example"

process.env.RPC_URL = `https://${RPC_HOST}/v2/${KEY}?apikey=${QUERY}&chain=base`
process.env.BACKFILL_RPC_URL = `https://ops:${PASSWORD}@backfill.example.org/${SHORT_SEGMENT}`
process.env.SUPABASE_URL = PASTED
process.env.AWS_SECRET_ACCESS_KEY = AWS_SECRET
process.env.AWS_SESSION_TOKEN = HOST_LIKE
process.env.HEALTH_TOKEN = AUTH_WORD_KEY
process.env.COINGECKO_API_KEY = BALANCE_WORD_KEY
process.env.VAULT_ADDR = ESC_TWELVE
process.env.TERASWAP_API_URL = ESC_TAIL
delete process.env.FLASHBOTS_RPC_URL // an unset name
process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { redactError, redactUrl } = await import("./redact.js")
const { sendTelegramAlert, alertOps, esc } = await import("./alert.js")
const { classifyRpcError } = await import("./rpc-auth.js")
const { classifyFailure, collectErrorText } = await import("./retry-policy.js")

const SECRETS = { KEY, QUERY, PASSWORD, PASTED, AWS_SECRET, HOST_LIKE, ESC_TWELVE, ESC_TAIL }
const everyByte = (s) => [...Buffer.from(s, "utf8")].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("")
const withoutBreaks = (s) => s.replace(/[ \t]*[\r\n][\r\n \t]*/g, "")

/** Which form of `secret` (or a fragment of 8+ characters) `text` still holds; [] when none. */
function leaks(text, secret) {
  const t = text.toLowerCase()
  const found = []
  const forms = {
    plain: secret,
    "percent-encoded": encodeURIComponent(secret),
    "every byte encoded": everyByte(secret),
    "HTML-escaped": esc(secret),
    "JSON-escaped": JSON.stringify(secret).slice(1, -1).replace(/\//g, "\\/"),
  }
  for (const [name, form] of Object.entries(forms)) if (t.includes(form.toLowerCase())) found.push(name)
  if (withoutBreaks(t).includes(secret.toLowerCase())) found.push("split by a line break")
  for (let i = 0; i + 8 <= secret.length; i++) {
    if (t.includes(secret.slice(i, i + 8).toLowerCase())) {
      found.push(`fragment ${JSON.stringify(secret.slice(i, i + 8))}`)
      break
    }
  }
  return found
}

/** The one Telegram text sendTelegramAlert / alertOps sends; fetch is stubbed, nothing leaves the process. */
async function telegram(send) {
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).text)
    return { ok: true }
  })
  try {
    await send()
  } finally {
    fetchMock.mock.restore()
  }
  assert.equal(sent.length, 1)
  return sent[0]
}

/** `text` through every sink: [label, output]. `err` overrides the Error built from `text`. */
async function sinks(text, err = new Error(text)) {
  return [
    ["redactError(Error)", redactError(err)],
    ["redactError(string)", redactError(text)],
    ["redactUrl", redactUrl(text)],
    ["sendTelegramAlert", await telegram(() => sendTelegramAlert(esc(text)))],
    ["alertOps", await telegram(() => alertOps({ kind: "rpc", detail: `balance read failed: ${text}` }, 5))],
  ]
}

async function assertNoSecret(text, err) {
  for (const [sink, out] of await sinks(text, err)) {
    for (const [name, secret] of Object.entries(SECRETS)) {
      assert.deepEqual(leaks(out, secret), [], `${sink}: ${name} leaked in:\n${out}`)
    }
  }
}

describe("[A93 R2-1] a configured secret never survives, in any form, in any sink", () => {
  test("the key in a path echoed with no host: `Cannot POST /v2/<key>`", async () => {
    await assertNoSecret(`<pre>Cannot POST /v2/${KEY}</pre>`)
    assert.equal(redactUrl(`Cannot POST /v2/${KEY}`), "Cannot POST /v2/<redacted>")
  })

  test("the key and the query value: `no route for /v2/<key>?apikey=<key>`", async () => {
    await assertNoSecret(`no route for /v2/${KEY}?apikey=${QUERY}&chain=base`)
    assert.equal(redactUrl(`no route for /v2/${KEY}?apikey=${QUERY}&chain=base`), "no route for /v2/<redacted>?apikey=<redacted>&chain=base")
  })

  test("the userinfo password, with no path after the host", async () => {
    await assertNoSecret(`connect ECONNREFUSED ops:${PASSWORD}@backfill.example.org`)
  })

  test("percent-encoded: every byte, and one character in a plain key", async () => {
    await assertNoSecret(`Cannot POST /v2/${everyByte(KEY)}`)
    const mixed = `${KEY.slice(0, 6)}%${KEY.charCodeAt(6).toString(16).toUpperCase()}${KEY.slice(7)}`
    await assertNoSecret(`Cannot POST /v2/${mixed}?apikey=${encodeURIComponent(QUERY)}`)
  })

  test("upper-cased and lower-cased echoes", async () => {
    await assertNoSecret(`CANNOT POST /V2/${KEY.toUpperCase()}?APIKEY=${QUERY.toUpperCase()}`)
    await assertNoSecret(`cannot post /v2/${KEY.toLowerCase()}`)
  })

  test("a value that is not a URL (a key pasted into SUPABASE_URL) is a secret whole", async () => {
    await assertNoSecret(`TypeError: Failed to parse URL from ${PASTED}/rest/v1/orders`)
  })

  test("a secret holding `/`, JSON-escaped in an error body (`\\/`)", async () => {
    await assertNoSecret(`{"message":"bad signature for ${AWS_SECRET_SLASH_ESCAPED}"}`)
    await assertNoSecret(`{"message":"bad signature for ${AWS_SECRET}"}`)
  })

  test("double-percent-encoded (`%252F`): what the URL decoder reveals is scrubbed after it", async () => {
    await assertNoSecret(`Cannot POST /v2/${AWS_SECRET.replace(/\//g, "%252F")}`)
  })

  test("a secret that reads as a host and a path is scrubbed before the URL pass could cut it", async () => {
    await assertNoSecret(`session ${HOST_LIKE} expired`)
    assert.equal(redactUrl(`session ${HOST_LIKE} expired`), "session <redacted> expired")
  })

  test("a secret ending in `\\`, written as it is before a `\"` (the two read as one JSON escape)", async () => {
    await assertNoSecret(`{"message":"bad key ${ESC_TWELVE}"}`)
  })

  test("a secret with a `>` and a final `\\`, HTML-escaped for Telegram before a `\"`", async () => {
    const out = await telegram(() => sendTelegramAlert(esc(`{"message":"bad key ${ESC_TAIL}"}`)))
    assert.deepEqual(leaks(out, ESC_TAIL), [], out)
    await assertNoSecret(`{"message":"bad key ${ESC_TAIL}"}`)
  })

  test("split by a line break: the whole key goes, on the first line, in every sink", async () => {
    const split = `Cannot POST /v2/${KEY.slice(0, 11)}\n   ${KEY.slice(11)} (404)`
    await assertNoSecret(split)
    // In redactError the second line is not one viem's diagnostic lines and is dropped: without the scrub of the whole
    // message the first half would stay on the first line.
    assert.equal(redactError(new Error(split)), "Cannot POST /v2/<redacted> (404)")
    // viem's shortMessage, folded to one line by redactError: the scrub ran before the fold.
    const short = Object.assign(new Error("x"), { shortMessage: `refused /v2/${KEY.slice(0, 5)}\r\n${KEY.slice(5)}` })
    assert.equal(redactError(short), "refused /v2/<redacted>")
  })

  test("the provider's words inside a viem-shaped error: the Details: line", async () => {
    const err = Object.assign(new Error(["RPC Request failed.", "", `URL: https://${RPC_HOST}`, `Details: no route for /v2/${KEY}?apikey=${QUERY}`, "Version: viem@2.47.10"].join("\n")), {
      name: "RpcRequestError",
      shortMessage: "RPC Request failed.",
      details: `no route for /v2/${KEY}?apikey=${QUERY}`,
    })
    await assertNoSecret(err.message, err)
    assert.equal(redactError(err), `RpcRequestError: RPC Request failed.\nURL: https://${RPC_HOST}\nDetails: no route for /v2/<redacted>?apikey=<redacted>`)
  })
})

describe("[A93 R2-1] what is not a configured secret stays", () => {
  const TX = `0x${"ab12".repeat(16)}`
  const ADDRESS = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
  const ORDER_PREFIX = "0b3c9e1a"
  const REASON = "Order expired"

  test("a tx hash, an address, an order id prefix, a revert reason and the RPC host", async () => {
    const text = `Order ${ORDER_PREFIX}... tx ${TX} to ${ADDRESS} reverted: ${REASON} via https://${RPC_HOST}/v2/${KEY}`
    for (const [sink, out] of await sinks(text)) {
      for (const kept of [TX, ADDRESS, ORDER_PREFIX, REASON, RPC_HOST]) assert.ok(out.includes(kept), `${sink} lost ${kept}:\n${out}`)
      assert.deepEqual(leaks(out, KEY), [], `${sink}:\n${out}`)
    }
  })

  test("a keyed URL line reads as before: the host, then /REDACTED (no mask glued to it)", () => {
    const err = Object.assign(new Error(`HTTP request failed.\n\nStatus: 503\nURL: https://${RPC_HOST}/v2/${KEY}?apikey=${QUERY}\nDetails: Service Unavailable`), {
      name: "HttpRequestError",
      shortMessage: "HTTP request failed.",
    })
    assert.equal(redactError(err), `HttpRequestError: HTTP request failed.\nStatus: 503\nURL: https://${RPC_HOST}/REDACTED\nDetails: Service Unavailable`)
    assert.equal(redactUrl(`URL: https://${RPC_HOST}/v2/${KEY}?apikey=${QUERY}`), `URL: https://${RPC_HOST}/REDACTED`)
  })

  test("a URL part shorter than 12 characters is never a secret: `rpc12345678`, `v2`, `base`", () => {
    const text = `GET /${SHORT_SEGMENT} then /v2/ on chain=base`
    assert.equal(redactUrl(text), text)
    assert.equal(redactError(text), text)
  })

  test("an unset name adds nothing (no `undefined`, no throw)", () => {
    const text = "FLASHBOTS_RPC_URL is undefined; it is null"
    assert.equal(redactUrl(text), text)
  })

  test("Telegram gets `&lt;redacted&gt;`, never a raw `<redacted>` tag it would refuse", async () => {
    const text = await telegram(() => sendTelegramAlert(`Last error: Cannot POST /v2/${KEY}`))
    assert.ok(text.includes("Cannot POST /v2/&lt;redacted&gt;"), text)
    assert.ok(!text.includes("<redacted>"), text)
  })
})

describe("[A93 R2-1, S-5 holds] a decision reads the raw error: the scrub is never applied before classification", () => {
  test("rpc-auth: a configured key holding `Unauthorized` is still read as an auth rejection", () => {
    assert.deepEqual(classifyRpcError(new Error(`provider: ${AUTH_WORD_KEY}`)), { kind: "auth", signal: "unauthorized" })
  })

  test("rpc-auth: `unauthorized` glued to a configured key is not a word (a scrub would make it one)", () => {
    assert.equal(classifyRpcError(new Error(`unauthorized${KEY}`)).kind, "transient")
  })

  test("retry-policy: the text it classifies is the raw text, and a key holding `InsufficientBalance` is terminal", () => {
    const err = new Error(`quote failed: ${BALANCE_WORD_KEY}`)
    assert.ok(collectErrorText(err).includes(BALANCE_WORD_KEY.toLowerCase()))
    assert.equal(classifyFailure({ err }).terminal, true)
  })
})
