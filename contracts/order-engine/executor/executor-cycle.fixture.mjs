// Test fixture (not a test): runs the SHIPPED executeCycle / fetchActiveOrders of executor.js against an
// in-process fake PostgREST and a fake chain, so a cycle-level test exercises the real text.
//
// executor.js runs main() when imported, so it cannot be imported as is. loadShippedExecutor() copies its
// source to a temp file with three edits: (1) every import specifier is made absolute (relative ones point
// back at this directory, `viem` resolves from this directory's node_modules), (2) the trailing
// `main().catch(…)` call is cut, (3) an `export { … }` line is appended. Two OPTIONAL edits, used only by
// the tests that ask for them: (4) `constants: { NAME: value }` replaces the value of a top-level
// `const NAME = …` line (a smaller scan for CPU, a shorter time limit), skipped when the line does not
// exist, so the same test can load an older executor.js; (5) `optionalExports: [name]` exports
// `<name>__opt`, undefined when executor.js has no such binding. Nothing else in the text changes.
// `sourceFile` loads another executor.js (the differential rig loads origin/main's) the same way.
//
// The fake PostgREST implements only what the keeper sends to /rest/v1/orders: eq / neq / gt / gte / lt /
// lte / is / in filters, or=(…) / and=(…) logic trees with optional double-quoted values,
// order=a.asc,b.asc, limit, offset, GET / HEAD / PATCH, Prefer: count=exact (Content-Range "a-b/N" or
// "*/N"), plus POST /rest/v1/order_executions (a fill's record). Query strings are decoded the way
// PostgREST decodes them ('+' is a space), so an unencoded '+' in a timestamp breaks here as it would
// there. created_at compares as a timestamp (epoch seconds, then the fraction), id as a lowercase string
// (Postgres uuid order). Any request to another host, or one this fake does not understand, is recorded
// in `unexpected` and answered 501. `failWhen(fn)` makes any request fail, hang (until its AbortSignal
// fires) or throw like undici's "fetch failed".
//
// The fake chain answers canExecute asked directly (the per-order path), alone with an explicit gas cap (the
// pre-screen's single ask, round 3) and through Multicall3's aggregate3 (the pre-screen), records every ask,
// and — when a test gives it a wallet — really executes: writeContract records the fill, the receipt is a
// success, and that nonce is used from then on.
//
// Round 3 (A91 R2-1): a row may be a gas BURNER ({ burn: true }: its canExecute burns all the gas it gets, as a
// hostile tokenIn.balanceOf or priceFeed.latestRoundData would). Asked alone or by the path it fails "out of
// gas"; inside aggregate3 the call's fate comes from multicallGasModel (calibrated against the real Multicall3
// bytecode and the V3 executor in Foundry — PrescreenBisect.t.sol / the round-3 feedback), or from a `replay`
// table whose every entry Foundry verified.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { encodeFunctionResult, keccak256, RpcRequestError, TimeoutError } from "viem"

const EXECUTOR_DIR = new URL("./", import.meta.url)

export const FAKE_SUPABASE_URL = "http://supabase.fake.test"
export const TEST_CHAIN_ID = 8453
export const OTHER_CHAIN_ID = 42161
export const V2_EXECUTOR = "0x135B339902Ea4E0fB4CF059961dc8856bA1D2598"
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
const ZERO_HASH = "0x" + "00".repeat(32)

/**
 * Copy executor.js (edits listed in the header) to a temp file and import it. `env` is applied after the
 * fixture's own variables (e.g. ORDER_EXECUTOR_V3_ADDRESS, which executor.js reads at module scope).
 * @param {{ exportNames?: string[], optionalExports?: string[], constants?: Record<string, string|number>, sourceFile?: string|URL, env?: Record<string, string> }} [opts]
 */
