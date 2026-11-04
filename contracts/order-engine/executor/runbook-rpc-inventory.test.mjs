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
