/**
 * [ADR-024 scope addition 2026-10-11] runtime-config.js — the boot-time keeper_runtime_config
 * publish, and the hard ceiling on the no-price fill cap it reports.
 *
 *   1. Row builder validates every column; keeper version = KEEPER_VERSION env else package.json.
 *   2. Upsert goes through the keeper's OWN service-role fetch with PostgREST merge-duplicates;
 *      every failure (404 / missing table, 5xx, thrown) is LOGGED and returned, never thrown.
 *   3. executor.js boot: resolves the clamped cap, is loud when clamped, publishes inside try/catch,
 *      all before the health server / first cycle — and nothing can make it fatal.
 *
 * Zero network: supabaseFetch is a fake; globalThis.fetch is a tripwire.
 * Run: node --test contracts/order-engine/executor/runtime-config.test.mjs
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { buildRuntimeConfigRow, readKeeperVersion, publishRuntimeConfig, RUNTIME_CONFIG_TABLE } from "./runtime-config.js"
import { DCA_NO_PRICE_FILL_CAP_MAX_USD, DCA_FAIL_OPEN_MAX_USD, resolveFailOpenMaxUsd } from "./order-floor.js"

let realNetworkCalls = 0
const originalFetch = globalThis.fetch
before(() => {
  globalThis.fetch = async () => {
    realNetworkCalls++
    throw new Error("runtime-config.test.mjs: real network call attempted")
  }
})
after(() => {
  globalThis.fetch = originalFetch
  assert.equal(realNetworkCalls, 0)
})

const NOW_ISO = "2026-10-11T00:00:00.000Z"
const ROW = { chain_id: 8453, no_price_fill_cap_usd: 250, keeper_version: "teraswap-order-executor@1.0.0", updated_at: NOW_ISO }

function fakeSupabase(responder) {
  const fn = async (path, options) => {
    fn.calls.push({ path, options })
    const r = responder(path, options)
    if (r instanceof Error) throw r
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.body ?? "" }
  }
  fn.calls = []
  return fn
}
function collectLog() {
  const lines = []
  const log = (m) => lines.push(m)
  log.lines = lines
  return log
}

describe("1. buildRuntimeConfigRow + readKeeperVersion", () => {
  test("valid input ⇒ the four columns, typed", () => {
    const r = buildRuntimeConfigRow({ chainId: "8453", noPriceFillCapUsd: 250, keeperVersion: " teraswap-order-executor@1.0.0 ", nowIso: NOW_ISO })
    assert.equal(r.ok, true)
    assert.deepEqual(r.row, ROW)
  })
  test("invalid chain / cap / version / timestamp ⇒ ok:false with a reason, never a throw", () => {
    assert.equal(buildRuntimeConfigRow({ chainId: 0, noPriceFillCapUsd: 250, keeperVersion: "v", nowIso: NOW_ISO }).ok, false)
    assert.equal(buildRuntimeConfigRow({ chainId: "x", noPriceFillCapUsd: 250, keeperVersion: "v", nowIso: NOW_ISO }).ok, false)
    assert.equal(buildRuntimeConfigRow({ chainId: 8453, noPriceFillCapUsd: -1, keeperVersion: "v", nowIso: NOW_ISO }).ok, false)
    assert.equal(buildRuntimeConfigRow({ chainId: 8453, noPriceFillCapUsd: NaN, keeperVersion: "v", nowIso: NOW_ISO }).ok, false)
    assert.equal(buildRuntimeConfigRow({ chainId: 8453, noPriceFillCapUsd: 250, keeperVersion: "  ", nowIso: NOW_ISO }).ok, false)
    assert.equal(buildRuntimeConfigRow({ chainId: 8453, noPriceFillCapUsd: 250, keeperVersion: "v", nowIso: "not-a-date" }).ok, false)
    assert.equal(buildRuntimeConfigRow({ chainId: 8453, noPriceFillCapUsd: 0, keeperVersion: "v", nowIso: NOW_ISO }).ok, true, "a 0 cap (never fill on one source) is valid")
  })
  test("keeper version: KEEPER_VERSION env wins; else package.json name@version; else marked unknown", () => {
    assert.equal(readKeeperVersion({ env: { KEEPER_VERSION: " 2026.10.11-abc " }, readFile: () => { throw new Error("must not read") } }), "2026.10.11-abc")
    assert.equal(readKeeperVersion({ env: {}, readFile: () => JSON.stringify({ name: "teraswap-order-executor", version: "1.0.0" }) }), "teraswap-order-executor@1.0.0")
    assert.equal(readKeeperVersion({ env: {}, readFile: () => "{{not json" }), "teraswap-order-executor@unknown")
    const real = readKeeperVersion({ env: {} })
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
    assert.equal(real, `${pkg.name}@${pkg.version}`, "default reader reads the executor's own package.json")
  })
})

describe("2. publishRuntimeConfig — upsert via the keeper's service client, never fatal", () => {
  test("happy path: POST keeper_runtime_config?on_conflict=chain_id with merge-duplicates and the row as body", async () => {
    const sb = fakeSupabase(() => ({ ok: true, status: 201 }))
    const log = collectLog()
    const r = await publishRuntimeConfig({ supabaseFetch: sb, row: ROW, log })
    assert.deepEqual(r, { ok: true, status: 201, reason: "published", missingTable: false })
    assert.equal(sb.calls.length, 1)
    assert.equal(sb.calls[0].path, `${RUNTIME_CONFIG_TABLE}?on_conflict=chain_id`)
    assert.equal(sb.calls[0].options.method, "POST")
    assert.match(sb.calls[0].options.headers.Prefer, /resolution=merge-duplicates/)
    assert.deepEqual(JSON.parse(sb.calls[0].options.body), ROW)
    assert.match(log.lines[0], /published chain 8453 no_price_fill_cap_usd=250 keeper_version=teraswap-order-executor@1\.0\.0/)
  })
  test("MISSING TABLE (404 / PGRST205) is tolerated: logged with the 28b-migration hint, ok:false, no throw", async () => {
    for (const resp of [{ ok: false, status: 404, body: "" }, { ok: false, status: 400, body: '{"code":"PGRST205","message":"Could not find the table public.keeper_runtime_config in the schema cache"}' }]) {
      const log = collectLog()
      const r = await publishRuntimeConfig({ supabaseFetch: fakeSupabase(() => resp), row: ROW, log })
      assert.equal(r.ok, false)
      assert.equal(r.missingTable, true)
      assert.match(log.lines[0], /non-fatal/)
      assert.match(log.lines[0], /28b migration creates it/)
    }
  })
  test("other HTTP failure ⇒ logged with status + body, ok:false, missingTable:false", async () => {
    const log = collectLog()
    const r = await publishRuntimeConfig({ supabaseFetch: fakeSupabase(() => ({ ok: false, status: 503, body: "upstream" })), row: ROW, log })
    assert.deepEqual(r, { ok: false, status: 503, reason: "HTTP 503 upstream", missingTable: false })
    assert.match(log.lines[0], /WARNING: keeper_runtime_config publish failed \(non-fatal\): HTTP 503 upstream/)
  })
  test("a THROWN fetch (DNS, timeout) is caught, logged, returned — never propagates", async () => {
    const log = collectLog()
    const r = await publishRuntimeConfig({ supabaseFetch: fakeSupabase(() => new Error("getaddrinfo ENOTFOUND")), row: ROW, log })
    assert.equal(r.ok, false)
    assert.match(r.reason, /threw: getaddrinfo ENOTFOUND/)
    assert.match(log.lines[0], /threw \(non-fatal\)/)
  })
  test("no row / no client ⇒ skipped, logged, no call made", async () => {
    const sb = fakeSupabase(() => ({ ok: true }))
    const log = collectLog()
    assert.equal((await publishRuntimeConfig({ supabaseFetch: sb, row: null, log })).ok, false)
    assert.equal((await publishRuntimeConfig({ supabaseFetch: undefined, row: ROW, log })).ok, false)
    assert.equal(sb.calls.length, 0)
    assert.equal(log.lines.length, 2)
  })
})

describe("hard ceiling DCA_NO_PRICE_FILL_CAP_MAX_USD — clamp BOTH directions", () => {
  test("ceiling = 250 = DCA_FAIL_OPEN_MAX_USD (the literal 28b pins by regex AND value)", () => {
    assert.equal(DCA_NO_PRICE_FILL_CAP_MAX_USD, 250)
    assert.equal(DCA_FAIL_OPEN_MAX_USD, DCA_NO_PRICE_FILL_CAP_MAX_USD)
    const src = readFileSync(new URL("./order-floor.js", import.meta.url), "utf-8")
    const m = src.match(/export const DCA_FAIL_OPEN_MAX_USD\s*=\s*(\d[\d_]*)/)
    assert.ok(m, "28b's source-regex pin must keep matching a numeric literal")
    assert.equal(Number(m[1].replace(/_/g, "")), DCA_NO_PRICE_FILL_CAP_MAX_USD)
    assert.match(src, /export const DCA_NO_PRICE_FILL_CAP_MAX_USD = 250\b/)
  })
  test("ABOVE the ceiling ⇒ the ceiling, clamped:true, loud reason", () => {
    const r = resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "1000" })
    assert.equal(r.value, 250)
    assert.equal(r.clamped, true)
    assert.equal(r.source, "env-clamped-ceiling")
    assert.match(r.reason, /ABOVE the hard ceiling \$250 \(DCA_NO_PRICE_FILL_CAP_MAX_USD\)/)
    assert.equal(resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "250.01" }).value, 250)
    assert.equal(resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "999999999" }).value, 250)
  })
  test("BELOW the ceiling ⇒ the env value, clamped:false (and exactly AT the ceiling is not a clamp)", () => {
    const r = resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "100" })
    assert.deepEqual({ value: r.value, clamped: r.clamped, source: r.source }, { value: 100, clamped: false, source: "env" })
    const at = resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "250" })
    assert.deepEqual({ value: at.value, clamped: at.clamped }, { value: 250, clamped: false })
    assert.deepEqual({ value: resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "0" }).value, clamped: resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "0" }).clamped }, { value: 0, clamped: false })
  })
  test("negative ⇒ 0 (clamped); unset / junk ⇒ default 250 (not clamped)", () => {
    assert.deepEqual({ value: resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "-5" }).value, clamped: resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "-5" }).clamped }, { value: 0, clamped: true })
    assert.deepEqual({ value: resolveFailOpenMaxUsd({}).value, clamped: resolveFailOpenMaxUsd({}).clamped, source: resolveFailOpenMaxUsd({}).source }, { value: 250, clamped: false, source: "default" })
    assert.equal(resolveFailOpenMaxUsd({ DCA_FAIL_OPEN_MAX_USD: "banana" }).value, 250)
  })
})

describe("3. executor.js boot wiring (source-structure; executor.js auto-runs main())", () => {
  const src = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")
  const main = src.slice(src.indexOf("async function main() {"))
  test("the clamped cap is resolved and logged, LOUD when clamped, before the health server starts", () => {
    const at = main.indexOf("const capResolution = resolveFailOpenMaxUsd()")
    assert.notEqual(at, -1, "main() must resolve the cap through resolveFailOpenMaxUsd")
    assert.ok(at < main.indexOf("startHealthServer()"), "…before startHealthServer()")
    assert.match(main, /if \(capResolution\.clamped\) \{\s*console\.warn\(/, "a clamp must be a console.warn, not only a log line")
    assert.match(main, /No-price fill cap: \$\$\{capResolution\.value\}/)
  })
  test("the row is published through the keeper's own supabaseFetch inside try/catch (never fatal)", () => {
    const block = main.slice(main.indexOf("const capResolution"), main.indexOf("startHealthServer()"))
    assert.match(block, /try \{[\s\S]*publishRuntimeConfig\(\{ supabaseFetch, row: [\s\S]*\}\)[\s\S]*\} catch/)
    assert.match(block, /buildRuntimeConfigRow\(\{ chainId: CHAIN_ID, noPriceFillCapUsd: capResolution\.value, keeperVersion: readKeeperVersion\(\)/)
    assert.ok(!/process\.exit/.test(block), "the publish block must never exit the process")
  })
})
