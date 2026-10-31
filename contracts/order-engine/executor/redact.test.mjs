// [fix/executor-alert-masking-rpc-auth] INC-2026-10-30-001 — no keyed URL in any alert or log line.
//
// The incident: the Base keeper's RPC_URL key got an Alchemy domain allowlist, every RPC call failed,
// and the ONE alert that fired (alertOps "rpc", balance read) interpolated viem's err.message, whose
// `URL:` line is the full keyed RPC URL — posted to Telegram. These tests build REAL viem errors
// (HttpRequestError, and the JSON-RPC shape a 403-with-JSON-body really produces, via a local HTTP
// server — no network) around fixture URLs, and assert on what actually leaves the process: the
// returned alert bodies AND the text handed to fetch() for Telegram.
//
// The source guard at the bottom scans every executor *.js for console.* / log() / alert sinks whose
// arguments carry raw error text outside redactError()/redactUrl(). Point it at another tree with
// REDACT_GUARD_DIR=<dir> (that is how the FEEDBACK evidence shows it failing on origin/main).
//
// Run: node --test contracts/order-engine/executor/redact.test.mjs

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { HttpRequestError, createPublicClient, http } from "viem"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { redactUrl, redactError, REDACTED, ALERT_LINK_HOSTS } = await import("./redact.js")
const { alertOps, sendTelegramAlert } = await import("./alert.js")
const { startEventWatcher, explorerBase } = await import("./event-watcher.js")
const { ExecutorMonitor } = await import("./monitor.js")

const KEY = "TESTKEY"
const KEYED_URL = `https://base-mainnet.g.alchemy.com/v2/${KEY}`

/** The exact error viem 2.47 throws for a non-JSON 403 from a keyed endpoint. */
function keyedHttpError(status = 403, details = "Unspecified origin not on whitelist.") {
  return new HttpRequestError({ url: KEYED_URL, status, body: { method: "eth_getBalance", params: [] }, details })
}

/** Record every Telegram send; return the texts. */
function captureTelegram() {
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (url, init) => {
    sent.push({ url: String(url), text: JSON.parse(init.body).text })
    return { ok: true }
  })
  return { sent, restore: () => fetchMock.mock.restore() }
}

describe("redactUrl", () => {
  const rows = [
    ["path key", `URL: ${KEYED_URL}`, "URL: https://base-mainnet.g.alchemy.com/REDACTED"],
    ["userinfo, no path", `https://ops:${KEY}@rpc.example.com`, "https://rpc.example.com/REDACTED"],
    ["query key, any case", `HTTPS://RPC.EXAMPLE.COM/?apikey=${KEY}&x=1`, "HTTPS://RPC.EXAMPLE.COM/REDACTED"],
    ["websocket", `wss://base-mainnet.g.alchemy.com/v2/${KEY} closed`, "wss://base-mainnet.g.alchemy.com/REDACTED closed"],
    ["schemeless host:port", `fetch 127.0.0.1:8545/v2/${KEY} failed`, "fetch 127.0.0.1:8545/REDACTED failed"],
    ["schemeless IPv6", `[2001:db8::1]:8545/v2/${KEY}`, "[2001:db8::1]:8545/REDACTED"],
    ["schemeless dotted host", `rpc-provider.example/v2/${KEY}`, "rpc-provider.example/REDACTED"],
    ["fragment", `https://rpc.example.com#${KEY}`, "https://rpc.example.com/REDACTED"],
  ]
  for (const [name, input, expected] of rows) {
    test(`${name}: key gone, host kept`, () => {
      const out = redactUrl(input)
      assert.equal(out, expected)
      assert.ok(!out.includes(KEY))
    })
  }

  test("leaves what an operator needs: bare hosts, versions, repo paths, stack frames", () => {
    for (const s of [
      "https://basescan.org",
      "viem@2.47.10 timed out after 30ms",
      "POST /api/admin/dca-freeze",
      "see docs/Runbooks/EXECUTOR-OPERATIONS.md",
      "at main (file:///srv/keeper/contracts/order-engine/executor/executor.js:2210:5)",
    ]) {
      assert.equal(redactUrl(s), s)
    }
  })

  test("is idempotent, and allowHosts keeps only public explorer links (never userinfo)", () => {
    const once = redactUrl(`a ${KEYED_URL} b 127.0.0.1:8545/v2/${KEY}`)
    assert.equal(redactUrl(once), once)
    const link = `<a href="https://basescan.org/tx/0xabc">0xabc</a>`
    assert.equal(redactUrl(link, { allowHosts: ALERT_LINK_HOSTS }), link)
    assert.equal(redactUrl(link), `<a href="https://basescan.org${REDACTED}">0xabc</a>`)
    assert.equal(redactUrl(`https://u:${KEY}@basescan.org/tx`, { allowHosts: ALERT_LINK_HOSTS }), `https://basescan.org${REDACTED}`)
  })

  test("ALERT_LINK_HOSTS covers every explorer event-watcher.js links to", () => {
    for (const chainId of ["1", "11155111", "8453", "42161"]) {
      assert.ok(ALERT_LINK_HOSTS.includes(new URL(explorerBase(chainId)).host), `chain ${chainId}`)
    }
  })

  test("stays linear on adversarial input (bounded quantifiers)", () => {
    const evil = "a.".repeat(50_000) + "a:" + "1".repeat(50_000) + "https://" + "x".repeat(50_000)
    const t0 = performance.now()
    redactUrl(evil)
    assert.ok(performance.now() - t0 < 1_000, "redactUrl took >1 s on a 250 KB input")
  })
})

