// [A96 R3-2] (Low, pre-existing) The scrub joined a key a provider broke over two lines when the break was a real line
// break, but not when it was written as a JSON string escape: viem's HttpRequestError quotes the HTTP body as JSON
// (`Details: "no route for /v2/<half>\n   <half>"`), so the break reaches every sink as the two characters `\` `n`, and
// both halves survived. The walk now reads `\n`, `\r`, `\t` and `\u000a`, `\u000d`, `\u0009` (either case) as the line
// breaks and blanks they are, so a key split by one of them is removed whole.
//
//   1. REAL viem errors: a provider answers HTTP 404 with a body that holds the key split over two lines (and the query
//      value split too); viem throws an HttpRequestError (wrapped in a ContractFunctionExecutionError by readContract).
//      Each error goes through every keeper sink; neither secret, nor any 8-character fragment, comes out.
//   2. The escape forms, as text, through the sinks that take text.
//   3. What is not a secret stays, and a break that does not split a key joins nothing.
//
// The configured RPC_URL carries the DUMMY key; it is set before redact.js is first used (the list is built once).
//
// Run: node --test contracts/order-engine/executor/redact-a96-r3-2-json-breaks.test.mjs

import { test, describe, before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { format } from "node:util"

const KEY = "A96jsonKeyQm4Vx8Lp2Zr6"
const QUERY = "A96jsonQueryN5t9Wc"
const RPC_HOST = "base-mainnet.g.alchemy.example"
const ESCAPE_KEY = String.raw`A96esc\Tab\Nline&\U000Ahex-0001` // HEALTH_TOKEN: holds `\T`, `\N`, `\U000A` and `&` itself
process.env.RPC_URL = `https://${RPC_HOST}/v2/${KEY}?apikey=${QUERY}`
process.env.HEALTH_TOKEN = ESCAPE_KEY
process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { redactError, redactUrl, redactSecretLiterals } = await import("./redact.js")
const { alertOps, sendTelegramAlert, esc } = await import("./alert.js")
const { ExecutorMonitor } = await import("./monitor.js")
const { startRpcStub } = await import("./viem-wrapped-errors.fixture.mjs")

const ORDER_ID = "0b3c9e1a-0000-4000-8000-000000000000"
const SECRETS = [KEY, QUERY]

/** Which secret, or an 8-character fragment of it, `text` still holds (any case, line breaks and blanks removed). */
function leaks(text) {
  const flat = text.toLowerCase().replace(/[ \t]*[\r\n][\r\n \t]*/g, "")
  const found = []
  for (const secret of SECRETS) {
    const s = secret.toLowerCase()
    if (flat.includes(s)) found.push(`the whole of ${secret}`)
    for (let i = 0; i + 8 <= s.length; i++) if (flat.includes(s.slice(i, i + 8))) found.push(`a fragment of ${secret}: ${s.slice(i, i + 8)}`)
  }
  return found
}

/** The one Telegram text `send` produces; fetch is stubbed, nothing leaves the process. */
async function telegram(send) {
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).text)
    return { ok: true }
  })
  try {
    await send()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    fetchMock.mock.restore()
  }
  assert.equal(sent.length, 1, "exactly one alert is sent")
  return sent[0]
}

// ── 1. real viem errors ─────────────────────────────────────────────────────────────────────────────────────────────
const third = (s) => [s.slice(0, 7), s.slice(7, 15), s.slice(15)]
const BODIES = {
  "the key over two lines (LF)": `Cannot POST /v2/${KEY.slice(0, 11)}\n   ${KEY.slice(11)} (404)`,
  "the key over two lines (CRLF, a tab)": `Cannot POST /v2/${KEY.slice(0, 9)}\r\n\t${KEY.slice(9)} (404)`,
  "the key over three lines": `Cannot POST /v2/${third(KEY).join("\n")} (404)`,
  "the key and the query value, each over two lines": `Cannot POST /v2/${KEY.slice(0, 11)}\n${KEY.slice(11)}?apikey=${QUERY.slice(0, 6)}\r\n${QUERY.slice(6)}`,
}

const SITES = {
  "canExecute @ eth_call": (stub, body) => stub.readError({ http: 404, body }),
  "executeOrder @ eth_estimateGas": (stub, body) => stub.writeError({ http: 404, body }),
}

