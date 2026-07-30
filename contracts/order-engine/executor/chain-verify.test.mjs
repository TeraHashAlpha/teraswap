// Tests for chain-verify.js — the FAIL-CLOSED boot-time chain/contract binding verification.
//
// [FIX-KEEPER-BOOT-CHAIN-VERIFICATION] validateConfig() only checks ORDER_EXECUTOR_ADDRESS is
// PRESENT. Presence is not identity: one keeper instance per CHAIN_ID, no per-chain address table,
// and the same deployer EOA at the same nonce lands on the SAME address on every EVM chain — so a
// keeper started with CHAIN_ID=42161 and a mainnet executor address used to pass every check and
// start moving funds. These tests drive the verification by INJECTING a fake provider into
// verifyChainBinding, never by mocking `viem`: a module mock is a bet that the consumer keeps
// calling that boundary, and when it stops the mock does not fail, it disappears. Here the double
// is a required ARGUMENT — if the production call site stops routing through the port, it breaks
// loudly instead of quietly verifying nothing.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  verifyChainBinding,
  createRpcProbe,
  ChainVerificationError,
  ORDER_TYPEHASH_ABI,
  ORDER_TYPEHASH_V2_SIGNATURE,
  ORDER_TYPEHASH_V3_SIGNATURE,
  EXPECTED_ORDER_TYPEHASH_V2,
  EXPECTED_ORDER_TYPEHASH_V3,
  DEFAULT_ATTEMPTS,
} from "./chain-verify.js"

// ── Fake provider (INJECTED, not mocked) ─────────────────────────────────────────────────────
// Each response slot accepts: a plain value, a function of the call args, THROWS(err) to reject,
// or HANGS to return a promise that never settles (the "RPC accepted the connection and then went
// silent" case a plain await cannot survive).
const HANGS = Symbol("hangs")
const THROWS = (message) => ({ __throws: message })

function resolveSlot(slot, args, calls) {
  const value = typeof slot === "function" ? slot(args, calls) : slot
  if (value === HANGS) return new Promise(() => {})
  if (value && typeof value === "object" && "__throws" in value) {
    return Promise.reject(new Error(value.__throws))
  }
  return Promise.resolve(value)
}

// NOTE: slots are read with Object.hasOwn, not default parameters — `{ code: undefined }` is a
// REAL case under test (viem returns undefined for an address with no code) and must not silently
// fall back to the happy-path default.
function fakeProvider(opts = {}) {
  const pick = (key, fallback) => (Object.hasOwn(opts, key) ? opts[key] : fallback)
  const chainId = pick("chainId", 1)
  const code = pick("code", "0x60806040")
  const typehash = pick("typehash", EXPECTED_ORDER_TYPEHASH_V2)
  const calls = []
  return {
    calls,
    getChainId() {
      calls.push({ method: "getChainId" })
      return resolveSlot(chainId, undefined, calls)
    },
    getCode(args) {
      calls.push({ method: "getCode", address: args.address })
      return resolveSlot(code, args, calls)
    },
    readContract(args) {
      calls.push({ method: "readContract", address: args.address, functionName: args.functionName })
      return resolveSlot(typehash, args, calls)
    },
  }
}

const V2_ADDRESS = "0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130"
const V3_ADDRESS = "0x135B339902Ea4E0fB4CF059961dc8856bA1D2598"

const v2Only = [
  { label: "ORDER_EXECUTOR_ADDRESS (v2)", address: V2_ADDRESS, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V2 },
]

// Fast, deterministic knobs: no real sleeping, a short timeout so the HANGS cases finish quickly.
const FAST = { sleep: async () => {}, retryDelayMs: 0, timeoutMs: 30 }

/** Assert the call refused, and hand back the error so each test can pin its message. */
async function refuses(promise) {
  const err = await promise.then(
    () => null,
    (e) => e,
  )
  assert.ok(err, "expected verifyChainBinding to REFUSE, but it resolved")
  assert.ok(
    err instanceof ChainVerificationError,
    `expected a ChainVerificationError, got ${err && err.name}: ${err && err.message}`,
  )
  return err
}

