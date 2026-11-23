// [fix/keeper-errors-no-signature] A87 S-2 — seeded property test of redactError and capAlertText.
//
// Random error shapes: the keeper's viem error classes built by viem's own constructors (ContractFunctionExecutionError
// over CallExecutionError / TransactionExecutionError / EstimateGasExecutionError over HttpRequestError / TimeoutError /
// RpcRequestError / ExecutionRevertedError / InsufficientFundsError / InternalRpcError, ContractFunctionRevertedError),
// nested and circular causes, plain Errors, strings and hostile objects; long hex runs, 65-byte signatures, keyed URLs
// in every shape the redactor knows, and multi-megabyte messages. Properties, for every case:
//   redactError never throws, returns a string of at most min(600, max) characters, with no run of 130+ hex digits,
//   no secret of a keyed URL, no `args:` / `data:` line and no Request / Raw Call Arguments block;
//   capAlertText returns at most `max` characters of well-formed Telegram HTML.
//
// Seeds: S2_SEEDS (default 1..24) x S2_CASES (default 40). A failure names its seed and case; rerun it alone with
// S2_SEEDS=<seed>. Wider local runs: S2_SEEDS=1-500.
//
// Run: node --test contracts/order-engine/executor/redact-s2-property.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  InternalRpcError,
  RpcRequestError,
  TimeoutError,
  TransactionExecutionError,
  encodeErrorResult,
} from "viem"
import { ORDER_EXECUTOR_V3_ABI } from "./viem-wrapped-errors.fixture.mjs"
import { redactError, capAlertText, ERROR_TEXT_MAX } from "./redact.js"

function parseSeeds(spec) {
  if (!spec) return Array.from({ length: 24 }, (_, i) => i + 1)
  const m = /^(\d+)-(\d+)$/.exec(spec)
  if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i)
  return spec.split(",").map(Number)
}
const SEEDS = parseSeeds(process.env.S2_SEEDS)
const CASES = Number(process.env.S2_CASES) || 40

/** mulberry32: a small, fast, seeded PRNG. */
function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = (xs) => xs[int(0, xs.length - 1)]
  const chance = (p) => next() < p
  return { next, int, pick, chance }
}

const HEX = "0123456789abcdef"
const NOT_HEX = "ghijkmnpqrstuvwxyz" // a secret built from these is removed by URL redaction, never by the hex scrub
const STRUCT = {
  owner: "0x00000000000000000000000000000000000000a1",
  tokenIn: "0x00000000000000000000000000000000000000b2",
  tokenOut: "0x00000000000000000000000000000000000000c3",
  amountIn: 1_000_000n,
  minAmountOut: 0n,
  maxSlippageBps: 50,
  orderType: 3,
  condition: 0,
  targetPrice: 0n,
  priceFeed: "0x0000000000000000000000000000000000000000",
  expiry: 4_102_444_800n,
  nonce: 1n,
  router: "0x00000000000000000000000000000000000000d4",
  routerDataHash: `0x${"00".repeat(32)}`,
  dcaInterval: 3_600n,
  dcaTotal: 10n,
}
const ERROR_ABI = [{ type: "error", name: "Error", inputs: [{ type: "string" }] }]