export async function loadShippedExecutor({
  exportNames = ["executeCycle", "fetchActiveOrders"],
  optionalExports = [],
  constants = {},
  sourceFile = new URL("executor.js", EXECUTOR_DIR),
  env = {},
} = {}) {
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
  delete process.env.TERASWAP_API_URL
  delete process.env.FLASHBOTS_RPC_URL
  Object.assign(process.env, env)

  const src = readFileSync(sourceFile, "utf8")
  const cut = src.lastIndexOf("\nmain().catch(")
  assert.ok(cut > 0, "executor.js no longer ends with main().catch(…) — update the fixture")
  let body = src.slice(0, cut + 1)
  let rewritten = 0
  body = body.replace(/^((?:import\b[^\n]*?\bfrom|import|\}\s*from)\s*)"([^"\n]+)"/gm, (_m, head, spec) => {
    rewritten++
    return `${head}"${resolveSpecifier(spec)}"`
  })
  assert.ok(rewritten >= 20, `only ${rewritten} import specifiers rewritten — the fixture's import pattern is stale`)
  for (const [name, value] of Object.entries(constants)) {
    const re = new RegExp(`^const ${name} = [^\\n]*$`, "m")
    if (re.test(body)) body = body.replace(re, `const ${name} = ${value} // [fixture constant]`)
  }
  body += `\nexport { ${exportNames.join(", ")} }\n`
  for (const name of optionalExports) {
    body += `export const ${name}__opt = (() => { try { return ${name} } catch { return undefined } })()\n`
  }
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

/**
 * A fake orders row. `n` makes the id, nonce and created_at unique unless overridden. `pinned: true` gives a
 * non-DCA row a stored route and its signed hash, so the per-order path can really execute it.
 */
