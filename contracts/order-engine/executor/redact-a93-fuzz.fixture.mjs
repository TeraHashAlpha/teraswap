// redact-a93-fuzz.fixture.mjs — TEST-ONLY worker (not a test: node --test does not pick it up), started by
// redact-a93-r2-1-fuzz.test.mjs, one worker per seed: the configured-secret list is built ONCE per process
// (redact.js), so each seed's secrets need a fresh module state.
//
// workerData: { seed, cases }. The worker's own environment (set by the parent) holds the seed's secrets under random
// SECRET_ENV_NAMES; workerData.secrets lists them (the decoded values). Each case puts one of them, in a random form,
// at a random place in a random error shape, and runs it through every sink; the oracle below is independent of
// redact.js's scanner. Posts { checked, failures }.

import { parentPort, workerData } from "node:worker_threads"
import { format } from "node:util"

const { seed, cases, secrets } = workerData
const sent = []
globalThis.fetch = async (_url, init) => {
  sent.push(JSON.parse(init.body).text)
  return { ok: true }
}

const { redactError, redactUrl, redactSecretLiterals } = await import("./redact.js")
const { sendTelegramAlert, alertOps, esc } = await import("./alert.js")
const { ExecutorMonitor } = await import("./monitor.js")

// sfc32, seeded
function rng(s) {
  let a = 0x9e3779b9 ^ s
  let b = 0x243f6a88 + s
  let c = 0xb7e15162 ^ (s << 7)
  let d = 1
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}
const r = rng(seed)
const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
const pick = (xs) => xs[int(0, xs.length - 1)]
const WORDS = "error reverted rpc provider unauthorized timeout POST GET route key apikey failed details url status".split(" ")
const text = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ")

const everyByte = (s) => [...Buffer.from(s, "utf8")].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("")
const FORMS = {
  plain: (s) => s,
  "percent-encoded": (s) => encodeURIComponent(s),
  "every byte encoded": everyByte,
  "some characters encoded": (s) => [...s].map((ch) => (r() < 0.4 ? everyByte(ch) : ch)).join(""),
  "upper case": (s) => s.toUpperCase(),
  "lower case": (s) => s.toLowerCase(),
  "random case": (s) => [...s].map((ch) => (r() < 0.5 ? ch.toUpperCase() : ch.toLowerCase())).join(""),
  "HTML-escaped": (s) => esc(s),
  "JSON-escaped": (s) => JSON.stringify(s).slice(1, -1).replace(/\//g, "\\/"),
  "split by a line break": (s) => {
    const at = int(1, s.length - 1)
    return `${s.slice(0, at)}${pick(["\n", "\r\n", "\n    ", "  \n  "])}${s.slice(at)}`
  },
}
const SHAPES = {
  "Cannot POST": (f) => `<pre>Cannot POST /v2/${f}</pre>`,
  "no route": (f, g) => `no route for /v2/${f}?apikey=${g}`,
  "JSON-RPC body": (f) => `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"invalid key ${f}"}}`,
  "parse URL": (f) => `TypeError: Failed to parse URL from ${f}/rest/v1/orders`,
  glued: (f) => `${pick(WORDS)}${f}${pick(WORDS)}`,
  userinfo: (f) => `connect ECONNREFUSED ops:${f}@backfill.example.org`,
  "long padding": (f) => `${text(int(0, 140))} ${f} ${text(int(0, 20))}`,
  "full URL": (f) => `request to https://rpc.example.org/v2/${f} failed`,
}

/** `err` shaped like viem's RpcRequestError, the provider's words in its Details: line and `details`. */
function viemShaped(words) {
  return Object.assign(new Error(["RPC Request failed.", "", "URL: https://rpc.example.org", 'Request body: {"method":"eth_call"}', "", `Details: ${words}`, "Version: viem@2.47.10"].join("\n")), {
    name: "RpcRequestError",
    shortMessage: "RPC Request failed.",
    details: words,
  })
}

// The oracle: every view of the output an operator could decode by hand.
const pctDecode = (s) => s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
const htmlDecode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39|#039);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#039": "'" })[e])
const jsonDecode = (s) => s.replace(/\\(["'\\/])/g, "$1")
const noBreaks = (s) => s.replace(/[ \t]*[\r\n][\r\n \t]*/g, "")
function views(out) {
  const v = [out, pctDecode(out), htmlDecode(out), jsonDecode(out), pctDecode(htmlDecode(jsonDecode(out))), jsonDecode(htmlDecode(pctDecode(out)))]
  return v.flatMap((x) => [x.toLowerCase(), noBreaks(x).toLowerCase()])
}

async function telegram(send) {
  sent.length = 0
  await send()
  await new Promise((resolve) => setImmediate(resolve))
  return sent.join("\n")
}

const failures = []
let checked = 0
for (let i = 0; i < cases; i++) {
  const secret = pick(secrets)
  const formName = pick(Object.keys(FORMS))
  const shapeName = pick(Object.keys(SHAPES))
  const f = FORMS[formName](secret)
  const g = FORMS[pick(Object.keys(FORMS))](pick(secrets))
  const raw = SHAPES[shapeName](f, g)
  const outputs = {
    "redactError(Error)": redactError(new Error(raw)),
    "redactError(string)": redactError(raw),
    "redactError(viem-shaped)": redactError(viemShaped(raw)),
    redactUrl: redactUrl(raw),
    "CLI print": redactSecretLiterals(format("FATAL: %s", raw)),
    "sendTelegramAlert(escaped)": await telegram(() => sendTelegramAlert(esc(raw))),
    "sendTelegramAlert(raw)": await telegram(() => sendTelegramAlert(raw)),
    alertOps: await telegram(() => alertOps({ kind: "rpc", detail: raw }, 5)),
    "onCycleError alert": await telegram(() => {
      const m = new ExecutorMonitor({ startedAt: "t", lastError: null })
      for (let k = 0; k < 3; k++) m.onCycleError(viemShaped(raw))
    }),
  }
  for (const [sink, out] of Object.entries(outputs)) {
    checked++
    const vs = views(out)
    for (const s of secrets) {
      if (vs.some((v) => v.includes(s.toLowerCase()))) {
        failures.push({ case: i, sink, form: formName, shape: shapeName, length: s.length, out: out.slice(0, 300) })
      }
    }
  }
}
parentPort.postMessage({ checked, failures: failures.slice(0, 10), failureCount: failures.length })
