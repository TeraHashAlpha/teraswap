// [A93 R2-1] The configured-secret list (redact.js): which names, how it is built, what it never says.
//   - SECRET_ENV_NAMES covers every secret-bearing variable the keeper and the CLIs read (a scan of their sources), and
//     names nothing they do not read (the AWS_* names are read by @aws-sdk/client-kms, which kms-signer.js imports);
//   - the list is built lazily, once, and building it prints nothing: no value, no name;
//   - the mask is the same for every secret, so an output never says which variable matched;
//   - the floor (12 characters) and a private key with or without its `0x`.
//
// Run: node --test contracts/order-engine/executor/redact-a93-r2-1-names.test.mjs

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const HEALTH = "A93namesHealthToken01" // DUMMY values
const ELEVEN = "A93elevenXX" // 11 characters: below the floor
const TWELVE = "A93twelveXXX" // 12 characters: a secret
const PRIVATE_KEY = `0x${"a93b".repeat(16)}`
const LATE = "A93setAfterTheFirstScrub"

process.env.HEALTH_TOKEN = HEALTH
process.env.COINGECKO_API_KEY = ELEVEN
process.env.AWS_ACCESS_KEY_ID = TWELVE
process.env.EXECUTOR_PRIVATE_KEY = PRIVATE_KEY
delete process.env.AWS_SESSION_TOKEN

const { SECRET_ENV_NAMES, SECRET_MASK, SECRET_MIN_LENGTH, redactSecretLiterals } = await import("./redact.js")

describe("[A93 R2-1] building the list", () => {
  test("the first scrub builds the list and writes nothing: no value, no name, to no stream", () => {
    const calls = []
    const spies = ["log", "info", "warn", "error", "debug", "trace"].map((m) => mock.method(console, m, (...a) => calls.push([m, a])))
    const writes = [process.stdout, process.stderr].map((s) => mock.method(s, "write", (...a) => (calls.push(["write", a]), true)))
    let out
    try {
      out = redactSecretLiterals(`health ${HEALTH} key ${PRIVATE_KEY}`)
    } finally {
      for (const s of [...spies, ...writes]) s.mock.restore()
    }
    assert.deepEqual(calls, [])
    assert.equal(out, `health ${SECRET_MASK} key ${SECRET_MASK}`)
  })

  test("built once: a value set after the first scrub is not read (env.js loads .env.executor before anything is redacted)", () => {
    process.env.TELEGRAM_BOT_TOKEN = LATE
    try {
      assert.equal(redactSecretLiterals(`token ${LATE}`), `token ${LATE}`)
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN
    }
  })

  test("one mask for every secret: an output never says which variable matched", () => {
    assert.equal(redactSecretLiterals(`${HEALTH}|${TWELVE}|${PRIVATE_KEY.slice(2)}`), [SECRET_MASK, SECRET_MASK, SECRET_MASK].join("|"))
    assert.equal(redactSecretLiterals(`${HEALTH}`, { html: true }), "&lt;redacted&gt;")
  })

  test(`the floor: ${SECRET_MIN_LENGTH} characters is a secret, ${SECRET_MIN_LENGTH - 1} is not`, () => {
    assert.equal(SECRET_MIN_LENGTH, 12)
    assert.equal(redactSecretLiterals(`a ${TWELVE} b ${ELEVEN} c`), `a ${SECRET_MASK} b ${ELEVEN} c`)
  })

  test("a private key goes with and without its 0x, in either case", () => {
    const bare = PRIVATE_KEY.slice(2)
    assert.equal(redactSecretLiterals(`k=${PRIVATE_KEY.toUpperCase().replace("0X", "0x")} raw=${bare.toUpperCase()}`), `k=${SECRET_MASK} raw=${SECRET_MASK}`)
  })
})

describe("[A93 R2-1] SECRET_ENV_NAMES", () => {
  // Read by the keeper or a CLI, named like a secret, and deliberately NOT in the list, each with its reason.
  const NOT_SECRET = {
    ALLOW_PLAINTEXT_KEY: "a yes/no switch",
    ALLOW_PLAINTEXT_KEY_MAINNET: "a yes/no switch",
    FEE_COLLECTOR_ADDRESS: "a public contract address, printed on purpose",
    ORDER_EXECUTOR_ADDRESS: "a public contract address, printed on purpose",
    ORDER_EXECUTOR_V3_ADDRESS: "a public contract address, printed on purpose",
    KMS_KEY_ID: "an identifier: it signs nothing without the AWS credentials, which are in the list",
  }
  const SECRET_LIKE = /URL|KEY|TOKEN|SECRET|PASSW|ADDR|AUTH|CRED|BEARER/

  /** Every environment variable a keeper source (not a test, not a fixture) reads. */
  function namesRead() {
    const names = new Set()
    for (const file of readdirSync(HERE)) {
      if (!/\.(?:js|mjs|cjs)$/.test(file) || /\.(?:test|fixture)\.mjs$/.test(file)) continue
      const src = readFileSync(join(HERE, file), "utf8")
      for (const m of src.matchAll(/(?:process\.env|\benv)(?:\.([A-Z][A-Z0-9_]+)|\[["']([A-Z][A-Z0-9_]+)["']\])|requireEnv\(["']([A-Z][A-Z0-9_]+)["']\)/g)) {
        names.add(m[1] ?? m[2] ?? m[3])
      }
    }
    return names
  }

  test("covers every secret-like variable the keeper and the CLIs read", () => {
    const read = namesRead()
    assert.ok(read.has("RPC_URL") && read.has("SUPABASE_SERVICE_ROLE_KEY") && read.has("BACKFILL_RPC_URL"), "scan sanity")
    const missing = [...read].filter((n) => SECRET_LIKE.test(n) && !SECRET_ENV_NAMES.includes(n) && !(n in NOT_SECRET))
    assert.deepEqual(missing, [], "a secret-like variable is read but not scrubbed: add it to SECRET_ENV_NAMES, or to NOT_SECRET with a reason")
  })

  test("names only variables something reads (AWS_*: the KMS SDK kms-signer.js imports)", () => {
    const read = namesRead()
    assert.match(readFileSync(join(HERE, "kms-signer.js"), "utf8"), /import\("@aws-sdk\/client-kms"\)/)
    const unread = SECRET_ENV_NAMES.filter((n) => !read.has(n) && !n.startsWith("AWS_"))
    assert.deepEqual(unread, [])
    assert.ok(Object.isFrozen(SECRET_ENV_NAMES))
  })
})