describe("redactError", () => {
  test("a real viem HttpRequestError: key gone, host + status + Details kept", () => {
    const err = keyedHttpError()
    assert.ok(err.message.includes(KEY), "fixture sanity: viem puts the keyed URL in .message")
    const out = redactError(err)
    assert.ok(!out.includes(KEY))
    assert.match(out, /URL: https:\/\/base-mainnet\.g\.alchemy\.com\/REDACTED/)
    assert.match(out, /Status: 403/)
    assert.match(out, /Details: Unspecified origin not on whitelist\./)
  })

  test("truncates AFTER redacting, and tolerates strings / null / odd objects", () => {
    const out = redactError(keyedHttpError(), { max: 80 })
    assert.ok(out.length <= 80 && !out.includes(KEY))
    assert.equal(redactError(`boom ${KEYED_URL}`), "boom https://base-mainnet.g.alchemy.com/REDACTED")
    assert.equal(redactError(null), "null")
    assert.equal(redactError({ shortMessage: `x ${KEYED_URL}` }), "x https://base-mainnet.g.alchemy.com/REDACTED")
  })

  test("the JSON-RPC 403 shape viem really throws (local server) is redacted too", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Unspecified origin not on whitelist." } }))
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    try {
      const client = createPublicClient({ transport: http(`http://127.0.0.1:${srv.address().port}/v2/${KEY}`, { retryCount: 0 }) })
      const err = await client.getBlockNumber().then(() => null, (e) => e)
      assert.ok(err && err.message.includes(KEY), "fixture sanity: the keyed URL is in .message")
      assert.ok(!redactError(err).includes(KEY))
    } finally {
      srv.close()
    }
  })
})

