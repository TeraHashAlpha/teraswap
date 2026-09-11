/**
 * boot-identity.test.mjs — [FIX-KEEPER-MULTICHAIN-INSTANCE-IDENTITY]
 *
 * The keeper is about to run as TWO processes on one host (Base 8453 + Arbitrum One 42161). Three
 * boot-time gaps made that unsafe, each pinned here:
 *
 *   1. `CHAIN_ID` defaulted to "1" (executor.js) — a process started without the variable silently
 *      became a MAINNET keeper. Now: missing / empty / unparseable ⇒ FATAL naming CHAIN_ID, exit 1,
 *      BEFORE any RPC or KMS call. (boot-config.js `parseChainIdEnv`, pure; plus the real boot.)
 *   2. chain-verify.js proved the executor's TYPE (ORDER_TYPEHASH) and CHAIN (eth_chainId) but never
 *      the INSTANCE: `whitelistedExecutors(<own signer>)` was never read, so the right contract with
 *      the WRONG KMS key booted green and reverted NotExecutor() on every fill. Now: after the signer
 *      address is derived, `whitelistedExecutors(signer)` must be `true` on EVERY configured
 *      executor, or the boot refuses. (chain-verify.js `verifyExecutorWhitelist`.)
 *   3. Every other identity-bearing variable (RPC_URL, SUPABASE_*, executor address, KMS_KEY_ID +
 *      KMS_REGION) must be named by the refusal when absent — never defaulted.
 *
 * NO LIVE NETWORK. Two doubles sit at the seams the keeper genuinely talks to — a JSON-RPC server
 * (`RPC_URL`) and a KMS endpoint (`AWS_ENDPOINT_URL_KMS`, honoured by the AWS SDK's own endpoint
 * resolution). No module is mocked: the real executor.js, chain-verify.js and kms-signer.js run.
 * The KMS double answers GetPublicKey with a DER SPKI for a PUBLIC test fixture key (Hardhat #0),
 * so the KMS-derived signer is a known address the whitelist read can be asserted against.
 *
 * Run: node --test contracts/order-engine/executor/boot-identity.test.mjs
 */

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { toFunctionSelector, encodeAbiParameters, hexToBytes } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import { parseChainIdEnv } from "./boot-config.js"
import {
  verifyExecutorWhitelist,
  ChainVerificationError,
  WHITELISTED_EXECUTORS_ABI,
  EXPECTED_ORDER_TYPEHASH_V2,
  EXPECTED_ORDER_TYPEHASH_V3,
} from "./chain-verify.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
// Hardhat's well-known account #0 key: a public test fixture, never used on any real chain. The
// KMS double publishes ITS public key, so the KMS-derived signer is deterministic.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const DEV_ACCOUNT = privateKeyToAccount(DEV_KEY)
const SIGNER = DEV_ACCOUNT.address // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const V2_ADDRESS = "0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130"
const V3_ADDRESS = "0x135B339902Ea4E0fB4CF059961dc8856bA1D2598"
const SOME_CODE = "0x60806040" + "00".repeat(64)

const SEL_ORDER_TYPEHASH = toFunctionSelector("ORDER_TYPEHASH()")
const SEL_WHITELISTED = toFunctionSelector("whitelistedExecutors(address)")
const BOOL_TRUE = encodeAbiParameters([{ type: "bool" }], [true])
const BOOL_FALSE = encodeAbiParameters([{ type: "bool" }], [false])

// ── 1. parseChainIdEnv — pure, no default, strict ────────────────────────────────────────────

