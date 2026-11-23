// [A93 R2-1] Seeded fuzz of the configured-secret scrub. Per seed: 1-6 random secrets of 12 to 200 characters (ASCII,
// URL delimiters, HTML and JSON specials included; no whitespace, an env value is trimmed), configured under random
// SECRET_ENV_NAMES — a URL name carries its secret percent-encoded in a path segment, a query value or the userinfo —
// in a fresh worker (the list is built once per process: redact-a93-fuzz.fixture.mjs). Then random error shapes with a
// secret in a random form (plain, percent-encoded wholly or in part, upper / lower / random case, HTML- or
// JSON-escaped, split by a line break) at a random place, through every sink (redactError on an Error, a string and a
// viem-shaped error, redactUrl, a CLI print, sendTelegramAlert escaped and raw, alertOps, the onCycleError alert).
// No secret may be readable in any output under any decoding an operator could apply by hand (the oracle in the
// fixture: percent, HTML, JSON, line breaks removed, any case).
//
// Seeds 1-12 x 60 cases here; A93_SEEDS=1-500 for a longer local run.
//
// Run: node --test contracts/order-engine/executor/redact-a93-r2-1-fuzz.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { Worker } from "node:worker_threads"

import { SECRET_ENV_NAMES } from "./redact.js"

const [FIRST, LAST] = (process.env.A93_SEEDS ?? "1-12").split("-").map(Number)
const CASES = 60
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~.+/=!*$@:%&<>\"'\\()[],;?#"
const URL_NAMES = new Set(["RPC_URL", "BACKFILL_RPC_URL", "FLASHBOTS_RPC_URL", "TERASWAP_API_URL", "VAULT_ADDR", "SUPABASE_URL"])

function rng(seed) {
  let x = (seed * 2654435761) >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

/** The seed's environment and the decoded secrets it configures. */
function seedEnv(seed) {
  const r = rng(seed)
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
  const secret = () => Array.from({ length: int(12, 200) }, () => CHARS[int(0, CHARS.length - 1)]).join("")
  const env = { TELEGRAM_CHAT_ID: "1", CHAIN_ID: "8453" }
  const secrets = []
  const names = [...SECRET_ENV_NAMES].sort(() => r() - 0.5).slice(0, int(1, 6))
  for (const name of names) {
    const s = secret()
    secrets.push(s)
    if (!URL_NAMES.has(name)) {
      env[name] = s
      continue
    }
    const at = int(0, 2)
    env[name] =
      at === 0 ? `https://rpc${seed}.example.org/v2/${encodeURIComponent(s)}`
      : at === 1 ? `https://rpc${seed}.example.org/v2?apikey=${encodeURIComponent(s)}&chain=base`
      : `https://ops:${encodeURIComponent(s)}@rpc${seed}.example.org/`
  }
  // sendTelegramAlert needs a token; when the seed did not configure one it is a fixed 9-character (never a secret) one.
  env.TELEGRAM_BOT_TOKEN ??= "TESTTOKEN"
  return { env, secrets }
}

function runSeed(seed) {
  const { env, secrets } = seedEnv(seed)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./redact-a93-fuzz.fixture.mjs", import.meta.url), { workerData: { seed, cases: CASES, secrets }, env })
    worker.once("message", resolve)
    worker.once("error", reject)
  })
}

describe(`[A93 R2-1] fuzz: seeds ${FIRST}-${LAST} x ${CASES} cases x 9 sinks, no configured secret readable in any output`, { concurrency: 4 }, () => {
  for (let seed = FIRST; seed <= LAST; seed++) {
    test(`seed ${seed}`, { timeout: 120_000 }, async () => {
      const { checked, failures, failureCount } = await runSeed(seed)
      assert.equal(checked, CASES * 9)
      assert.equal(failureCount, 0, JSON.stringify(failures, null, 1))
    })
  }
})
