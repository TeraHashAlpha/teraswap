// Test fixture (not a test): runs the SHIPPED executeCycle / fetchActiveOrders of executor.js against an
// in-process fake PostgREST and a fake public client, so a cycle-level test exercises the real text.
//
// executor.js runs main() when imported, so it cannot be imported as is. loadShippedExecutor() copies its
// source to a temp file with exactly three edits: (1) every import specifier is made absolute (relative
// ones point back at this directory, `viem` resolves from this directory's node_modules), (2) the trailing
// `main().catch(…)` call is cut, (3) an `export { … }` line is appended. Nothing else in the text changes.
//
// The fake PostgREST implements only what the keeper sends to /rest/v1/orders: eq / neq / gt / gte / lt /
// lte / is filters, or=(…) / and=(…) logic trees with optional double-quoted values, order=a.asc,b.asc,
// limit, GET / HEAD / PATCH, Prefer: count=exact (Content-Range "a-b/N" or "*/N"). Query strings are
// decoded the way PostgREST decodes them ('+' is a space), so an unencoded '+' in a timestamp breaks here
// as it would there. created_at compares as a timestamp (epoch seconds, then the fraction), id as a
// lowercase string (Postgres uuid order). Any request to another host, or one this fake does not
// understand, is recorded in `unexpected` and answered 501.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const EXECUTOR_DIR = new URL("./", import.meta.url)

export const FAKE_SUPABASE_URL = "http://supabase.fake.test"
export const TEST_CHAIN_ID = 8453
export const OTHER_CHAIN_ID = 42161
const V2_EXECUTOR = "0x135B339902Ea4E0fB4CF059961dc8856bA1D2598"

/** Copy executor.js (three edits, see the header) to a temp file and import it. */
export async function loadShippedExecutor({ exportNames = ["executeCycle", "fetchActiveOrders"] } = {}) {
  Object.assign(process.env, {
    CHAIN_ID: String(TEST_CHAIN_ID),
    SUPABASE_URL: FAKE_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
    ORDER_EXECUTOR_ADDRESS: V2_EXECUTOR,
    RPC_URL: "http://127.0.0.1:9",
    EXECUTOR_ENV_FILE: join(tmpdir(), "keeper-cycle-fixture-no-such-env-file"),
  })
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  delete process.env.ORDER_EXECUTOR_V3_ADDRESS

  const src = readFileSync(new URL("executor.js", EXECUTOR_DIR), "utf8")
  const cut = src.lastIndexOf("\nmain().catch(")
  assert.ok(cut > 0, "executor.js no longer ends with main().catch(…) — update the fixture")
  let body = src.slice(0, cut + 1)
  let rewritten = 0
  body = body.replace(/^((?:import\b[^\n]*?\bfrom|import|\}\s*from)\s*)"([^"\n]+)"/gm, (_m, head, spec) => {
    rewritten++
    return `${head}"${resolveSpecifier(spec)}"`
  })
  assert.ok(rewritten >= 20, `only ${rewritten} import specifiers rewritten — the fixture's import pattern is stale`)
  body += `\nexport { ${exportNames.join(", ")} }\n`
  const dir = mkdtempSync(join(tmpdir(), "keeper-cycle-"))
  const file = join(dir, "executor-under-test.mjs")
  writeFileSync(file, body)
  return import(pathToFileURL(file).href)
}