describe("boot-config — parseChainIdEnv has NO default and refuses anything but a positive integer", () => {
  for (const [raw, why] of [
    [undefined, "missing"],
    ["", "empty"],
    ["   ", "whitespace-only"],
    ["8453abc", "junk suffix (parseInt would have accepted 8453)"],
    ["0x2105", "hex"],
    ["1.5", "fractional"],
    ["-1", "negative"],
    ["0", "zero"],
    ["NaN", "NaN"],
    ["1e3", "exponent"],
  ]) {
    test(`${why} → refused, naming CHAIN_ID`, () => {
      const r = parseChainIdEnv(raw)
      assert.equal(r.ok, false)
      assert.match(r.reason, /CHAIN_ID/)
      assert.equal(r.chainId, undefined)
    })
  }

  for (const [raw, expected] of [
    ["1", 1],
    ["8453", 8453],
    ["42161", 42161],
    [" 42161 ", 42161],
    ["11155111", 11155111],
  ]) {
    test(`${JSON.stringify(raw)} → ${expected}`, () => {
      const r = parseChainIdEnv(raw)
      assert.deepEqual(r, { ok: true, chainId: expected })
    })
  }
})

// ── 2. verifyExecutorWhitelist — injected provider ───────────────────────────────────────────

function fakeProvider(answer) {
  const calls = []
  return {
    calls,
    getChainId: async () => 1,
    getCode: async () => SOME_CODE,
    readContract(args) {
      calls.push({ address: args.address, functionName: args.functionName, args: args.args })
      const v = typeof answer === "function" ? answer(args) : answer
      if (v instanceof Error) return Promise.reject(v)
      return Promise.resolve(v)
    },
  }
}

const FAST = { sleep: async () => {}, retryDelayMs: 0, timeoutMs: 30 }
const v2 = { label: "ORDER_EXECUTOR_ADDRESS (v2)", address: V2_ADDRESS }
const v3 = { label: "ORDER_EXECUTOR_V3_ADDRESS (v3)", address: V3_ADDRESS }

async function refuses(promise) {
  const err = await promise.then(
    () => null,
    (e) => e,
  )
  assert.ok(err, "expected verifyExecutorWhitelist to REFUSE, but it resolved")
  assert.ok(err instanceof ChainVerificationError, `expected ChainVerificationError, got ${err && err.name}: ${err && err.message}`)
  return err
}