export function makeRow(n, { createdAt, id, chainId = TEST_CHAIN_ID, type = "limit", status = "active", pinned = false, expiry } = {}) {
  const exp = expiry ?? Math.floor(Date.now() / 1000) + 30 * 86400
  const isDca = type === "dca"
  const routerData = pinned && !isDca ? "0x5a" + n.toString(16).padStart(70, "0") : undefined
  return {
    id: id ?? `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    created_at: createdAt ?? isoAt(n),
    updated_at: createdAt ?? isoAt(n),
    status,
    chain_id: chainId,
    wallet: hex40(0xa000 + n),
    order_type: type,
    expiry: String(exp),
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
      expiry: String(exp),
      nonce: String(1_000_000 + n),
      router: hex40(0xd001),
      routerDataHash: routerData ? keccak256(routerData) : ZERO_HASH,
      ...(routerData ? { routerData } : {}),
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
  const executionsPosted = []
  const telegram = []
  let failNext = null // { match: RegExp, status, body } — fail the next matching request once
  let failWhen = null // (req) => null | { status, body } | "hang" | "throw"
  // The DCA freeze flag's table (one row, id='dca'): { status, body } answered after delayMs (unless the caller's
  // signal fires first), or "hang" / "throw". Default: a well-formed "not frozen".
  let freeze = { status: 200, body: '[{"frozen":false,"reason":null}]', delayMs: 0 }
  let version = 0
  const sortedCache = new Map() // order string -> { version, rows }
  const jsonCache = new WeakMap() // row -> its JSON text (dropped when a PATCH writes the row)
  const jsonOf = (r) => {
    let j = jsonCache.get(r)
    if (j === undefined) jsonCache.set(r, (j = JSON.stringify(r)))
    return j
  }

  function sortedBy(order) {
    const hit = sortedCache.get(order)
    if (hit && hit.version === version) return hit.rows
    const rows = [...table].sort(orderComparator(order))
    sortedCache.set(order, { version, rows })
    return rows
  }

  async function handle(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = (init.method || "GET").toUpperCase()
    const headers = new Headers(init.headers || {})
    const req = { method, path: url.pathname, search: url.search, prefer: headers.get("prefer") || "" }
    requests.push(req)
    if (url.host === "api.telegram.org") {
      telegram.push(JSON.parse(init.body || "{}"))
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } })
    }
    if (url.origin !== FAKE_SUPABASE_URL) {
      unexpected.push(`${method} ${url.origin}${url.pathname}`)
      return new Response("not this fake", { status: 501 })
    }
    if (failWhen) {
      const outcome = failWhen(req)
      if (outcome === "hang") return hang(init.signal)
      if (outcome === "throw") throw new TypeError("fetch failed")
      if (outcome) return new Response(outcome.body ?? "", { status: outcome.status })
    }
    if (failNext && failNext.match.test(url.search) && method === (failNext.method || method)) {
      const f = failNext
      failNext = null
      return new Response(f.body, { status: f.status })
    }
    if (url.pathname === "/rest/v1/circuit_breaker" && method === "GET") {
      if (freeze === "hang") return hang(init.signal)
      if (freeze === "throw") throw new TypeError("fetch failed")
      if (freeze.delayMs > 0) await delay(freeze.delayMs, init.signal)
      return new Response(freeze.body, { status: freeze.status, headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/rest/v1/order_executions") {
      if (method === "POST") {
        executionsPosted.push(JSON.parse(init.body || "{}"))
        return new Response(null, { status: 201 })
      }
      if (method === "GET") return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }
    if (url.pathname !== "/rest/v1/orders") {
      unexpected.push(`${method} ${url.pathname}`)
      return new Response("unknown table", { status: 501 })
    }
    const params = new URLSearchParams(url.search)
    let filter
    try {
      filter = rowFilter(params)
    } catch (e) {
      unexpected.push(`${method} ${url.search} — ${e.message}`)
      return new Response(JSON.stringify({ code: "PGRST100", message: e.message }), { status: 400 })
    }
    if (method === "PATCH") {
      const matched = table.filter(filter)
      const patch = JSON.parse(init.body || "{}")
      for (const r of matched) {
        Object.assign(r, patch)
        jsonCache.delete(r)
      }
      const range = matched.length === 0 ? "*/0" : `0-${matched.length - 1}/*`
      return new Response(null, { status: 204, headers: { "content-range": range } })
    }
    if (method !== "GET" && method !== "HEAD") {
      unexpected.push(`${method} ${url.search}`)
      return new Response("method", { status: 501 })
    }
    const order = params.get("order")
    const matched = (order ? sortedBy(order) : table).filter(filter)
    const total = matched.length
    const offset = params.has("offset") ? Number(params.get("offset")) : 0
    const limit = params.has("limit") ? Number(params.get("limit")) : Infinity
    const page = matched.slice(offset, offset + limit)
    const counted = /count=exact/.test(headers.get("prefer") || "")
    const range = page.length === 0 ? `*/${counted ? total : "*"}` : `${offset}-${offset + page.length - 1}/${counted ? total : "*"}`
    const body = method === "HEAD" ? null : `[${page.map(jsonOf).join(",")}]`
    return new Response(body, { status: 200, headers: { "content-range": range, "content-type": "application/json" } })
  }

  return {
    table,
    requests,
    unexpected,
    executionsPosted,
    telegram,
    fetch: handle,
    insert: (row) => {
      table.push({ ...row })
      version++
    },
    remove: (id) => {
      const i = table.findIndex((r) => r.id === id)
      if (i >= 0) table.splice(i, 1)
      version++
    },
    failNextMatching: (match, status, body, method) => (failNext = { match, status, body, method }),
    failWhen: (fn) => (failWhen = fn),
    /** The freeze flag's answer: { status, body, delayMs } | "hang" | "throw". */
    setFreeze: (spec) => (freeze = typeof spec === "string" ? spec : { status: 200, delayMs: 0, ...spec }),
  }
}

/** A request that never answers; when the caller's AbortSignal fires it rejects with the signal's reason. */
function hang(signal) {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

/** Wait `ms` (real time), or reject with the signal's reason when it fires first. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })
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
  if (op === "in") {
    if (!raw.startsWith("(") || !raw.endsWith(")")) throw new Error(`in needs parentheses: ${raw}`)
    const values = new Set(splitTopLevel(raw.slice(1, -1)).map((v) => unquote(v).toLowerCase()))
    return (row) => row[column] !== null && row[column] !== undefined && values.has(String(row[column]).toLowerCase())
  }
  if (raw.startsWith('"')) {
    raw = unquote(raw)
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

function unquote(v) {
  if (!v.startsWith('"')) return v
  if (!v.endsWith('"') || v.length < 2) throw new Error(`unterminated quote: ${v}`)
  return v.slice(1, -1).replace(/\\"/g, '"')
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

// Parsed once per distinct string: the fake sorts hundreds of rows per query, and re-parsing on every
// comparison made the property tests CPU-heavy enough to disturb timing-sensitive tests running beside them.
const splitTsCache = new Map()
function splitTs(s) {
  const hit = splitTsCache.get(s)
  if (hit) return hit
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s)
  if (!m) throw new Error(`not a timestamp: ${JSON.stringify(s)}`)
  let zone = m[4] || "Z"
  if (/^[+-]\d{2}$/.test(zone)) zone += ":00"
  const secs = Date.parse(`${m[1]}T${m[2]}${zone}`) / 1000
  if (!Number.isFinite(secs)) throw new Error(`not a timestamp: ${JSON.stringify(s)}`)
  const parsed = { secs, frac: (m[3] || "").padEnd(9, "0") }
  splitTsCache.set(s, parsed)
  return parsed
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

const CAN_EXECUTE_OUT = [
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "canExec", type: "bool" },
      { name: "reason", type: "string" },
    ],
  },
]
const AGGREGATE3_SELECTOR = "0x82ad56cb"

/**
 * The fate of one aggregate3 call over rows of kinds `burns[i]` (true = a gas burner) under an eth_call gas cap,
 * calibrated in Foundry on the real Multicall3 bytecode and the V3 executor (round-3 feedback tables): an honest
 * row costs ~11,000 gas; a burner reverts after burning 63/64 of 63/64 of what it was given, so ~1/32 is left;
 * an honest row given too little gas fails the same way; returning n results needs ~550·n gas. It reproduces the
 * measured minimum caps for two burners in 50 rows (0,49: 47M; 47,49: 31M; 3,41: 133M; 24,25: 300M; 0,1: 571M)
 * within a few %, and 1 burner never fails a 50-row call at caps >= 30M. Exact cases go through `replay`.
 * @param {boolean[]} burns
 * @param {number} cap
 * @returns {{ ok: boolean, success: boolean[] }}
 */
export function multicallGasModel(burns, cap) {
  const HONEST = 11_000
  let g = cap - 21_000 - 1_200 * burns.length // intrinsic + calldata, roughly
  const success = []
  for (const burn of burns) {
    if (g < 2_000) return { ok: false, success: [] } // Multicall3's own loop runs out
    if (burn || g * (63 / 64) < HONEST) {
      g = Math.floor(g / 32)
      success.push(false)
    } else {
      g -= HONEST
      success.push(true)
    }
  }
  return g >= 550 * burns.length ? { ok: true, success } : { ok: false, success: [] }
}

/** What a node answers when a call runs out of gas, the way viem wraps it (JSON-RPC -32000, HTTP 200). */
export function outOfGasError(fn) {
  const rpc = new RpcRequestError({ body: { method: "eth_call" }, error: { code: -32000, message: "out of gas" }, url: "http://127.0.0.1:9" })
  return Object.assign(new Error(`The contract function "${fn}" reverted.`), { name: "ContractFunctionExecutionError", cause: rpc })
}

/**
 * A chain whose canExecute answers come from `answerFor(row, state, route)` → [bool, reason], where route is
 * "screen" (through Multicall3, the pre-screen), "single" (the pre-screen asking one row alone with an explicit
 * gas cap) or "path" (asked directly by the per-order path). An answer may also be { revert: true } (the call
 * reverts), { throw: error } (the path's and a single ask's call throws it; the pre-screen sees a revert),
 * { burn: true } (a gas burner, see above) or { hang: true } (a single ask never answers). Every ask is
 * recorded, in order: `screenCalls`, `singleCalls` ({ id, gas }), `pathCalls` and `canExecuteCalls` (all).
 *
 * opts.wallet: also return a wallet client whose writeContract really executes (the fill is recorded in
 * `executions`; a non-DCA nonce is used from then on and answers "Nonce used"), with a successful receipt.
 * opts.account: the wallet client has an account (executeCycle then runs its cycle-start observability: the
 * balance, the DCA freeze flag, ETH/USD); getBalance answers 1 ETH.
 * opts.gasPriceWei: () => bigint, the gas price each read returns (default 0.01 gwei: Base's NORMAL tier).
 * opts.aggregate: ({ chunkIndex, ids }) => null | "throw" | "hang" | "absent" — how one aggregate3 call fails.
 * opts.gasCap: the eth_call gas cap multicallGasModel uses (default 50,000,000: geth's RPCGasCap).
 * opts.replay: ("aggregate" | "single", ids) => { ok, success? } — Foundry-verified outcomes instead of the model.
 * opts.receiptGate: () => Promise — awaited before every receipt (a test holds a cycle inside its receipt wait).
 * opts.rpcHang + opts.rpcLimitMs: every RPC method for which rpcHang(method) is true never answers; with
 * rpcLimitMs it rejects after that long with viem's TimeoutError — standing in for viem's http transport limit
 * (10 s per try, 3 retries), which the fake bypasses.
 */
export function createFakeChain(
  db,
  answerFor,
  { wallet = false, account = false, gasPriceWei = () => 10_000_000n, aggregate = null, gasCap = 50_000_000, replay = null, receiptGate = null, rpcHang = null, rpcLimitMs = null } = {},
) {
  const canExecuteCalls = []
  const screenCalls = []
  const singleCalls = []
  const pathCalls = []
  const executions = []
  const aggregateCalls = []
  // Pre-screen answers the keeper actually RECEIVED (an answered aggregate3's results, a single ask that answered):
  // { id, route: "screen" | "single", result: "true" | "false" | "unanswered" }, in order.
  const delivered = []
  const state = { usedNonces: new Set(), dcaFills: new Map() }
  const hangs = (method) => {
    if (!rpcHang || !rpcHang(method)) return null
    return new Promise((_resolve, reject) => {
      if (rpcLimitMs !== null) setTimeout(() => reject(new TimeoutError({ body: { method }, url: "http://127.0.0.1:9" })), rpcLimitMs)
    })
  }
  const byNonce = () => {
    const m = new Map()
    for (const r of db.table) m.set(String(r.order_data?.nonce), r)
    return m
  }
  const answer = (row, route) => {
    const nonce = String(row.order_data.nonce)
    if (row.order_type !== "dca" && state.usedNonces.has(nonce)) return [false, "Nonce used"]
    return answerFor(row, state, route)
  }
  let txCounter = 0
  let aggregateIndex = 0

  const publicClient = {
    async readContract({ address, functionName, args, gas }) {
      const hung = hangs(functionName)
      if (hung) return hung
      if (functionName === "latestRoundData") return [1n, 200_000_000_000n, 0n, 0n, 1n]
      if (functionName === "canExecute") {
        const nonce = String(args[0].nonce)
        const row = db.table.find((r) => r.order_data?.nonce === nonce)
        assert.ok(row, `canExecute for an unknown nonce ${nonce}`)
        canExecuteCalls.push(row.id)
        if (gas !== undefined) {
          // The pre-screen asking one row ALONE, with an explicit gas cap (round 3).
          singleCalls.push({ id: row.id, gas })
          if (replay) {
            const r = replay("single", [row.id])
            if (!r.ok) throw outOfGasError("canExecute")
          }
          const a = answer(row, "single")
          if (a && a.hang) return new Promise(() => {})
          if (a && a.burn) throw outOfGasError("canExecute")
          if (a && a.throw) throw a.throw
          if (a && a.revert) throw new Error("execution reverted")
          delivered.push({ id: row.id, route: "single", result: a[0] ? "true" : "false" })
          return a
        }
        pathCalls.push(row.id)
        const a = answer(row, "path")
        if (a && a.burn) throw outOfGasError("canExecute") // the node's own eth_call cap
        if (a && a.throw) throw a.throw
        if (a && a.revert) throw new Error("execution reverted")
        return a
      }
      if (functionName === "aggregate3") {
        assert.equal(address.toLowerCase(), MULTICALL3.toLowerCase(), "aggregate3 sent to Multicall3")
        const calls = args[0]
        const index = map(byNonce())
        const rows = calls.map((c) => index(c))
        const chunkIndex = aggregateIndex++
        aggregateCalls.push({ chunkIndex, ids: rows.map((r) => r.id), size: calls.length })
        const failure = aggregate ? aggregate({ chunkIndex, ids: rows.map((r) => r.id) }) : null
        if (failure === "hang") return new Promise(() => {})
        if (failure === "throw") throw new Error("HTTP request failed. Status: 503")
        if (failure === "absent") throw new Error('The contract function "aggregate3" returned no data ("0x").')
        const answers = rows.map((row) => answer(row, "screen"))
        const fate = replay ? replay("aggregate", rows.map((r) => r.id)) : answers.some((a) => a && a.burn) ? multicallGasModel(answers.map((a) => Boolean(a && a.burn)), gasCap) : null
        if (fate && !fate.ok) throw outOfGasError("aggregate3")
        return rows.map((row, j) => {
          canExecuteCalls.push(row.id)
          screenCalls.push(row.id)
          const a = answers[j]
          if ((fate && !fate.success[j]) || (a && (a.revert || a.throw || a.burn || a.hang))) {
            delivered.push({ id: row.id, route: "screen", result: "unanswered" })
            return { success: false, returnData: "0x" }
          }
          delivered.push({ id: row.id, route: "screen", result: a[0] ? "true" : "false" })
          return { success: true, returnData: encodeFunctionResult({ abi: CAN_EXECUTE_OUT, functionName: "canExecute", result: [a[0], a[1]] }) }
        })
      }
      throw new Error(`fake chain: unexpected readContract ${functionName}`)
    },
    async getBalance() {
      return hangs("getBalance") ?? 10n ** 18n
    },
    async getGasPrice() {
      return hangs("getGasPrice") ?? gasPriceWei()
    },
    async getBlock() {
      return hangs("getBlock") ?? { baseFeePerGas: 1_000_000n }
    },
    async waitForTransactionReceipt() {
      const hung = hangs("waitForTransactionReceipt")
      if (hung) return hung
      if (receiptGate) await receiptGate()
      return { status: "success", gasUsed: 100_000n, effectiveGasPrice: 1n, logs: [] }
    },
  }
  const walletClient = wallet
    ? {
        ...(account ? { account: { address: "0x00000000000000000000000000000000000ce111" } } : {}),
        async writeContract({ functionName, args }) {
          const hung = hangs("writeContract")
          if (hung) return hung
          assert.equal(functionName, "executeOrder")
          const nonce = String(args[0].nonce)
          const row = db.table.find((r) => r.order_data?.nonce === nonce)
          assert.ok(row, `executeOrder for an unknown nonce ${nonce}`)
          executions.push(row.id)
          if (row.order_type === "dca") state.dcaFills.set(nonce, (state.dcaFills.get(nonce) ?? 0) + 1)
          else state.usedNonces.add(nonce)
          txCounter++
          return "0x" + txCounter.toString(16).padStart(64, "0")
        },
      }
    : null
  return { publicClient, walletClient, canExecuteCalls, screenCalls, singleCalls, pathCalls, executions, aggregateCalls, delivered, state }
}

/**
 * The row an encoded canExecute call is for, by its nonce word. v2's Order tuple is 15 static words and v3's
 * 16 (maxSlippageBps after minAmountOut), so the nonce is word 10 (v2) or 11 (v3) after the selector — a
 * slice, not a full ABI decode, so a 1000-row pre-screen stays cheap. active-window-cycle.test.mjs checks it
 * against viem's decodeFunctionData.
 */
function map(byNonce) {
  return (call) => {
    const data = String(call.callData)
    const isV2 = String(call.target).toLowerCase() === V2_EXECUTOR.toLowerCase()
    const word = isV2 ? 10 : 11
    const hex = data.slice(10 + 64 * word, 10 + 64 * (word + 1))
    const nonce = BigInt("0x" + hex).toString()
    const row = byNonce.get(nonce)
    assert.ok(row, `aggregate3 call for an unknown nonce ${nonce}`)
    return row
  }
}
export const NONCE_WORD = { v2: 10, v3: 11 }
export { AGGREGATE3_SELECTOR }

/**
 * Run `fn` with global fetch → the fake, and console.* captured (returned as `lines`). With `nowMs`, the clock
 * stands at that instant for the duration of `fn`: Date.now() AND `new Date()` (a lock's updated_at and the
 * stale-unlock cutoff must read the same clock); with `random`, Math.random() is that function.
 */
export async function withFakes(db, fn, { nowMs = null, random = null } = {}) {
  const realFetch = globalThis.fetch
  const RealDate = globalThis.Date
  const realRandom = Math.random
  const real = { log: console.log, warn: console.warn, error: console.error }
  const lines = []
  globalThis.fetch = db.fetch
  if (nowMs !== null) {
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(nowMs)
        else super(...args)
      }
      static now() {
        return nowMs
      }
    }
    globalThis.Date = FakeDate
  }
  if (random) Math.random = random
  console.log = (...a) => lines.push(a.join(" "))
  console.warn = (...a) => lines.push(a.join(" "))
  console.error = (...a) => lines.push(a.join(" "))
  try {
    const result = await fn()
    return { result, lines }
  } finally {
    globalThis.fetch = realFetch
    globalThis.Date = RealDate
    Math.random = realRandom
    Object.assign(console, real)
  }
}

/** Seeded PRNG (mulberry32), for tables, answers and the keeper's own Math.random in a test. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