function generator(seed) {
  const r = rng(seed)
  const secrets = []
  const hex = (n, upper = r.chance(0.2)) => {
    let s = ""
    for (let i = 0; i < n; i++) s += HEX[r.int(0, 15)]
    return upper ? s.toUpperCase() : s
  }
  const secret = () => {
    let s = "K"
    for (let i = 0, n = r.int(10, 24); i < n; i++) s += NOT_HEX[r.int(0, NOT_HEX.length - 1)]
    secrets.push(s)
    return s
  }
  const host = () => r.pick(["base-mainnet.g.alchemy.com", "rpc.example.com", "arb1.provider.example", "eth.llamarpc.example"])
  const keyedUrl = () => {
    const k = secret()
    return r.pick([
      () => `https://${host()}/v2/${k}`,
      () => `wss://${host()}/v2/${k}`,
      () => `https://ops:${k}@${host()}/`,
      () => `HTTPS://${host().toUpperCase()}/?apikey=${k}&x=1`,
      () => `http://127.0.0.1:8545/v2/${k}`,
      () => `${host()}/v2/${k}`,
      () => `https:\\/\\/${host()}\\/v2\\/${k}`,
      () => `https://${host()}%2Fv2%2F${k}`,
      () => `https://${host()}/rpc#${k}`,
    ])()
  }
  const signature = () => `0x${hex(130)}`
  const longHex = () => `${r.chance(0.6) ? "0x" : ""}${hex(r.int(130, 4_000))}`
  const words = () => r.pick(["execution reverted", "not ready", "nonce too low", "fetch failed", "HTTP request failed.", "Details: oops", "émoji 🚨 <b>&amp;", "insufficient funds", "x"])
  const fragment = () =>
    r.pick([
      words,
      keyedUrl,
      signature,
      longHex,
      () => `args:     (${JSON.stringify({ owner: "0xa1" })}, ${signature()})`,
      () => `  data:  ${longHex()}`,
      () => `Request Arguments:\n  from:  0x00000000000000000000000000000000000000a1\n  data:  ${longHex()}`,
      () => `Raw Call Arguments:\n  to:  0x000000000000000000000000000000000000beef\n  data:  ${signature()}`,
      () => `URL: ${keyedUrl()}`,
      () => `Details: ${words()} ${keyedUrl()}`,
      () => `Status: ${r.int(400, 599)}`,
    ])()
  const text = (n = r.int(1, 8)) => {
    const parts = []
    for (let i = 0; i < n; i++) parts.push(fragment())
    return parts.join(r.pick([" ", "\n", ", ", "\n\n", ""]))
  }
  const huge = () => {
    const unit = text(6)
    return `big ${unit} `.repeat(Math.ceil(r.int(2_000_000, 3_000_000) / (unit.length + 5)))
  }
  const body = () => ({ method: r.pick(["eth_call", "eth_estimateGas", "eth_sendRawTransaction"]), params: [{ data: r.chance(0.5) ? signature() : longHex() }] })
  const transport = () =>
    r.pick([
      () => new HttpRequestError({ url: keyedUrl(), status: r.int(400, 599), body: body(), details: r.chance(0.1) ? huge() : text() }),
      () => new TimeoutError({ url: keyedUrl(), body: body() }),
      () => new RpcRequestError({ url: keyedUrl(), body: body(), error: { code: r.pick([-32603, -32000, 3]), message: text() } }),
      () => new ExecutionRevertedError({ message: `execution reverted: ${text(2)}` }),
      () => new InsufficientFundsError({ cause: new Error(text(2)) }),
      () => new InternalRpcError(new Error(text(2))),
    ])()
  const revert = () =>
    new ContractFunctionRevertedError({
      abi: ERROR_ABI,
      data: encodeErrorResult({ abi: ERROR_ABI, errorName: "Error", args: [text(2)] }),
      functionName: r.pick(["canExecute", "executeOrder"]),
    })
  const callArgs = () => ({ to: "0x000000000000000000000000000000000000beef", data: `0x${hex(r.int(200, 3_000))}`, maxFeePerGas: 1n })
  const wrapped = () => {
    let cause = r.chance(0.3) ? revert() : transport()
    const layer = r.pick([
      (c) => new CallExecutionError(c, callArgs()),
      (c) => new EstimateGasExecutionError(c, callArgs()),
      (c) => new TransactionExecutionError(new EstimateGasExecutionError(c, callArgs()), callArgs()),
      (c) => c,
    ])
    cause = layer(cause)
    const fn = r.pick(["canExecute", "executeOrder"])
    const args = fn === "canExecute" ? [STRUCT, signature()] : [STRUCT, signature(), longHex().startsWith("0x") ? `0x${hex(r.int(4, 2_000))}` : "0x"]
    return new ContractFunctionExecutionError(cause, { abi: ORDER_EXECUTOR_V3_ABI, args, contractAddress: "0x000000000000000000000000000000000000beef", functionName: fn, sender: "0x00000000000000000000000000000000000000a1" })
  }
  const plain = () => {
    const e = new (r.pick([Error, TypeError, RangeError]))(r.chance(0.05) ? huge() : text())
    if (r.chance(0.3)) e.shortMessage = text(2)
    if (r.chance(0.3)) e.details = text(2)
    let tail = e
    for (let d = 0, n = r.int(0, 6); d < n; d++) {
      tail.cause = r.chance(0.5) ? wrapped() : new Error(text(2))
      tail = tail.cause
    }
    if (r.chance(0.1)) tail.cause = e // circular
    return e
  }
  const hostile = () => {
    const o = {}
    for (const k of ["name", "message", "shortMessage", "cause", "data", "raw", "reason"]) {
      if (r.chance(0.5)) Object.defineProperty(o, k, { get() { throw new Error(`getter ${k}`) } })
      else if (r.chance(0.5)) o[k] = text(2)
    }
    return o
  }
  const value = () =>
    r.pick([
      wrapped,
      wrapped,
      wrapped,
      plain,
      plain,
      hostile,
      () => (r.chance(0.1) ? huge() : text()),
      () => r.pick([null, undefined, 42, 10n, Symbol("s"), [text(1)], { toString: () => text(1) }]),
      () => {
        const p = Proxy.revocable({}, {})
        p.revoke()
        return p.proxy
      },
    ])()
  const html = () => {
    const parts = []
    for (let i = 0, n = r.int(1, 60); i < n; i++) {
      parts.push(
        r.pick([
          () => `<b>${r.pick(["Ops", "🚨 Alert", "x"])}</b>`,
          () => `<code>0x${hex(r.int(1, 64))}</code>`,
          () => `<a href="https://basescan.org/tx/0x${hex(64)}">tx</a>`,
          () => r.pick(["&amp;", "&lt;", "&gt;", "&quot;"]).repeat(r.int(1, 200)),
          () => "plain words ".repeat(r.int(1, 100)),
          () => "🚨".repeat(r.int(1, 50)),
          () => "\n",
        ])(),
      )
    }
    return parts.join("")
  }
  return { r, secrets, value, html }
}