// ── The identity expectation itself ──────────────────────────────────────────────────────────

describe("chain-verify — ORDER_TYPEHASH expectations (ADR-018 self-identification)", () => {
  // Pinned to the value read on-chain from BOTH live v2 deployments while writing this module:
  // mainnet 0xeFC3…f130 and Base 0x135B…2598 both return exactly this. If a source edit to
  // ORDER_TYPEHASH_V2_SIGNATURE moves the derived hash, the deployed executors are no longer what
  // the keeper expects and this test says so before the boot gate bricks a live keeper.
  test("v2 expectation equals the typehash the deployed mainnet + Base executors report", () => {
    assert.equal(
      EXPECTED_ORDER_TYPEHASH_V2,
      "0x4c8bd2ee0e4c450f7c9ded5a85150c64e0e4bb10b1961d80fa93e463f11c9be5",
    )
  })

  test("v3 expectation is distinct from v2 — a v2/v3 address swap cannot pass", () => {
    assert.notEqual(EXPECTED_ORDER_TYPEHASH_V3, EXPECTED_ORDER_TYPEHASH_V2)
    assert.match(EXPECTED_ORDER_TYPEHASH_V3, /^0x[0-9a-f]{64}$/)
  })

  test("the type strings mirror the contracts: v3 = v2 + uint16 maxSlippageBps after minAmountOut", () => {
    assert.equal(
      ORDER_TYPEHASH_V3_SIGNATURE,
      ORDER_TYPEHASH_V2_SIGNATURE.replace(
        "uint256 minAmountOut,",
        "uint256 minAmountOut,uint16 maxSlippageBps,",
      ),
    )
  })

  test("the identity read is a cheap, argument-free view getter", () => {
    const [fn] = ORDER_TYPEHASH_ABI
    assert.equal(fn.name, "ORDER_TYPEHASH")
    assert.equal(fn.stateMutability, "view")
    assert.deepEqual(fn.inputs, [])
  })
})

// ── Check 1: eth_chainId ─────────────────────────────────────────────────────────────────────

describe("chain-verify — check 1: eth_chainId must equal CHAIN_ID", () => {
  test("chainId MATCH → boot proceeds", async () => {
    const provider = fakeProvider({ chainId: 1 })
    const result = await verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST })
    assert.equal(result.chainId, 1)
    assert.deepEqual(
      provider.calls.map((c) => c.method),
      ["getChainId", "getCode", "readContract"],
    )
  })

  test("chainId MISMATCH (mainnet address, Arbitrum keeper) → refuses, naming both chains", async () => {
    const provider = fakeProvider({ chainId: 1 })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 42161, contracts: v2Only, ...FAST }),
    )
    assert.equal(err.check, "chainId")
    assert.equal(err.value, 1)
    assert.match(err.message, /reports chain 1\b/)
    assert.match(err.message, /CHAIN_ID=42161/)
  })

  test("a mismatch short-circuits — the executor is never even read", async () => {
    const provider = fakeProvider({ chainId: 8453 })
    await refuses(verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST }))
    assert.deepEqual(
      provider.calls.map((c) => c.method),
      ["getChainId"],
    )
  })

  test("bigint chain ids are accepted (viem transports differ) — 1n matches 1", async () => {
    const provider = fakeProvider({ chainId: 1n })
    const result = await verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST })
    assert.equal(result.chainId, 1)
  })

  for (const [label, value] of [
    ["a hex string", "0x1"],
    ["a decimal string", "1"],
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
    ["null", null],
    ["undefined", undefined],
    ["an object", { chainId: 1 }],
  ]) {
    test(`malformed eth_chainId (${label}) → refuses, never coerced`, async () => {
      const provider = fakeProvider({ chainId: value })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST }),
      )
      assert.equal(err.check, "chainId")
      assert.match(err.message, /malformed eth_chainId/)
      assert.match(err.message, /CHAIN_ID=1\b/)
    })
  }
})

// ── Check 2: eth_getCode ─────────────────────────────────────────────────────────────────────

