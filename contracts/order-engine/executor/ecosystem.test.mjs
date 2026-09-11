/**
 * ecosystem.test.mjs — [FIX-KEEPER-MULTICHAIN-INSTANCE-IDENTITY] two pm2 apps, disjoint env.
 *
 * `teraswap-executor` (Base) and `teraswap-keeper-arbitrum` (Arbitrum One) run from the same
 * directory. Everything that makes one process THAT chain's keeper — chain id, RPC, executor
 * address, KMS key, Supabase key — lives in each app's OWN env file (selected by
 * EXECUTOR_ENV_FILE, see env.js), never in this config: a value typed here would be shared by
 * construction, and a secret typed here would be committed. The config may only carry what
 * must DIFFER per app on one host (ports, log files, env-file name) plus NODE_ENV.
 *
 * Run: node --test contracts/order-engine/executor/ecosystem.test.mjs
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { apps } = require("./ecosystem.config.cjs")

const BASE = "teraswap-executor"
const ARBITRUM = "teraswap-keeper-arbitrum"
const byName = Object.fromEntries(apps.map((a) => [a.name, a]))

// The ONLY env keys the config may set. Anything identity-bearing is deliberately absent.
const ALLOWED_ENV_KEYS = new Set(["NODE_ENV", "METRICS_PORT", "HEALTH_PORT", "EXECUTOR_ENV_FILE"])
// The ONLY env key whose VALUE may be equal across apps.
const SHARED_OK = new Set(["NODE_ENV"])

describe("ecosystem.config.cjs — two apps, disjoint env, nothing identity-bearing typed in", () => {
  test("exactly two apps with the expected names", () => {
    assert.deepEqual(apps.map((a) => a.name).sort(), [ARBITRUM, BASE].sort())
  })

  test("the Base app is unchanged: same name, script, ports and log paths as before", () => {
    const base = byName[BASE]
    assert.equal(base.script, "executor.js")
    assert.equal(base.instances, 1)
    assert.equal(base.env.NODE_ENV, "production")
    assert.equal(base.env.METRICS_PORT, "9090")
    assert.equal(base.error_file, "./logs/error.log")
    assert.equal(base.out_file, "./logs/out.log")
    assert.equal(base.env.EXECUTOR_ENV_FILE, ".env.executor", "Base pins its default explicitly — [FIX-KEEPER-ENV-PIN-AND-RUNBOOK]")
  })

  test("[FIX-KEEPER-ENV-PIN-AND-RUNBOOK] both apps pin distinct, explicit env files — neither relies on env.js's fallback", () => {
    const base = byName[BASE]
    const arb = byName[ARBITRUM]
    assert.ok(base.env.EXECUTOR_ENV_FILE, "Base must pin EXECUTOR_ENV_FILE explicitly, not rely on the default")
    assert.ok(arb.env.EXECUTOR_ENV_FILE, "Arbitrum must pin EXECUTOR_ENV_FILE explicitly")
    assert.notEqual(
      base.env.EXECUTOR_ENV_FILE,
      arb.env.EXECUTOR_ENV_FILE,
      "a shell export of EXECUTOR_ENV_FILE plus --update-env could otherwise turn one app into the other's keeper"
    )
  })

  test("the Arbitrum app runs the same script, single instance, from its own env file", () => {
    const arb = byName[ARBITRUM]
    assert.equal(arb.script, "executor.js")
    assert.equal(arb.instances, 1, "one instance per chain — a second would double-execute")
    assert.equal(arb.env.EXECUTOR_ENV_FILE, ".env.executor.arbitrum")
  })

  test("own pm2 log paths — no app writes into another's log", () => {
    const files = apps.flatMap((a) => [a.error_file, a.out_file])
    assert.equal(new Set(files).size, files.length, `log paths collide: ${files.join(", ")}`)
    for (const f of files) assert.ok(f && f.startsWith("./logs/"), `log path outside ./logs/: ${f}`)
  })

  test("listening ports differ — two processes on one host cannot share a port", () => {
    const base = byName[BASE]
    const arb = byName[ARBITRUM]
    assert.notEqual(arb.env.METRICS_PORT, base.env.METRICS_PORT)
    assert.ok(arb.env.HEALTH_PORT, "the Arbitrum app must pin its own HEALTH_PORT (Base's lives in .env.executor)")
    assert.notEqual(arb.env.HEALTH_PORT, "3001", "3001 is the Base health port per EC2-EXECUTOR-HOST.md")
  })

  test("no env key beyond the allow-list, and no value shared between apps except NODE_ENV", () => {
    for (const a of apps) {
      for (const k of Object.keys(a.env)) assert.ok(ALLOWED_ENV_KEYS.has(k), `${a.name} sets ${k} — identity-bearing config belongs in the env file`)
    }
    const base = byName[BASE].env
    const arb = byName[ARBITRUM].env
    for (const k of Object.keys(arb)) {
      if (k in base && !SHARED_OK.has(k)) assert.notEqual(arb[k], base[k], `${k} is shared between apps`)
    }
  })

  test("no secret, key id, ARN or address anywhere in the config", () => {
    const text = JSON.stringify(apps)
    assert.doesNotMatch(text, /0x[0-9a-fA-F]{40}/, "an address is typed into the config")
    assert.doesNotMatch(text, /arn:aws/i, "a KMS ARN is typed into the config")
    assert.doesNotMatch(text, /sb_secret|service_role|eyJ[A-Za-z0-9_-]{10,}/, "a Supabase key is typed into the config")
    assert.doesNotMatch(text, /https?:\/\//, "an RPC/Supabase URL is typed into the config")
    for (const k of ["CHAIN_ID", "RPC_URL", "KMS_KEY_ID", "KMS_REGION", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ORDER_EXECUTOR_ADDRESS", "ORDER_EXECUTOR_V3_ADDRESS", "EXECUTOR_PRIVATE_KEY", "ALLOW_PLAINTEXT_KEY"]) {
      assert.ok(!text.includes(k), `${k} must not appear in the config`)
    }
  })
})
