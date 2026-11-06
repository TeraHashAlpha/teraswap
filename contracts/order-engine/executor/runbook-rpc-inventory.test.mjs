// [A71 L-6] docs/Runbooks/EXECUTOR-OPERATIONS.md § 7 step 1 — the RPC-key inventory — must find every
// consumer of a provider host in the keeper env files, in every assignment shape, and never print a key.
//
// The audited command only matched `VAR="scheme://…` at column 0, so `RPC_URL = https://…`,
// `  export VAR='wss://…'` and a URL inside a list were invisible — the very "grep missed a consumer"
// failure of INC-2026-10-30-001. This runs the runbook's OWN bash block (extracted verbatim) with
// `bash` on fixture files that carry the fixture key TESTKEY only.
//
// Run: node --test contracts/order-engine/executor/runbook-rpc-inventory.test.mjs

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const RUNBOOK = new URL("../../../docs/Runbooks/EXECUTOR-OPERATIONS.md", import.meta.url)
const KEY = "TESTKEY"
const dir = mkdtempSync(join(tmpdir(), "rpc-inventory-"))
after(() => rmSync(dir, { recursive: true, force: true }))

/** The first ```bash block under "1. **Inventory every consumer by hostname**", dedented. */
function inventoryBlock() {
  const lines = readFileSync(RUNBOOK, "utf-8").split("\n")
  const step = lines.findIndex((l) => l.includes("1. **Inventory every consumer by hostname**"))
  const open = lines.findIndex((l, i) => i > step && l.trim() === "```bash")
  const close = lines.findIndex((l, i) => i > open && l.trim() === "```")
  assert.ok(step >= 0 && open > step && close > open, "runbook § 7 step 1 bash block not found")
  const indent = lines[open].indexOf("```")
  return lines.slice(open + 1, close).map((l) => l.slice(indent)).join("\n")
}

writeFileSync(
  join(dir, ".env.executor"),
  [
    `RPC_URL="https://base-mainnet.g.alchemy.com/v2/${KEY}"`,
    "SUPABASE_URL=https://example.supabase.co",
    "",
  ].join("\n"),
)
writeFileSync(
  join(dir, ".env.executor.arbitrum"),
  [
    `RPC_URL = https://arb-mainnet.g.alchemy.com/v2/${KEY}`,
    `  export FALLBACK_RPC_URL='wss://user:${KEY}@base-mainnet.g.alchemy.com/ws'`,
    `RPC_URLS=https://rpc.example.org/x,https://eth-mainnet.g.alchemy.com/v2/${KEY}`,
    `# OLD_RPC_URL=https://base-mainnet.g.alchemy.com/v2/${KEY}`,
    "",
  ].join("\n"),
)

test("[A71 L-6] § 7 step 1 lists every g.alchemy.com consumer in every shape, and never prints the key", () => {
  const script = inventoryBlock()
  assert.ok(script.includes("<provider-host>"), "the runbook block takes the provider host as a placeholder")
  const runnable = script
    .split("\n")
    .filter((l) => !/^cd contracts\/order-engine\/executor\s*$/.test(l))
    .join("\n")
    .replaceAll("<provider-host>", "g.alchemy.com")
  const r = spawnSync("bash", ["-c", runnable], { cwd: dir, encoding: "utf-8" })
  assert.equal(r.stderr, "")
  const out = r.stdout
  // (a) the assignment shapes, as "file  VAR  scheme://host"
  for (const row of [
    ".env.executor  RPC_URL  https://base-mainnet.g.alchemy.com",
    ".env.executor.arbitrum  RPC_URL  https://arb-mainnet.g.alchemy.com",
    ".env.executor.arbitrum  FALLBACK_RPC_URL  wss://base-mainnet.g.alchemy.com",
  ]) {
    assert.ok(out.split("\n").includes(row), `missing "${row}" in:\n${out}`)
  }
  // (b) by hostname, any shape: the URL list and the commented-out line are listed by file:line
  assert.ok(out.split("\n").includes(".env.executor.arbitrum:3  RPC_URLS"), out)
  assert.ok(out.split("\n").some((l) => l.startsWith(".env.executor.arbitrum:4 ")), out)
  // never a key, a userinfo, a path; never another provider
  assert.ok(!out.includes(KEY), `key printed:\n${out}`)
  assert.ok(!out.includes("user"), out)
  assert.ok(!out.includes("/v2"), out)
  assert.ok(!out.includes("supabase"), out)
})

// ─── [A71b S-4] ──────────────────────────────────────────────────────────────────────────────────
// Hostnames are case-insensitive, and an env file may spell one in capitals (`BASE-MAINNET.G.ALCHEMY.COM`,
// pasted from a dashboard). The audited block used `grep -F`, which is case-sensitive: that consumer
// was invisible — the same "grep missed a consumer" failure as INC-2026-10-30-001 — and so was a
// run with the host typed in capitals against lower-case files.
function runInventory(cwd, host) {
  const runnable = inventoryBlock()
    .split("\n")
    .filter((l) => !/^cd contracts\/order-engine\/executor\s*$/.test(l))
    .join("\n")
    .replaceAll("<provider-host>", host)
  const r = spawnSync("bash", ["-c", runnable], { cwd, encoding: "utf-8" })
  assert.equal(r.stderr, "")
  return r.stdout.split("\n")
}

const upperDir = mkdtempSync(join(tmpdir(), "rpc-inventory-upper-"))
after(() => rmSync(upperDir, { recursive: true, force: true }))
writeFileSync(
  join(upperDir, ".env.executor"),
  [
    `RPC_URL="https://BASE-MAINNET.G.ALCHEMY.COM/v2/${KEY}"`,
    `FALLBACK_RPC_URL=wss://Arb-Mainnet.g.Alchemy.com/ws/${KEY}`,
    `# OLD_RPC_URL=HTTPS://ETH-MAINNET.G.ALCHEMY.COM/v2/${KEY}`,
    "SUPABASE_URL=https://example.supabase.co",
    "",
  ].join("\n"),
)

test("[A71b S-4] a host spelled in capitals in the env file is listed (lower-case HOST), and never prints the key", () => {
  const out = runInventory(upperDir, "g.alchemy.com")
  for (const row of [
    ".env.executor  RPC_URL  https://BASE-MAINNET.G.ALCHEMY.COM",
    ".env.executor  FALLBACK_RPC_URL  wss://Arb-Mainnet.g.Alchemy.com",
  ]) {
    assert.ok(out.includes(row), `missing "${row}" in:\n${out.join("\n")}`)
  }
  assert.ok(out.includes(".env.executor:1  RPC_URL"), "(b) lists the line by hostname")
  assert.ok(out.some((l) => l.startsWith(".env.executor:3 ")), "(b) lists the commented-out upper-case line")
  const all = out.join("\n")
  assert.ok(!all.includes(KEY), `key printed:\n${all}`)
  assert.ok(!all.toLowerCase().includes("/v2"), all)
  assert.ok(!all.includes("supabase"), all)
})

test("[A71b S-4] HOST typed in capitals finds lower-case files too", () => {
  const out = runInventory(dir, "G.ALCHEMY.COM")
  assert.ok(out.includes(".env.executor  RPC_URL  https://base-mainnet.g.alchemy.com"), out.join("\n"))
  assert.ok(out.includes(".env.executor.arbitrum:3  RPC_URLS"), out.join("\n"))
  assert.ok(!out.join("\n").includes(KEY))
})