describe("chain-verify — check 2: eth_getCode must be non-empty", () => {
  test("POPULATED code → boot proceeds, size reported", async () => {
    const provider = fakeProvider({ code: "0x" + "ab".repeat(64) })
    const result = await verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST })
    assert.equal(result.contracts[0].codeSize, 64)
    assert.equal(result.contracts[0].address, V2_ADDRESS)
  })

  for (const [label, value] of [
    ['"0x" (viem: no code)', "0x"],
    ["undefined (viem: no code)", undefined],
    ["null", null],
    ['""', ""],
  ]) {
    test(`EMPTY code ${label} → refuses, naming the address and the chain`, async () => {
      const provider = fakeProvider({ chainId: 42161, code: value })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 42161, contracts: v2Only, ...FAST }),
      )
      assert.equal(err.check, "code")
      assert.match(err.message, /no contract code/)
      assert.match(err.message, new RegExp(V2_ADDRESS))
      assert.match(err.message, /chain 42161/)
    })
  }

  for (const [label, value] of [
    ["odd-length hex", "0x0"],
    ["not hex", "0xzz"],
    ["missing 0x prefix", "60806040"],
    ["a number", 1234],
    ["an object", { code: "0x60" }],
  ]) {
    test(`malformed eth_getCode (${label}) → refuses rather than assuming a contract`, async () => {
      const provider = fakeProvider({ code: value })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST }),
      )
      assert.equal(err.check, "code")
      assert.match(err.message, /malformed eth_getCode|no contract code/)
      assert.match(err.message, /chain 1\b/)
    })
  }

  test("empty code short-circuits — the identity read is never attempted", async () => {
    const provider = fakeProvider({ code: "0x" })
    await refuses(verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST }))
    assert.equal(provider.calls.filter((c) => c.method === "readContract").length, 0)
  })
})

// ── Check 3: ORDER_TYPEHASH() self-identification ────────────────────────────────────────────

describe("chain-verify — check 3: the contract must self-identify", () => {
  test("matching ORDER_TYPEHASH → boot proceeds; the read is a view call on the same address", async () => {
    const provider = fakeProvider({ typehash: EXPECTED_ORDER_TYPEHASH_V2 })
    const result = await verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST })
    assert.equal(result.contracts[0].orderTypehash, EXPECTED_ORDER_TYPEHASH_V2)
    const read = provider.calls.find((c) => c.method === "readContract")
    assert.equal(read.address, V2_ADDRESS)
    assert.equal(read.functionName, "ORDER_TYPEHASH")
  })

  test("checksum/case differences do not matter — comparison is case-insensitive", async () => {
    const provider = fakeProvider({ typehash: EXPECTED_ORDER_TYPEHASH_V2.toUpperCase().replace("0X", "0x") })
    const result = await verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST })
    assert.ok(result.contracts[0].orderTypehash)
  })

  test("WRONG ORDER_TYPEHASH (a different contract at a colliding address) → refuses", async () => {
    const wrong = "0x" + "11".repeat(32)
    const provider = fakeProvider({ chainId: 42161, typehash: wrong })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 42161, contracts: v2Only, ...FAST }),
    )
    assert.equal(err.check, "identity")
    assert.equal(err.value, wrong)
    assert.match(err.message, new RegExp(wrong))
    assert.match(err.message, new RegExp(EXPECTED_ORDER_TYPEHASH_V2))
    assert.match(err.message, /chain 42161/)
  })

  test("a v3 executor pasted into ORDER_EXECUTOR_ADDRESS → refuses (v3 typehash ≠ v2)", async () => {
    const provider = fakeProvider({ typehash: EXPECTED_ORDER_TYPEHASH_V3 })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST }),
    )
    assert.equal(err.check, "identity")
    assert.match(err.message, /identity mismatch/)
  })

  for (const [label, value] of [
    ["short bytes32", "0x1234"],
    ["not hex", "0x" + "zz".repeat(32)],
    ["a bigint", 1n],
    ["null", null],
    ["undefined", undefined],
  ]) {
    test(`malformed ORDER_TYPEHASH (${label}) → refuses`, async () => {
      const provider = fakeProvider({ typehash: value })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST }),
      )
      assert.equal(err.check, "identity")
      assert.match(err.message, /malformed\s+ORDER_TYPEHASH/)
    })
  }

  test("an entry with no expectation is code-checked but not identity-checked", async () => {
    const provider = fakeProvider()
    const result = await verifyChainBinding({
      provider,
      chainId: 1,
      contracts: [{ label: "FeeCollector", address: V2_ADDRESS }],
      ...FAST,
    })
    assert.equal(result.contracts[0].orderTypehash, null)
    assert.equal(provider.calls.filter((c) => c.method === "readContract").length, 0)
  })
})