function resolveSpecifier(spec) {
  if (spec.startsWith("./") || spec.startsWith("../")) return new URL(spec, EXECUTOR_DIR).href
  if (spec.startsWith("node:") || builtinModules.includes(spec)) return spec
  return import.meta.resolve(spec)
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────

const hex40 = (n) => "0x" + n.toString(16).padStart(40, "0")

/** A fake orders row. `n` makes the id, nonce and created_at unique unless overridden. */
export function makeRow(n, { createdAt, id, chainId = TEST_CHAIN_ID, type = "limit", status = "active" } = {}) {
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400
  const isDca = type === "dca"
  return {
    id: id ?? `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    created_at: createdAt ?? isoAt(n),
    updated_at: createdAt ?? isoAt(n),
    status,
    chain_id: chainId,
    wallet: hex40(0xa000 + n),
    order_type: type,
    expiry: String(expiry),
    signature: "0x" + "11".repeat(65),
    consecutive_failures: 0,
    last_attempt_at: null,
    dca_executed: 0,
    order_data: {
      owner: hex40(0xa000 + n),
      tokenIn: hex40(0xb001),
      tokenOut: hex40(0xb002),
      amountIn: "1000000",
      minAmountOut: "1",
      orderType: isDca ? 2 : 0,
      condition: 0,
      targetPrice: "100000000",
      priceFeed: isDca ? "0x0000000000000000000000000000000000000000" : hex40(0xc001),
      expiry: String(expiry),
      nonce: String(1_000_000 + n),
      router: hex40(0xd001),
      routerDataHash: "0x" + "00".repeat(32),
      dcaInterval: isDca ? "3600" : "0",
      dcaTotal: isDca ? "4" : "0",
    },
  }
}

/** `n` seconds after a fixed origin, in PostgREST's timestamptz output shape (µs, +00:00). */
export function isoAt(n, micros = 0) {
  const base = Date.parse("2026-08-01T00:00:00.000Z") + n * 1000
  const s = new Date(base).toISOString().slice(0, 19)
  return `${s}.${String(micros).padStart(6, "0")}+00:00`
}

// ── fake PostgREST ───────────────────────────────────────────────────────────────────────────────

export function createFakePostgrest(rows) {
  const table = rows.map((r) => ({ ...r }))
  const requests = []
  const unexpected = []
  let failNext = null // { match: RegExp, status, body } — fail the next matching request once

  async function handle(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = (init.method || "GET").toUpperCase()
    const headers = new Headers(init.headers || {})
    requests.push({ method, path: url.pathname, search: url.search, prefer: headers.get("prefer") || "" })
    if (url.origin !== FAKE_SUPABASE_URL) {
      unexpected.push(`${method} ${url.origin}${url.pathname}`)
      return new Response("not this fake", { status: 501 })
    }
    if (failNext && failNext.match.test(url.search) && method === (failNext.method || method)) {
      const f = failNext
      failNext = null
      return new Response(f.body, { status: f.status })
    }
    if (url.pathname !== "/rest/v1/orders") {
      unexpected.push(`${method} ${url.pathname}`)
      return new Response("unknown table", { status: 501 })
    }
    const params = new URLSearchParams(url.search)
    let matched
    try {
      matched = table.filter(rowFilter(params))
    } catch (e) {
      unexpected.push(`${method} ${url.search} — ${e.message}`)
      return new Response(JSON.stringify({ code: "PGRST100", message: e.message }), { status: 400 })
    }
    if (method === "PATCH") {
      const patch = JSON.parse(init.body || "{}")
      for (const r of matched) Object.assign(r, patch)
      const range = matched.length === 0 ? "*/0" : `0-${matched.length - 1}/*`
      return new Response(null, { status: 204, headers: { "content-range": range } })
    }
    if (method !== "GET" && method !== "HEAD") {
      unexpected.push(`${method} ${url.search}`)
      return new Response("method", { status: 501 })
    }
    const order = params.get("order")
    if (order) matched.sort(orderComparator(order))
    const total = matched.length
    const limit = params.has("limit") ? Number(params.get("limit")) : Infinity
    const page = matched.slice(0, limit)
    const counted = /count=exact/.test(headers.get("prefer") || "")
    const range = page.length === 0 ? `*/${counted ? total : "*"}` : `0-${page.length - 1}/${counted ? total : "*"}`
    const body = method === "HEAD" ? null : JSON.stringify(page.map((r) => ({ ...r })))
    return new Response(body, { status: 200, headers: { "content-range": range, "content-type": "application/json" } })
  }

  return {
    table,
    requests,
    unexpected,
    fetch: handle,
    insert: (row) => table.push({ ...row }),
    remove: (id) => {
      const i = table.findIndex((r) => r.id === id)
      if (i >= 0) table.splice(i, 1)
    },
    failNextMatching: (match, status, body, method) => (failNext = { match, status, body, method }),
  }
}

const RESERVED = new Set(["select", "order", "limit", "offset", "or", "and"])

function rowFilter(params) {
  const preds = []
  for (const [key, value] of params) {
    if (key === "or" || key === "and") preds.push(logicTree(key, value))
    else if (!RESERVED.has(key)) preds.push(condition(key, value))
  }
  return (row) => preds.every((p) => p(row))
}

function logicTree(op, value) {
  if (!value.startsWith("(") || !value.endsWith(")")) throw new Error(`${op} needs parentheses: ${value}`)
  const parts = splitTopLevel(value.slice(1, -1))
  const preds = parts.map((part) => {
    const m = /^(and|or)(\(.*\))$/s.exec(part)
    if (m) return logicTree(m[1], m[2])
    const dot = part.indexOf(".")
    if (dot < 0) throw new Error(`bad condition ${part}`)
    return condition(part.slice(0, dot), part.slice(dot + 1), { inTree: true })
  })
  return op === "and" ? (row) => preds.every((p) => p(row)) : (row) => preds.some((p) => p(row))
}

function splitTopLevel(s) {
  const out = []
  let depth = 0
  let quoted = false
  let cur = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"' && s[i - 1] !== "\\") quoted = !quoted
    if (!quoted && ch === "(") depth++
    if (!quoted && ch === ")") depth--
    if (!quoted && depth === 0 && ch === ",") {
      out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (quoted || depth !== 0) throw new Error(`unbalanced logic tree: ${s}`)
  out.push(cur)
  return out
}

function condition(column, opValue, { inTree = false } = {}) {
  const dot = opValue.indexOf(".")
  if (dot < 0) throw new Error(`bad filter ${column}=${opValue}`)
  const op = opValue.slice(0, dot)
  let raw = opValue.slice(dot + 1)
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw new Error(`unterminated quote in ${column}`)
    raw = raw.slice(1, -1).replace(/\\"/g, '"')
  } else if (inTree && /[,()":]/.test(raw)) {
    // Stricter than needed on purpose: PostgREST's docs say to double-quote a value holding a reserved
    // character (, . : ( )) — a timestamp inside or=(…) must arrive quoted here.
    throw new Error(`unquoted reserved character in ${column}: ${raw}`)
  }
  const cmp = (row) => compareColumn(column, row[column], raw)
  switch (op) {
    case "eq": return (row) => cmp(row) === 0
    case "neq": return (row) => cmp(row) !== 0
    case "gt": return (row) => cmp(row) > 0
    case "gte": return (row) => cmp(row) >= 0
    case "lt": return (row) => cmp(row) < 0
    case "lte": return (row) => cmp(row) <= 0
    case "is":
      if (raw === "null") return (row) => row[column] === null || row[column] === undefined
      throw new Error(`is.${raw} unsupported`)
    default:
      throw new Error(`operator ${op} unsupported`)
  }
}

function compareColumn(column, a, b) {
  if (a === null || a === undefined) return NaN
  if (column === "created_at" || column === "updated_at") return compareTimestamps(String(a), String(b))
  if (column === "chain_id") return Number(a) - Number(b)
  const x = String(a).toLowerCase()
  const y = String(b).toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/** Timestamp order, independent of the helper's own parser: whole seconds, then the fraction. */
export function compareTimestamps(a, b) {
  const pa = splitTs(a)
  const pb = splitTs(b)
  if (pa.secs !== pb.secs) return pa.secs < pb.secs ? -1 : 1
  return pa.frac < pb.frac ? -1 : pa.frac > pb.frac ? 1 : 0
}

function splitTs(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s)
  if (!m) throw new Error(`not a timestamp: ${JSON.stringify(s)}`)
  let zone = m[4] || "Z"
  if (/^[+-]\d{2}$/.test(zone)) zone += ":00"
  const secs = Date.parse(`${m[1]}T${m[2]}${zone}`) / 1000
  if (!Number.isFinite(secs)) throw new Error(`not a timestamp: ${JSON.stringify(s)}`)
  return { secs, frac: (m[3] || "").padEnd(9, "0") }
}

function orderComparator(order) {
  const keys = order.split(",").map((k) => {
    const [col, dir = "asc"] = k.split(".")
    return { col, sign: dir === "desc" ? -1 : 1 }
  })
  return (x, y) => {
    for (const { col, sign } of keys) {
      const c = compareColumn(col, x[col], y[col])
      if (c !== 0) return sign * c
    }
    return 0
  }
}

// ── fake chain ───────────────────────────────────────────────────────────────────────────────────

/**
 * A public client whose canExecute answers come from `answerFor(row)` → [bool, reason]. Every canExecute
 * call is recorded (the row id, in order) — that is what "examined" means at the chain.
 */
export function createFakeChain(db, answerFor) {
  const canExecuteCalls = []
  const publicClient = {
    async readContract({ functionName, args }) {
      if (functionName === "latestRoundData") return [1n, 200_000_000_000n, 0n, 0n, 1n]
      if (functionName === "canExecute") {
        const nonce = String(args[0].nonce)
        const row = db.table.find((r) => r.order_data?.nonce === nonce)
        assert.ok(row, `canExecute for an unknown nonce ${nonce}`)
        canExecuteCalls.push(row.id)
        return answerFor(row)
      }
      throw new Error(`fake chain: unexpected readContract ${functionName}`)
    },
  }
  return { publicClient, canExecuteCalls }
}

/** Run `fn` with global fetch → the fake, and console.* captured (returned as `lines`). */
export async function withFakes(db, fn) {
  const realFetch = globalThis.fetch
  const real = { log: console.log, warn: console.warn, error: console.error }
  const lines = []
  globalThis.fetch = db.fetch
  console.log = (...a) => lines.push(a.join(" "))
  console.warn = (...a) => lines.push(a.join(" "))
  console.error = (...a) => lines.push(a.join(" "))
  try {
    const result = await fn()
    return { result, lines }
  } finally {
    globalThis.fetch = realFetch
    Object.assign(console, real)
  }
}