const SINKS = {
  "keeper log line: redactError(the error)": async (err) => `  Order ${ORDER_ID.slice(0, 8)}... error: ${redactError(err)}`,
  "redactError(the HttpRequestError itself)": async (err) => redactError(err.walk((e) => e?.name === "HttpRequestError")),
  "redactError(its message as a string)": async (err) => redactError(err.message),
  "redactUrl(its message)": async (err) => redactUrl(err.message),
  "CLI print: say() of its message": async (err) => redactSecretLiterals(format("FATAL:", err.message)),
  "sendTelegramAlert(esc(its message))": (err) => telegram(() => sendTelegramAlert(esc(err.message))),
  alertOps: (err) => telegram(() => alertOps({ kind: "rpc", detail: `balance read failed: ${redactError(err)}` }, 5)),
  "onCycleEnd alert (stats.lastError)": (err) =>
    telegram(() => {
      const stats = { startedAt: new Date().toISOString(), lastError: { orderId: ORDER_ID, message: redactError(err), at: new Date().toISOString() } }
      new ExecutorMonitor(stats).onCycleEnd(0, 3)
    }),
  "onCycleError alert": (err) =>
    telegram(() => {
      const monitor = new ExecutorMonitor({ startedAt: new Date().toISOString(), lastError: null })
      for (let i = 0; i < 3; i++) monitor.onCycleError(err)
    }),
}

const errors = {}
let stub
before(async () => {
  stub = await startRpcStub()
  for (const [site, make] of Object.entries(SITES)) {
    for (const [name, body] of Object.entries(BODIES)) errors[`${site} | ${name}`] = await make(stub, body)
  }
})
after(async () => {
  await stub.stop()
})