// ── Fail-closed on transport failure ─────────────────────────────────────────────────────────

describe("chain-verify — RPC throwing refuses the boot (never warn-and-continue)", () => {
  test("eth_chainId throws (RPC unreachable) → refuses, naming the chain", async () => {
    const provider = fakeProvider({ chainId: THROWS("ECONNREFUSED 127.0.0.1:8545") })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 8453, contracts: v2Only, ...FAST, attempts: 1 }),
    )
    assert.equal(err.check, "chainId")
    assert.match(err.message, /ECONNREFUSED/)
    assert.match(err.message, /CHAIN_ID=8453/)
    assert.match(err.message, /refusing to boot/i)
  })

  test("eth_getCode throws → refuses, naming the address and the chain", async () => {
    const provider = fakeProvider({ code: THROWS("rate limited") })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
    )
    assert.equal(err.check, "code")
    assert.match(err.message, /rate limited/)
    assert.match(err.message, new RegExp(V2_ADDRESS))
    assert.match(err.message, /chain 1\b/)
  })

  test("ORDER_TYPEHASH() reverts (address is not an executor) → refuses", async () => {
    const provider = fakeProvider({ typehash: THROWS("execution reverted") })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
    )
    assert.equal(err.check, "identity")
    assert.match(err.message, /execution reverted/)
    assert.match(err.message, /may not be a TeraSwapOrderExecutor/)
  })
})

describe("chain-verify — RPC timing out refuses the boot", () => {
  // Explicit per-test timeouts: without the module's own timeout these would HANG forever rather
  // than fail, so the mutation "make withTimeout a passthrough" must show up as RED, not as a
  // suite that never finishes.
  test("eth_chainId never answers → refuses", { timeout: 5_000 }, async () => {
    const provider = fakeProvider({ chainId: HANGS })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
    )
    assert.equal(err.check, "chainId")
    assert.match(err.message, /timed out after 30ms/)
  })

  test("eth_getCode never answers → refuses", { timeout: 5_000 }, async () => {
    const provider = fakeProvider({ code: HANGS })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
    )
    assert.equal(err.check, "code")
    assert.match(err.message, /timed out after 30ms/)
  })

  test("ORDER_TYPEHASH() never answers → refuses", { timeout: 5_000 }, async () => {
    const provider = fakeProvider({ typehash: HANGS })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
    )
    assert.equal(err.check, "identity")
    assert.match(err.message, /timed out after 30ms/)
  })
})

describe("chain-verify — retries are bounded and terminate in refusal", () => {
  test("a transient failure is retried and the boot proceeds once it clears", async () => {
    let n = 0
    const provider = fakeProvider({
      chainId: () => (++n < 3 ? { __throws: "transient" } : 1),
    })
    const result = await verifyChainBinding({
      provider,
      chainId: 1,
      contracts: v2Only,
      ...FAST,
      attempts: 3,
    })
    assert.equal(result.chainId, 1)
    assert.equal(n, 3)
  })

  test("a permanently dead RPC exhausts the bound and STILL refuses", async () => {
    let n = 0
    const provider = fakeProvider({
      chainId: () => {
        n++
        return { __throws: "ETIMEDOUT" }
      },
    })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 4 }),
    )
    assert.equal(n, 4, "should stop after exactly `attempts` tries")
    assert.match(err.message, /after 4 attempt\(s\)/)
  })

  test("the default retry bound is finite", () => {
    assert.ok(Number.isInteger(DEFAULT_ATTEMPTS) && DEFAULT_ATTEMPTS >= 1 && DEFAULT_ATTEMPTS <= 10)
  })

  test("a MISMATCH is not retried — it is deterministic, so one answer is enough", async () => {
    const provider = fakeProvider({ chainId: 1 })
    await refuses(verifyChainBinding({ provider, chainId: 999, contracts: v2Only, ...FAST, attempts: 5 }))
    assert.equal(provider.calls.length, 1)
  })
})