describe("alerts built from a keyed viem error carry no key", () => {
  test("alertOps — the INC-2026-10-30-001 balance-read alert, even when a caller passes raw err.message", async () => {
    const tg = captureTelegram()
    try {
      const body = await alertOps({ kind: "rpc", detail: `balance read failed: ${keyedHttpError().message}` }, 3)
      assert.ok(!body.includes(KEY), body)
      assert.match(body, /Detail: balance read failed: HTTP request failed\.\n\nStatus: 403\nURL: https:\/\/base-mainnet\.g\.alchemy\.com\/REDACTED/)
      assert.equal(tg.sent.length, 1)
      assert.ok(!tg.sent[0].text.includes(KEY), tg.sent[0].text)
    } finally {
      tg.restore()
    }
  })

  test("sendTelegramAlert envelope: keyed URL redacted, explorer tx link kept", async () => {
    const tg = captureTelegram()
    try {
      await sendTelegramAlert(`x ${KEYED_URL}\nTx: <a href="https://basescan.org/tx/0xabc">0xabc…</a>`)
      assert.ok(!tg.sent[0].text.includes(KEY))
      assert.match(tg.sent[0].text, /href="https:\/\/basescan\.org\/tx\/0xabc"/)
    } finally {
      tg.restore()
    }
  })

  test("event-watcher: 'Poll error (5/5)' log lines and the Degraded alert", async () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    const errLines = []
    const errMock = mock.method(console, "error", (...a) => errLines.push(a.join(" ")))
    const logMock = mock.method(console, "log", () => {})
    const tg = captureTelegram()
    const client = { getBlockNumber: async () => { throw keyedHttpError() }, getLogs: async () => [] }
    const watcher = startEventWatcher(client, [{ address: "0x" + "a".repeat(40), label: "OrderExecutor" }], null)
    try {
      for (let i = 0; i < 6; i++) {
        for (let t = 0; t < 40; t++) await new Promise((r) => setImmediate(r))
        mock.timers.tick(30_000)
      }
      watcher.stop()
      for (let t = 0; t < 40; t++) await new Promise((r) => setImmediate(r)) // drain the in-flight poll
      assert.ok(errLines.some((l) => l.includes("Poll error (5/5)")))
      assert.ok(errLines.every((l) => !l.includes(KEY)), errLines.join("\n"))
      const degraded = tg.sent.filter((s) => s.text.includes("Event Watcher Degraded"))
      assert.equal(degraded.length, 1)
      assert.ok(!degraded[0].text.includes(KEY), degraded[0].text)
    } finally {
      watcher.stop()
      tg.restore()
      errMock.mock.restore()
      logMock.mock.restore()
      mock.timers.reset()
    }
  })

  test("monitor: consecutive-errors alert (onCycleError + stats.lastError)", async () => {
    const tg = captureTelegram()
    try {
      const m = new ExecutorMonitor({ startedAt: new Date().toISOString(), lastError: { message: keyedHttpError().message } })
      for (let i = 0; i < 3; i++) m.onCycleError(keyedHttpError(503, "Service Unavailable")) // 3rd ⇒ alert (error path)
      m.alertCooldown.clear() // let the stats.lastError path alert too, inside the 5-min cooldown
      m.onCycleEnd(0, 1)
      for (let t = 0; t < 10; t++) await new Promise((r) => setImmediate(r))
      assert.equal(tg.sent.length, 2)
      for (const s of tg.sent) assert.ok(!s.text.includes(KEY), s.text)
    } finally {
      tg.restore()
    }
  })
})

// ── Source guard ──────────────────────────────────────────────────────────────────────────────
// Every console.* / log() / alert-sink call in an executor *.js must not carry raw error text:
// `err.message` (and shortMessage/details/stack/cause/metaMessages), or a bare error identifier
// (`console.error("x", err)`, `${err}`, String(err)) — unless it sits inside redactError()/redactUrl().
// A small tokenizer separates code from strings/comments, so a sink named in a comment or an error
// word inside a string never counts; template `${…}` bodies are code.

// Free calls (`log(`, not `foo.log(`) plus the monitor's method sink (`this._sendCooldownAlert(`).
const SINK =
  /(?:(?<![\w$.])(console\.(?:log|error|warn|info|debug)|log|alertOps|sendTelegramAlert)|(?<=\.)(_sendCooldownAlert))\s*\(/g
const ERR_ID = String.raw`(?:err|e|error|[a-z]\w*Err|[a-z]\w*Error)`
const RAW_TEXT = new RegExp(String.raw`\b${ERR_ID}\s*\??\.\s*(?:message|shortMessage|details|stack|cause|metaMessages)\b`)
const BARE_ID = new RegExp(String.raw`(?:^|[,(])\s*${ERR_ID}\s*(?=[,)]|$)`)

/** Per-char code view: strings + comments blanked, `${` → "(" and its closing `}` → ")". */
function codeView(src) {
  const out = src.split("")
  const stack = [{ kind: "code", braces: 0 }]
  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1]
    const c = src[i]
    if (top.kind === "tpl") {
      if (c === "\\") { out[i] = out[i + 1] = " "; i += 2; continue }
      if (c === "`") { out[i] = " "; stack.pop(); i++; continue }
      if (c === "$" && src[i + 1] === "{") { out[i] = " "; out[i + 1] = "("; stack.push({ kind: "code", braces: 0, fromTpl: true }); i += 2; continue }
      out[i] = c === "\n" ? "\n" : " "; i++; continue
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") out[i++] = " "; continue }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? src.length : end + 2
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " "
      continue
    }
    if (c === "'" || c === '"') {
      out[i++] = " "
      while (i < src.length && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") out[i++] = " "; out[i++] = " " }
      out[i++] = " "
      continue
    }
    if (c === "`") { out[i] = " "; stack.push({ kind: "tpl" }); i++; continue }
    if (c === "{") top.braces++
    if (c === "}") {
      if (top.braces === 0 && top.fromTpl) { out[i] = ")"; stack.pop(); i++; continue }
      top.braces--
    }
    i++
  }
  return out.join("")
}

