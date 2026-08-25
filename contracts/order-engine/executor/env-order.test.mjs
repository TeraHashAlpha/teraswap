/**
 * env-order.test.mjs — proof of DETERMINISTIC .env.executor load order [KEEPER-ENV-ORDER].
 *
 * The defect: executor.js loaded .env.executor in its module BODY — i.e. AFTER its
 * whole import graph was evaluated — so any first-party module reading process.env
 * at module scope (alert.js's CHAIN_ID, retry-policy's caps, deviation-guard's
 * thresholds) silently kept its compile-time default. Measured in production: a
 * CHAIN_ID=8453 keeper stamping Telegram alerts "Chain: 1".
 *
 * The fix under test: env.js performs the load in ITS module body and is the FIRST
 * import of every entrypoint in this directory, so the file is loaded before any
 * other module evaluates.
 *
 * Run: node --test contracts/order-engine/executor/env-order.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const EXECUTOR_DIR = dirname(fileURLToPath(import.meta.url))
const href = (file) => pathToFileURL(join(EXECUTOR_DIR, file)).href

// ─── loadEnv parsing behavior (moved verbatim from executor.js) ─────────────

test("loadEnv: parses KEY=VALUE, skips comments/blanks/no-'=' lines, never overrides pre-set vars", async () => {
  const { loadEnv } = await import("./env.js")
  const dir = mkdtempSync(join(tmpdir(), "teraswap-envorder-"))
  const file = join(dir, ".env.executor")
  writeFileSync(
    file,
    [
      "# comment line",
      "",
      "ENVORDER_TEST_A=hello",
      "  ENVORDER_TEST_B = spaced ",
      "no-equals-sign line",
      "ENVORDER_TEST_PRESET=from-file",
    ].join("\n"),
  )
  const saved = {}
  for (const k of ["ENVORDER_TEST_A", "ENVORDER_TEST_B", "ENVORDER_TEST_PRESET"]) {
    saved[k] = process.env[k]
  }
  try {
    process.env.ENVORDER_TEST_PRESET = "from-shell"
    delete process.env.ENVORDER_TEST_A
    delete process.env.ENVORDER_TEST_B
    loadEnv(file)
    assert.equal(process.env.ENVORDER_TEST_A, "hello")
    assert.equal(process.env.ENVORDER_TEST_B, "spaced", "keys and values are trimmed")
    assert.equal(process.env.ENVORDER_TEST_PRESET, "from-shell", "shell env always wins over the file")
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadEnv: a missing file warns and returns — never throws", async () => {
  const { loadEnv } = await import("./env.js")
  assert.doesNotThrow(() => loadEnv(join(tmpdir(), "definitely-not-here", ".env.executor")))
})

// ─── The headline defect: module-scope readers see the .env.executor value ──
// A child process runs with cwd = a temp dir whose .env.executor sets CHAIN_ID=8453
// plus overrides for retry-policy and deviation-guard. The child imports env.js
// FIRST (exactly as the entrypoints now do), then first-party modules that read
// process.env AT MODULE SCOPE. Every reader must see the file's value, not "1".

function runChild(script, cwd) {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    encoding: "utf-8",
    // Clean env: nothing inherited that could mask the file (loadEnv never
    // overrides a pre-set var). PATH/HOME kept so node itself runs normally.
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  })
  assert.equal(res.status, 0, `child exited ${res.status}: ${res.stderr}`)
  return res
}

const CHILD_SCRIPT = [
  `import ${JSON.stringify(href("env.js"))}`,
  `import { MAX_CYCLE_FAILURES, RETRY_BACKOFF_BASE_MS } from ${JSON.stringify(href("retry-policy.js"))}`,
  `import { DCA_DEVIATION_THRESHOLD } from ${JSON.stringify(href("deviation-guard.js"))}`,
  // This very line IS "a module that reads CHAIN_ID at module scope".
  `const chainAtModuleScope = process.env.CHAIN_ID || "1"`,
  `console.log(JSON.stringify({ chainAtModuleScope, MAX_CYCLE_FAILURES, RETRY_BACKOFF_BASE_MS, DCA_DEVIATION_THRESHOLD }))`,
].join("\n")

test("a module reading CHAIN_ID at module scope sees the .env.executor value, not '1'", () => {
  const dir = mkdtempSync(join(tmpdir(), "teraswap-envorder-"))
  try {
    writeFileSync(
      join(dir, ".env.executor"),
      [
        "CHAIN_ID=8453",
        "MAX_CYCLE_FAILURES=5",
        "RETRY_BACKOFF_BASE_MS=45000",
        "DCA_DEVIATION_THRESHOLD=0.02",
      ].join("\n"),
    )
    const res = runChild(CHILD_SCRIPT, dir)
    const out = JSON.parse(res.stdout)
    assert.equal(out.chainAtModuleScope, "8453", "module-scope CHAIN_ID read must see the file, not the default")
    assert.equal(out.MAX_CYCLE_FAILURES, 5, "retry-policy module-scope cap override must resolve")
    assert.equal(out.RETRY_BACKOFF_BASE_MS, 45000, "retry-policy module-scope backoff override must resolve")
    assert.equal(out.DCA_DEVIATION_THRESHOLD, 0.02, "deviation-guard module-scope threshold override must resolve")
    assert.doesNotMatch(res.stderr, /WARNING: Could not load/, "file exists — no load warning")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no .env.executor in cwd: env.js warns (visibly) and defaults still hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "teraswap-envorder-"))
  try {
    const res = runChild(CHILD_SCRIPT, dir)
    const parsed = JSON.parse(res.stdout)
    assert.equal(parsed.chainAtModuleScope, "1", "defaults hold when the file is absent")
    assert.equal(parsed.MAX_CYCLE_FAILURES, 8)
    assert.match(res.stderr, /WARNING: Could not load/, "the missing file is surfaced, never silent")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── alert.js: the Chain line must be read at SEND time, not import time ────

test("sendTelegramAlert stamps the CURRENT process.env.CHAIN_ID, not the value at import", async () => {
  const { sendTelegramAlert } = await import("./alert.js")
  const saved = {
    CHAIN_ID: process.env.CHAIN_ID,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  }
  const realFetch = globalThis.fetch
  const sent = []
  try {
    // alert.js was imported ABOVE with CHAIN_ID unset — the buggy module-scope
    // capture would have frozen "1". Set the real chain only AFTER import.
    process.env.CHAIN_ID = "8453"
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.TELEGRAM_CHAT_ID = "test-chat"
    globalThis.fetch = async (url, opts) => {
      sent.push(JSON.parse(opts.body))
      return { ok: true }
    }
    await sendTelegramAlert("env-order probe")
    assert.equal(sent.length, 1, "alert must have been 'sent' to the stub")
    assert.match(sent[0].text, /Chain: 8453/, "Chain line must reflect the post-import CHAIN_ID")
    assert.doesNotMatch(sent[0].text, /Chain: 1\b/, "must not stamp the import-time default")
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

// ─── event-watcher.js: explorer base per chain, no silent etherscan fallback ─

test("explorerBase: known chains map to their own explorer; unknown chains map to null", async () => {
  const { explorerBase } = await import("./event-watcher.js")
  assert.equal(explorerBase("1"), "https://etherscan.io")
  assert.equal(explorerBase("11155111"), "https://sepolia.etherscan.io")
  assert.equal(explorerBase("8453"), "https://basescan.org")
  assert.equal(explorerBase("42161"), "https://arbiscan.io")
  // An unknown chain must NEVER silently fall back to etherscan.io — a tx link
  // pointing at another chain's explorer shows "not found" and reads as a lie.
  assert.equal(explorerBase("10"), null)
  assert.equal(explorerBase("999999"), null)
  assert.equal(explorerBase(undefined), null)
})

// ─── Entrypoint drift guard: ./env.js must stay the FIRST import ────────────

const ENTRYPOINTS = ["executor.js", "backfill-execution.mjs"]

test("every entrypoint's FIRST import statement is ./env.js", () => {
  for (const file of ENTRYPOINTS) {
    const src = readFileSync(join(EXECUTOR_DIR, file), "utf-8")
    const firstImport = src.match(/^import\s+.*$/m)
    assert.ok(firstImport, `${file}: has import statements`)
    assert.match(
      firstImport[0],
      /^import\s+"\.\/env\.js"/,
      `${file}: the first import must be ./env.js — a later position re-opens the ` +
        `evaluated-before-loadEnv window for every module imported above it`,
    )
  }
})

test("executor.js no longer loads .env.executor in its module body", () => {
  const src = readFileSync(join(EXECUTOR_DIR, "executor.js"), "utf-8")
  assert.doesNotMatch(src, /loadEnv\(join\(process\.cwd\(\)/, "the inline loadEnv call must be gone")
  assert.doesNotMatch(src, /^function loadEnv\(/m, "loadEnv now lives in env.js only")
})