// ── Argument guards (a malformed call is a refusal, never a skip) ────────────────────────────

describe("chain-verify — argument guards fail closed", () => {
  test("no provider → refuses", async () => {
    const err = await refuses(verifyChainBinding({ chainId: 1, contracts: v2Only, ...FAST }))
    assert.equal(err.check, "provider")
  })

  test("a provider missing readContract → refuses (cannot verify identity ⇒ do not boot)", async () => {
    const provider = fakeProvider()
    delete provider.readContract
    const err = await refuses(verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST }))
    assert.equal(err.check, "provider")
  })

  test("CHAIN_ID=NaN (parseInt of a junk env value) → refuses", async () => {
    const err = await refuses(
      verifyChainBinding({ provider: fakeProvider(), chainId: Number.NaN, contracts: v2Only, ...FAST }),
    )
    assert.equal(err.check, "config")
    assert.match(err.message, /not a valid chain id/)
  })

  test("an empty contract list → refuses (nothing verified is not the same as verified)", async () => {
    const err = await refuses(
      verifyChainBinding({ provider: fakeProvider(), chainId: 1, contracts: [], ...FAST }),
    )
    assert.equal(err.check, "config")
  })

  for (const [label, value] of [
    ["a truncated address", "0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f1"],
    ["a name, not an address", "orderExecutor.eth"],
    ["empty", ""],
    ["undefined", undefined],
  ]) {
    test(`a malformed executor address (${label}) → refuses`, async () => {
      const err = await refuses(
        verifyChainBinding({
          provider: fakeProvider(),
          chainId: 1,
          contracts: [{ label: "ORDER_EXECUTOR_ADDRESS (v2)", address: value }],
          ...FAST,
        }),
      )
      assert.equal(err.check, "address")
      assert.match(err.message, /chain 1\b/)
    })
  }
})

// ── Multiple executors (v2 + optional v3) ────────────────────────────────────────────────────

describe("chain-verify — every configured executor is verified, each with its own identity", () => {
  const bothConfigured = [
    { label: "ORDER_EXECUTOR_ADDRESS (v2)", address: V2_ADDRESS, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V2 },
    { label: "ORDER_EXECUTOR_V3_ADDRESS (v3)", address: V3_ADDRESS, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V3 },
  ]
  const byAddress = (map) => (args) => map[args.address]

  test("v2 + v3 both correct → boot proceeds, both reported", async () => {
    const provider = fakeProvider({
      chainId: 8453,
      typehash: byAddress({
        [V2_ADDRESS]: EXPECTED_ORDER_TYPEHASH_V2,
        [V3_ADDRESS]: EXPECTED_ORDER_TYPEHASH_V3,
      }),
    })
    const result = await verifyChainBinding({ provider, chainId: 8453, contracts: bothConfigured, ...FAST })
    assert.equal(result.contracts.length, 2)
    assert.equal(result.contracts[1].orderTypehash, EXPECTED_ORDER_TYPEHASH_V3)
  })

  test("the v2/v3 addresses swapped in the env → refuses on the v2 slot", async () => {
    const provider = fakeProvider({
      chainId: 8453,
      typehash: byAddress({
        [V2_ADDRESS]: EXPECTED_ORDER_TYPEHASH_V3,
        [V3_ADDRESS]: EXPECTED_ORDER_TYPEHASH_V2,
      }),
    })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 8453, contracts: bothConfigured, ...FAST }),
    )
    assert.equal(err.check, "identity")
    assert.match(err.message, /ORDER_EXECUTOR_ADDRESS \(v2\)/)
  })

  test("a good v2 does NOT excuse a codeless v3 — refusal names the v3 slot", async () => {
    const provider = fakeProvider({
      chainId: 8453,
      code: byAddress({ [V2_ADDRESS]: "0x60806040", [V3_ADDRESS]: "0x" }),
    })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 8453, contracts: bothConfigured, ...FAST }),
    )
    assert.equal(err.check, "code")
    assert.equal(err.value, V3_ADDRESS)
    assert.match(err.message, /ORDER_EXECUTOR_V3_ADDRESS \(v3\)/)
  })
})