describe("chain-verify — verifyExecutorWhitelist proves the INSTANCE, not just the type", () => {
  test("whitelistedExecutors(signer) = true → resolves, and the read carried OUR signer", async () => {
    const provider = fakeProvider(true)
    const lines = []
    const out = await verifyExecutorWhitelist({ provider, chainId: 8453, contracts: [v2], signer: SIGNER, log: (l) => lines.push(l), ...FAST })
    assert.equal(provider.calls.length, 1)
    assert.equal(provider.calls[0].functionName, "whitelistedExecutors")
    assert.equal(provider.calls[0].address, V2_ADDRESS)
    assert.deepEqual(provider.calls[0].args, [SIGNER], "the argument must be the signer we will send from")
    assert.deepEqual(out, { signer: SIGNER, contracts: [{ label: v2.label, address: V2_ADDRESS, whitelisted: true }] })
    assert.ok(lines.some((l) => l.includes(SIGNER) && /whitelistedExecutors = true/.test(l)), `boot log must show signer + result: ${lines}`)
  })

  test("= false → refuses, naming the signer and the contract (right contract, wrong key)", async () => {
    const err = await refuses(verifyExecutorWhitelist({ provider: fakeProvider(false), chainId: 8453, contracts: [v2], signer: SIGNER, ...FAST }))
    assert.equal(err.check, "whitelist")
    assert.match(err.message, /FATAL/)
    assert.ok(err.message.includes(SIGNER), "must name the signer")
    assert.ok(err.message.includes(V2_ADDRESS), "must name the executor")
    assert.match(err.message, /whitelistedExecutors/)
    assert.match(err.message, /Refusing to boot/)
  })

  test("EVERY configured executor must whitelist the signer — v3 true does not excuse v2 false", async () => {
    const provider = fakeProvider((args) => args.address === V3_ADDRESS)
    const err = await refuses(verifyExecutorWhitelist({ provider, chainId: 8453, contracts: [v2, v3], signer: SIGNER, ...FAST }))
    assert.ok(err.message.includes(V2_ADDRESS))
    assert.match(err.message, /ORDER_EXECUTOR_ADDRESS \(v2\)/)
  })

  test("both true → both reported", async () => {
    const out = await verifyExecutorWhitelist({ provider: fakeProvider(true), chainId: 8453, contracts: [v2, v3], signer: SIGNER, ...FAST })
    assert.deepEqual(out.contracts.map((c) => c.whitelisted), [true, true])
  })

  test("a malformed (non-boolean) answer → refuses, never coerced to true", async () => {
    for (const bad of ["true", 1, "0x01", undefined, null, {}]) {
      const err = await refuses(verifyExecutorWhitelist({ provider: fakeProvider(bad), chainId: 8453, contracts: [v2], signer: SIGNER, ...FAST }))
      assert.match(err.message, /malformed/, `answer ${JSON.stringify(bad)} must be refused as malformed`)
    }
  })

  test("the read throwing (RPC down / not an executor) → refuses after the bounded retry", async () => {
    const provider = fakeProvider(new Error("boom https://rpc.example/v2/SECRETKEY123"))
    const err = await refuses(verifyExecutorWhitelist({ provider, chainId: 8453, contracts: [v2], signer: SIGNER, attempts: 2, ...FAST }))
    assert.equal(provider.calls.length, 2, "bounded retry, then refusal")
    assert.match(err.message, /could not read whitelistedExecutors/)
    assert.ok(!err.message.includes("SECRETKEY123"), "the RPC URL must be redacted")
  })

  test("an invalid signer address → refuses BEFORE touching the network", async () => {
    for (const bad of [undefined, "", "0x1234", "not-an-address"]) {
      const provider = fakeProvider(true)
      const err = await refuses(verifyExecutorWhitelist({ provider, chainId: 8453, contracts: [v2], signer: bad, ...FAST }))
      assert.match(err.message, /signer/)
      assert.equal(provider.calls.length, 0)
    }
  })

  test("an empty contract list → refuses (nothing verified ≠ verified)", async () => {
    const err = await refuses(verifyExecutorWhitelist({ provider: fakeProvider(true), chainId: 8453, contracts: [], signer: SIGNER, ...FAST }))
    assert.match(err.message, /no executor/)
  })

  test("the ABI is the auto-generated getter of `mapping(address => bool) public whitelistedExecutors`", () => {
    assert.equal(WHITELISTED_EXECUTORS_ABI.length, 1)
    const fn = WHITELISTED_EXECUTORS_ABI[0]
    assert.equal(fn.name, "whitelistedExecutors")
    assert.equal(fn.stateMutability, "view")
    assert.deepEqual(fn.inputs.map((i) => i.type), ["address"])
    assert.deepEqual(fn.outputs.map((o) => o.type), ["bool"])
  })
})

// ── 3. The real executor.js boot, observed through its RPC and its KMS ───────────────────────