describe("[A96 R3-2] fixtures: viem JSON-quotes the body, so the break reaches the sinks as `\\n`", () => {
  test("a real HttpRequestError under each ContractFunctionExecutionError, the halves joined by a backslash-n", () => {
    assert.equal(Object.keys(errors).length, Object.keys(SITES).length * Object.keys(BODIES).length)
    for (const [label, err] of Object.entries(errors)) {
      assert.equal(err.name, "ContractFunctionExecutionError", label)
      const http = err.walk((e) => e?.name === "HttpRequestError")
      assert.ok(http, `${label}: no HttpRequestError in the cause chain`)
      assert.equal(http.status, 404, label)
      // JSON.stringify of a body with a line break: `\n` (two characters) or `\r\n`, never a real break between the halves.
      assert.ok(/Details: "Cannot POST \/v2\/[^\n]*\\[nr]/.test(err.message), `${label}: the break is not a JSON escape:\n${err.message}`)
    }
  })
})

describe("[A96 R3-2] a key split by a JSON escape in a real viem error: 2 sites x 4 bodies x 9 sinks, nothing of it comes out", () => {
  for (const site of Object.keys(SITES)) {
    for (const body of Object.keys(BODIES)) {
      for (const [sink, render] of Object.entries(SINKS)) {
        test(`${site} | ${body} -> ${sink}`, async () => {
          const out = await render(errors[`${site} | ${body}`])
          assert.deepEqual(leaks(out), [], `leaked:\n${out}`)
          // redactError on a viem message AS A STRING keeps its first line only ("HTTP request failed."), by design and as on
          // origin/main: the Details: line, where the provider's words are, is not read from a string. Every other sink keeps them.
          if (sink !== "redactError(its message as a string)") {
            assert.match(out, /Cannot POST \/v2\/(?:<|&lt;)redacted(?:>|&gt;)/, `the provider's words are gone:\n${out}`)
          }
        })
      }
    }
  }
})

// ── 2. the escape forms, as text ────────────────────────────────────────────────────────────────────────────────────
const FORMS = {
  "\\n": "\\n",
  "\\r\\n": "\\r\\n",
  "\\n then \\t": "\\n\\t",
  "\\t only, between spaces": " \\t ", // a blank that touches no break is an ordinary character: the key is NOT split by it
  "\\u000a": "\\u000a",
  "\\u000A (upper-case hex)": "\\u000A",
  "\\U000a (upper-case u)": "\\U000a",
  "\\u000d\\u000a": "\\u000d\\u000a",
  "\\u000a then \\u0009": "\\u000a\\u0009",
  "a real LF, then \\n": "\n\\n",
  "spaces, \\n, spaces": "   \\n   ",
}
const TEXT_SINKS = {
  "redactError(string)": async (t) => redactError(t),
  "redactError(Error)": async (t) => redactError(new Error(t)),
  redactUrl: async (t) => redactUrl(t),
  "CLI print": async (t) => redactSecretLiterals(format(t)),
  "sendTelegramAlert(esc)": (t) => telegram(() => sendTelegramAlert(esc(t))),
  alertOps: (t) => telegram(() => alertOps({ kind: "rpc", detail: `balance read failed: ${t}` }, 5)),
}

describe("[A96 R3-2] every JSON spelling of a line break (or a tab beside one) joins the halves of a key", () => {
  for (const [form, sep] of Object.entries(FORMS)) {
    const splits = !form.startsWith("\\t only") // a lone blank joins nothing: that case is the control below
    for (const [sink, render] of Object.entries(TEXT_SINKS)) {
      if (!splits) continue
      test(`${form} -> ${sink}`, async () => {
        const out = await render(`bad key ${KEY.slice(0, 10)}${sep}${KEY.slice(10)} for the route`)
        assert.deepEqual(leaks(out), [], `leaked:\n${out}`)
        assert.match(out, /bad key (?:<|&lt;)redacted(?:>|&gt;) for the route/, `the provider's words are gone:\n${out}`)
      })
    }
  }

  test("the exact mask: redactSecretLiterals reads each form as one key", () => {
    for (const [form, sep] of Object.entries(FORMS)) {
      if (form.startsWith("\\t only")) continue
      assert.equal(redactSecretLiterals(`bad key ${KEY.slice(0, 10)}${sep}${KEY.slice(10)} for the route`), "bad key <redacted> for the route", form)
    }
  })

  test("a tab that touches no line break splits nothing: it is an ordinary character, as a plain space is", () => {
    const text = `bad key ${KEY.slice(0, 10)} \\t ${KEY.slice(10)} for the route`
    assert.equal(redactSecretLiterals(text), text)
  })

  // The regression the fuzz (seed 9) caught on the first version of this change: a secret that holds `\T`, `\N` or `\U000A`
  // is no escape as written, but its lower-cased echo `\t`, `\n`, `\u000a` is one. Text and secret must read the pair alike.
  test("a secret that itself holds a backslash-letter pair is removed in every case and escaping of its echo", () => {
    const want = "bad key <redacted> for the route"
    const echoes = [ESCAPE_KEY, ESCAPE_KEY.toLowerCase(), ESCAPE_KEY.toUpperCase(), ESCAPE_KEY.replace(/\\/g, "\\\\")]
    for (const echo of echoes) assert.equal(redactSecretLiterals(`bad key ${echo} for the route`), want, echo)
    assert.equal(redactSecretLiterals(`bad key ${esc(ESCAPE_KEY.toLowerCase())} for the route`, { html: true }), "bad key &lt;redacted&gt; for the route")
  })

  // Fuzz seed 383 (found by the 400-seed run): `Z*` LF `\ty)...` is the secret `Z*\ty)...` split by a line break whose second
  // half starts with the TEXT backslash-t, HTML-escaped (the `&` of the secret is `&amp;`: only the decoding walk can match
  // it). The break swallows the `\t` as a blank, so the secret must also be searched with that blank dropped. Every split
  // position, every kind of break, plain and HTML-escaped.
  test("a line break at any position of a secret that holds backslash-t, backslash-n or backslash-u joins the halves", () => {
    const want = "bad key <redacted> for the route"
    for (const secret of [ESCAPE_KEY, ESCAPE_KEY.toLowerCase(), KEY]) {
      for (const brk of ["\n", "\r\n", "  \n  ", "\n\t "]) {
        for (let at = 1; at < secret.length; at++) {
          for (const [how, enc] of [["plain", (s) => s], ["HTML-escaped", esc]]) {
            const text = `bad key ${enc(secret.slice(0, at))}${brk}${enc(secret.slice(at))} for the route`
            assert.equal(redactSecretLiterals(text), want, `${how}, split at ${at} by ${JSON.stringify(brk)}: ${JSON.stringify(text)}`)
          }
        }
      }
    }
  })
})

// ── 3. what is not a secret stays ───────────────────────────────────────────────────────────────────────────────────
describe("[A96 R3-2] what is not a configured secret stays, and a break that does not split a key joins nothing", () => {
  const TX = `0x${"ab12".repeat(16)}`
  const ADDRESS = "0x686b4f812291F4De238E59ED00BA6dD6129e60a0"
  const REASON = "Order expired"

  test("a tx hash, an address, an order id prefix, a revert reason and the RPC host survive a body full of JSON breaks", () => {
    const text = String.raw`{"message":"Order 0b3c9e1a... tx ${TX}\n   to ${ADDRESS}\r\n\treverted: ${REASON}\u000a via https://${RPC_HOST}/v2/${KEY}"}`
    const out = redactError(text)
    for (const kept of [TX, ADDRESS, "0b3c9e1a", REASON, RPC_HOST]) assert.ok(out.includes(kept), `lost ${kept}:\n${out}`)
    assert.deepEqual(leaks(out), [], out)
  })

  test("half a key before a break, and something else after it, is not the key", () => {
    const text = `bad key ${KEY.slice(0, 10)}\\nZZZZZZZZZZZZ for the route`
    assert.equal(redactSecretLiterals(text), text)
    const lone = `bad key ${KEY.slice(0, 11)}`
    assert.equal(redactSecretLiterals(lone), lone)
  })

  test("a text with breaks and no secret is returned unchanged", () => {
    const text = String.raw`line one\nline two\r\n\tline three\u000a\u0009end`
    assert.equal(redactSecretLiterals(text), text)
  })
})