// ── The port adapter ─────────────────────────────────────────────────────────────────────────

describe("chain-verify — createRpcProbe adapts a viem client onto the injected port", () => {
  test("a viem 2.22+ client (getCode) is adapted", async () => {
    const seen = []
    const probe = createRpcProbe({
      getChainId: async () => 1,
      getCode: async ({ address }) => {
        seen.push(address)
        return "0x60806040"
      },
      readContract: async () => EXPECTED_ORDER_TYPEHASH_V2,
    })
    const result = await verifyChainBinding({ provider: probe, chainId: 1, contracts: v2Only, ...FAST })
    assert.equal(result.chainId, 1)
    assert.deepEqual(seen, [V2_ADDRESS])
  })

  test("an older client exposing only getBytecode is adapted (name shim, not a fallback verdict)", async () => {
    const probe = createRpcProbe({
      getChainId: async () => 1,
      getBytecode: async () => "0x60806040",
      readContract: async () => EXPECTED_ORDER_TYPEHASH_V2,
    })
    const result = await verifyChainBinding({ provider: probe, chainId: 1, contracts: v2Only, ...FAST })
    assert.equal(result.contracts[0].codeSize, 4)
  })

  test("a client that can read neither code nor chain id → throws instead of verifying nothing", () => {
    assert.throws(() => createRpcProbe({ getChainId: async () => 1 }), ChainVerificationError)
    assert.throws(() => createRpcProbe(null), ChainVerificationError)
  })

  test("the real viem PublicClient shape satisfies the port", async () => {
    const { createPublicClient, http } = await import("viem")
    const client = createPublicClient({
      chain: {
        id: 1,
        name: "eth",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
      },
      transport: http("http://127.0.0.1:1"),
    })
    const probe = createRpcProbe(client)
    assert.equal(typeof probe.getChainId, "function")
    assert.equal(typeof probe.getCode, "function")
    assert.equal(typeof probe.readContract, "function")
  })
})

// ── Wiring: the gate must actually run, before any work ──────────────────────────────────────

describe("chain-verify — executor.js boots through the gate", () => {
  const executorSource = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")

  test("main() awaits verifyChainBinding with the configured chain and executor addresses", () => {
    assert.match(executorSource, /await verifyChainBinding\(\{/)
    assert.match(executorSource, /provider: createRpcProbe\(publicClient\)/)
    assert.match(executorSource, /chainId: CHAIN_ID/)
    assert.match(executorSource, /address: CONTRACT_ADDRESS/)
    assert.match(executorSource, /expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V2/)
  })

  test("a configured v3 executor is verified too, with the v3 expectation", () => {
    assert.match(executorSource, /address: V3_CONTRACT_ADDRESS/)
    assert.match(executorSource, /expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V3/)
  })

  test("the gate runs BEFORE the signer, the health server, the watcher and the first cycle", () => {
    const gate = executorSource.indexOf("await verifyChainBinding({")
    assert.ok(gate > 0, "verifyChainBinding is not called from executor.js")
    for (const after of [
      "await createExecutorAccount()",
      "startHealthServer()",
      "startEventWatcher(",
      "await executeCycle(",
    ]) {
      assert.ok(
        executorSource.indexOf(after, gate) > gate,
        `${after} must come after the chain-verification gate`,
      )
    }
  })

  test("the failure branch exits non-zero — there is no warn-and-continue", () => {
    const gate = executorSource.indexOf("await verifyChainBinding({")
    const window = executorSource.slice(gate, gate + 2_000)
    assert.match(window, /catch \(err\)/)
    assert.match(window, /process\.exit\(1\)/)
    assert.doesNotMatch(window, /console\.warn/)
  })
})