describe("boot-identity — the real executor.js boot against RPC + KMS doubles", () => {
  const EXECUTOR = fileURLToPath(new URL("./executor.js", import.meta.url))
  const ARBITRUM = 42161
  // DER SubjectPublicKeyInfo header for an uncompressed secp256k1 point (what KMS returns for an
  // ECC_SECG_P256K1 key); kms-signer.js takes the last 65 bytes.
  const SPKI_HEADER = "3056301006072a8648ce3d020106052b8104000a034200"
  const DEV_PUBKEY_DER = Buffer.concat([Buffer.from(SPKI_HEADER, "hex"), Buffer.from(hexToBytes(DEV_ACCOUNT.publicKey))])

  const bootCwds = []
  after(() => {
    for (const dir of bootCwds) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup only
      }
    }
  })

  /**
   * Boot the real keeper. `env` overrides/removes variables from a KMS-signed, v3-only,
   * Arbitrum-shaped baseline (the second-process shape): a value of `null` REMOVES the variable.
   * `seen` is the ORDERED list of everything the boot asked either double — "eth_*" for the RPC,
   * "kms:<Op>" for KMS — so the boot SEQUENCE is asserted, not just the set of calls.
   */
  async function bootExecutor({ chainId = ARBITRUM, whitelisted = true, typehash = EXPECTED_ORDER_TYPEHASH_V3, env = {} } = {}) {
    const seen = []
    const whitelistReads = []
    const rpc = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        let payload
        try {
          payload = JSON.parse(body)
        } catch {
          res.writeHead(400).end("{}")
          return
        }
        const answer = (call) => {
          seen.push(call.method)
          switch (call.method) {
            case "eth_chainId":
              return { jsonrpc: "2.0", id: call.id, result: `0x${chainId.toString(16)}` }
            case "eth_getCode":
              return { jsonrpc: "2.0", id: call.id, result: SOME_CODE }
            case "eth_call": {
              const tx = Array.isArray(call.params) && call.params[0] ? call.params[0] : {}
              const data = String(tx.data || "")
              if (data.startsWith(SEL_WHITELISTED)) {
                const arg = `0x${data.slice(10 + 24, 10 + 64)}`.toLowerCase()
                whitelistReads.push({ to: String(tx.to).toLowerCase(), arg })
                seen.push("eth_call:whitelistedExecutors")
                const v = typeof whitelisted === "function" ? whitelisted(String(tx.to).toLowerCase()) : whitelisted
                return { jsonrpc: "2.0", id: call.id, result: v ? BOOL_TRUE : BOOL_FALSE }
              }
              if (data.startsWith(SEL_ORDER_TYPEHASH)) {
                seen.push("eth_call:ORDER_TYPEHASH")
                const result = typeof typehash === "function" ? typehash(String(tx.to).toLowerCase()) : typehash
                return { jsonrpc: "2.0", id: call.id, result }
              }
              return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: `test double: unexpected eth_call ${data.slice(0, 10)}` } }
            }
            default:
              // Everything past the gates (eth_getBalance first) errors, so the child exits on its
              // own instead of binding the health/metrics ports.
              return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: `test double: ${call.method} not served` } }
          }
        }
        const out = Array.isArray(payload) ? payload.map(answer) : answer(payload)
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out))
      })
    })
    const kms = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const target = String(req.headers["x-amz-target"] || "")
        const op = target.split(".")[1] || target
        seen.push(`kms:${op}`)
        if (op === "GetPublicKey") {
          res.writeHead(200, { "content-type": "application/x-amz-json-1.1" })
          res.end(
            JSON.stringify({
              KeyId: "arn:aws:kms:eu-north-1:000000000000:key/test-double",
              PublicKey: DEV_PUBKEY_DER.toString("base64"),
              KeySpec: "ECC_SECG_P256K1",
              KeyUsage: "SIGN_VERIFY",
              SigningAlgorithms: ["ECDSA_SHA_256"],
            }),
          )
          return
        }
        // A boot must never SIGN anything.
        res.writeHead(400, { "content-type": "application/x-amz-json-1.1" })
        res.end(JSON.stringify({ __type: "ValidationException", message: `test double: ${op} not served` }))
      })
    })
    await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve))
    await new Promise((resolve) => kms.listen(0, "127.0.0.1", resolve))
    const rpcPort = rpc.address().port
    const kmsPort = kms.address().port

    // A throwaway cwd so env.js's loadEnv(<cwd>/.env.executor) finds nothing — every variable
    // below is the ENTIRE environment of the boot.
    const bootCwd = mkdtempSync(join(tmpdir(), "keeper-identity-"))
    bootCwds.push(bootCwd)

    const baseline = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RPC_URL: `http://127.0.0.1:${rpcPort}`,
      CHAIN_ID: String(ARBITRUM),
      ORDER_EXECUTOR_V3_ADDRESS: V3_ADDRESS,
      SUPABASE_URL: "http://127.0.0.1:9/unused",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      // The production signer path: KMS, no plaintext key, no ALLOW_PLAINTEXT_KEY.
      KMS_KEY_ID: "alias/test-double",
      KMS_REGION: "eu-north-1",
      AWS_ENDPOINT_URL_KMS: `http://127.0.0.1:${kmsPort}`,
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_EC2_METADATA_DISABLED: "true",
    }
    const childEnv = { ...baseline }
    for (const [k, v] of Object.entries(env)) {
      if (v === null) delete childEnv[k]
      else childEnv[k] = v
    }

    const child = spawn(process.execPath, [EXECUTOR], { cwd: bootCwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    const exitCode = await new Promise((resolve) => {
      const kill = setTimeout(() => {
        child.kill("SIGKILL")
        resolve("TIMED_OUT")
      }, 25_000)
      child.on("exit", (c) => {
        clearTimeout(kill)
        resolve(c)
      })
    })
    await new Promise((resolve) => rpc.close(resolve))
    await new Promise((resolve) => kms.close(resolve))
    return { exitCode, stdout, stderr, seen, whitelistReads }
  }

  const noNetwork = (boot) => assert.equal(boot.seen.length, 0, `network was reached before the refusal: ${boot.seen.join(", ")}`)

  // ── Task 1: no identity-bearing default ──

  test("missing CHAIN_ID → exit 1 naming CHAIN_ID, before any RPC or KMS call", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ env: { CHAIN_ID: null } })
    assert.equal(boot.exitCode, 1, `expected exit 1, got ${boot.exitCode}\n${boot.stderr}`)
    assert.match(boot.stderr, /FATAL/)
    assert.match(boot.stderr, /CHAIN_ID/)
    noNetwork(boot)
  })

  test("empty CHAIN_ID → exit 1 naming CHAIN_ID", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ env: { CHAIN_ID: "" } })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /CHAIN_ID/)
    noNetwork(boot)
  })

  test("unparseable CHAIN_ID ('8453abc' — parseInt would have said 8453) → exit 1", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ env: { CHAIN_ID: "8453abc" } })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /CHAIN_ID/)
    noNetwork(boot)
  })

  test("CHAIN_ID ≠ eth_chainId → exit 1, and the signer (KMS) is never consulted", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ chainId: 8453 }) // RPC is Base, config says Arbitrum
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /RPC\/chain mismatch/)
    assert.match(boot.stderr, /CHAIN_ID=42161/)
    assert.ok(boot.seen.includes("eth_chainId"))
    assert.ok(!boot.seen.some((m) => m.startsWith("kms:")), `KMS was reached despite a chain mismatch: ${boot.seen.join(", ")}`)
    assert.ok(!boot.seen.includes("eth_call:whitelistedExecutors"))
    assert.ok(!boot.seen.includes("eth_getBalance"))
  })

  for (const name of ["RPC_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    test(`missing ${name} → exit 1 naming ${name}, no network`, { timeout: 60_000 }, async () => {
      const boot = await bootExecutor({ env: { [name]: null } })
      assert.equal(boot.exitCode, 1, boot.stderr)
      assert.match(boot.stderr, /FATAL/)
      assert.ok(boot.stderr.includes(name), `refusal must name ${name}:\n${boot.stderr}`)
      noNetwork(boot)
    })
    test(`empty ${name} → exit 1 naming ${name}`, { timeout: 60_000 }, async () => {
      const boot = await bootExecutor({ env: { [name]: "  " } })
      assert.equal(boot.exitCode, 1, boot.stderr)
      assert.ok(boot.stderr.includes(name), `refusal must name ${name}:\n${boot.stderr}`)
      noNetwork(boot)
    })
  }

  test("no executor address at all → exit 1 naming both address variables, no network", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ env: { ORDER_EXECUTOR_V3_ADDRESS: null } })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /ORDER_EXECUTOR_ADDRESS/)
    assert.match(boot.stderr, /ORDER_EXECUTOR_V3_ADDRESS/)
    noNetwork(boot)
  })

  test("no signer (KMS_KEY_ID absent, no plaintext key) → exit 1 naming KMS_KEY_ID, no network", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ env: { KMS_KEY_ID: null } })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /KMS_KEY_ID/)
    noNetwork(boot)
  })

  test("KMS_KEY_ID set but KMS_REGION missing → exit 1 naming KMS_REGION (no us-east-1 default)", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ env: { KMS_REGION: null } })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /KMS_REGION/)
    noNetwork(boot)
  })

  // ── Task 2: the instance gate ──

  test("whitelistedExecutors(signer) = false → exit 1 naming the KMS signer; nothing past the gate", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ whitelisted: false })
    assert.equal(boot.exitCode, 1, `expected exit 1, got ${boot.exitCode}\nstdout=${boot.stdout}\nstderr=${boot.stderr}`)
    assert.match(boot.stderr, /whitelistedExecutors/)
    assert.ok(boot.stderr.includes(SIGNER), `refusal must name the signer ${SIGNER}:\n${boot.stderr}`)
    assert.ok(boot.stderr.includes(V3_ADDRESS), "refusal must name the executor")
    assert.match(boot.stderr, /Refusing to boot/)
    // The read was made with OUR (KMS-derived) signer, against the configured executor.
    assert.equal(boot.whitelistReads.length, 1)
    assert.equal(boot.whitelistReads[0].to, V3_ADDRESS.toLowerCase())
    assert.equal(boot.whitelistReads[0].arg, SIGNER.toLowerCase())
    assert.ok(!boot.seen.includes("eth_getBalance"), "the balance/servers step ran despite a refusal")
    assert.ok(!boot.seen.includes("kms:Sign"), "a boot must never sign")
  })

  test("whitelistedExecutors(signer) = true → boot proceeds past the gate (positive control), in order", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ whitelisted: true })
    // Past the gate: the first post-gate read (eth_getBalance) was issued. The double refuses it,
    // so the process then exits on its own rather than binding the health/metrics ports — "boots"
    // here means "every boot gate passed", exactly as chain-verify.test.mjs defines it.
    assert.ok(boot.seen.includes("eth_getBalance"), `boot never got past the whitelist gate; saw ${boot.seen.join(", ")}\n${boot.stderr}`)
    assert.ok(!boot.stderr.includes("Refusing to boot"), boot.stderr)
    // The sequence: env → chainId → identity → signer (KMS) → whitelist → work.
    const order = ["eth_chainId", "eth_getCode", "eth_call:ORDER_TYPEHASH", "kms:GetPublicKey", "eth_call:whitelistedExecutors", "eth_getBalance"]
    const idx = order.map((m) => boot.seen.indexOf(m))
    for (let i = 0; i < order.length; i++) assert.ok(idx[i] >= 0, `boot never issued ${order[i]}; saw ${boot.seen.join(", ")}`)
    for (let i = 1; i < order.length; i++) assert.ok(idx[i - 1] < idx[i], `${order[i - 1]} must precede ${order[i]}; saw ${boot.seen.join(", ")}`)
    assert.equal(boot.whitelistReads[0].arg, SIGNER.toLowerCase())
    // The owner-visible log lines.
    assert.match(boot.stdout, /\[C-02\] KMS executor address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266/)
    assert.match(boot.stdout, /\[chain-verify\] signer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 — whitelistedExecutors = true on ORDER_EXECUTOR_V3_ADDRESS \(v3\)/)
    assert.ok(!boot.seen.includes("kms:Sign"), "a boot must never sign")
  })

  test("both v2 and v3 configured → BOTH are asked; v2 true + v3 false still refuses, naming v3", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({
      env: { ORDER_EXECUTOR_ADDRESS: V2_ADDRESS },
      typehash: (to) => (to === V2_ADDRESS.toLowerCase() ? EXPECTED_ORDER_TYPEHASH_V2 : EXPECTED_ORDER_TYPEHASH_V3),
      whitelisted: (to) => to === V2_ADDRESS.toLowerCase(),
    })
    assert.equal(boot.exitCode, 1, `expected exit 1, got ${boot.exitCode}\n${boot.stderr}`)
    assert.deepEqual(
      boot.whitelistReads.map((r) => r.to).sort(),
      [V2_ADDRESS.toLowerCase(), V3_ADDRESS.toLowerCase()].sort(),
      "both executors must be asked about the signer",
    )
    assert.ok(boot.whitelistReads.every((r) => r.arg === SIGNER.toLowerCase()))
    assert.ok(boot.stderr.includes(V3_ADDRESS), `refusal must name the executor that said no:\n${boot.stderr}`)
    assert.match(boot.stderr, /ORDER_EXECUTOR_V3_ADDRESS \(v3\)/)
    assert.ok(!boot.seen.includes("eth_getBalance"), "the balance/servers step ran despite a refusal")
  })
})