function closeParen(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++
    else if (code[i] === ")" && --depth === 0) return i
  }
  return code.length
}

function maskRedactors(args) {
  let out = args
  for (const m of [...args.matchAll(/\bredact(?:Error|Url)\s*\(/g)]) {
    const open = m.index + m[0].length - 1
    const close = closeParen(args, open)
    out = out.slice(0, m.index) + " ".repeat(close + 1 - m.index) + out.slice(close + 1)
  }
  return out
}

/** @returns {Array<{line:number, sink:string, call:string}>} raw-error sinks in `src` */
function findRawErrorSinks(src) {
  const code = codeView(src)
  const hits = []
  for (const m of code.matchAll(SINK)) {
    const open = m.index + m[0].length - 1
    const close = closeParen(code, open)
    const args = maskRedactors(code.slice(open + 1, close))
    if (RAW_TEXT.test(args) || BARE_ID.test(args.replace(/\s+/g, " ").trim())) {
      hits.push({
        line: src.slice(0, m.index).split("\n").length,
        sink: m[1] || m[2],
        call: src.slice(m.index, Math.min(close + 1, m.index + 140)).replace(/\s+/g, " "),
      })
    }
  }
  return hits
}

describe("source guard: no raw error text reaches a console/log/alert sink", () => {
  test("the scanner flags the shapes that leaked, and passes the redacted ones", () => {
    const flagged = [
      'console.error("[ALERT] Telegram send failed:", err.message)',
      "log(`  WARNING: balance read failed (${err.message?.slice(0, 80)}) -- rpcDown=true`)",
      'await alertOps({ kind: "rpc", detail: `balance read failed: ${err.message}` }, s)',
      'console.error("Fatal error:", err)',
      "console.warn(`x ${err}`)",
      "console.log(String(e))",
      "this._sendCooldownAlert(\"t\", `Last error: ${this.stats.lastError?.message || \"unknown\"}`)",
      "console.error(\n  'multi-line',\n  error.shortMessage,\n)",
    ]
    for (const s of flagged) assert.equal(findRawErrorSinks(s).length, 1, `not flagged: ${s}`)
    const clean = [
      'console.error("[ALERT] Telegram send failed:", redactError(err))',
      "log(`  WARNING: balance read failed (${redactError(err, { max: 80 })}) -- rpcDown=true`)",
      'console.error("Fatal error:", redactUrl(err?.stack || redactError(err)))',
      "// console.error(err.message) in a comment",
      'console.log("err.message inside a string")',
      "console.log(`code ${err.code} name ${err.name}`)",
      "function log(msg) { console.log(`[${ts}] ${msg}`) }",
    ]
    for (const s of clean) assert.deepEqual(findRawErrorSinks(s), [], `false positive: ${s}`)
  })

  test("every executor *.js is clean", () => {
    const dir = process.env.REDACT_GUARD_DIR || dirname(fileURLToPath(import.meta.url))
    const files = readdirSync(dir).filter((f) => f.endsWith(".js") && !f.includes(".test.") && f !== "redact.js")
    assert.ok(files.includes("executor.js") && files.includes("event-watcher.js"), `wrong dir: ${dir}`)
    const hits = files.flatMap((f) => findRawErrorSinks(readFileSync(join(dir, f), "utf-8")).map((h) => `${f}:${h.line} ${h.call}`))
    assert.deepEqual(hits, [], `raw error text reaches a sink:\n${hits.join("\n")}`)
  })
})