/** The length of the text an input carries (message, or the string itself); 0 when unreadable. */
function inputSize(v) {
  try {
    if (typeof v === "string") return v.length
    let n = 0
    for (let e = v, d = 0; e && typeof e === "object" && d < 8; e = e.cause, d++) n = Math.max(n, typeof e.message === "string" ? e.message.length : 0)
    return n
  } catch {
    return 0
  }
}
function kindOf(v) {
  try {
    if (v === null || typeof v !== "object") return typeof v
    const n = v.name
    return typeof n === "string" && /^[A-Za-z]\w{0,60}$/.test(n) ? n : "object (text name)"
  } catch {
    return "hostile"
  }
}

const HEX_RUN_130 = /[0-9a-f]{130,}/i
const BLOCK_LINE = /^\s*(?:args|data)\s*:|^\s*(?:Request|Raw Call) Arguments\s*:/im
function wellFormed(html) {
  if (/&(?!(?:amp|lt|gt|quot|#\d{1,7}|#x[0-9a-f]{1,6});)/i.test(html)) return false
  const stack = []
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9-]{0,15})(?:\s[^<>]*)?>/gi)) {
    if (m[1] === "") stack.push(m[2].toLowerCase())
    else if (stack.pop() !== m[2].toLowerCase()) return false
  }
  return stack.length === 0 && !/<[^>]*$/.test(html)
}

describe(`[A87 S-2] redactError properties (seeds ${SEEDS[0]}..${SEEDS[SEEDS.length - 1]}, ${CASES} cases each)`, () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, (t) => {
      const g = generator(seed)
      const kinds = {}
      let multiMb = 0
      let largest = 0
      for (let c = 0; c < CASES; c++) {
        g.secrets.length = 0
        const v = g.value()
        const max = g.r.chance(0.2) ? g.r.int(40, 700) : undefined
        const size = inputSize(v)
        largest = Math.max(largest, size)
        if (size > 1_000_000) multiMb++
        const kind = kindOf(v)
        kinds[kind] = (kinds[kind] || 0) + 1
        let out
        assert.doesNotThrow(() => {
          out = redactError(v, max === undefined ? undefined : { max })
        }, `seed ${seed} case ${c}`)
        const where = `seed ${seed} case ${c}: ${String(out).slice(0, 160)}`
        assert.equal(typeof out, "string", where)
        assert.ok(out.length <= Math.min(ERROR_TEXT_MAX, max ?? ERROR_TEXT_MAX), `${where} (length ${out.length}, max ${max})`)
        assert.ok(!HEX_RUN_130.test(out), where)
        assert.ok(!BLOCK_LINE.test(out), where)
        for (const s of g.secrets) assert.ok(!out.includes(s), `${where} (secret ${s})`)
      }
      t.diagnostic(`kinds ${JSON.stringify(kinds)} multiMB ${multiMb} largest ${largest}`)
    })
  }
})

describe(`[A87 S-2] capAlertText properties (seeds ${SEEDS[0]}..${SEEDS[SEEDS.length - 1]})`, () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      const g = generator(seed)
      for (let c = 0; c < CASES; c++) {
        const s = g.html()
        const max = g.r.int(60, 4_096)
        const out = capAlertText(s, max)
        const where = `seed ${seed} case ${c} (max ${max}, in ${s.length})`
        assert.ok(out.length <= max, `${where}: ${out.length}`)
        assert.ok(wellFormed(out), `${where}: …${out.slice(-120)}`)
        if (s.length <= max) assert.equal(out, s, where)
      }
    })
  }
})
