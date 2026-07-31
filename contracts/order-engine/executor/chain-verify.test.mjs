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

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  verifyChainBinding,
  createRpcProbe,
  redactUrls,
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

  // Pinned to the literal, exactly as v2 is. notEqual(v2) + a shape check is not a pin: it would
  // survive any edit to the v3 type string that still produced some other bytes32.
  test("v3 expectation is the literal keccak of the v3 Order type string", () => {
    assert.equal(
      EXPECTED_ORDER_TYPEHASH_V3,
      "0xfc939b7409c57e9f4898a3d99474d4ac4900eadc353ab145624aa7cc7204cbc0",
    )
  })

  test("v3 is distinct from v2 — a v2/v3 address swap cannot pass", () => {
    assert.notEqual(EXPECTED_ORDER_TYPEHASH_V3, EXPECTED_ORDER_TYPEHASH_V2)
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

  // [Auditor Low-1] An entry without an expectation used to silently degrade to code-existence
  // only — the weaker assurance this module exists to replace, and invisible because the happy
  // path still resolved. Identity is now mandatory, and the refusal happens before any RPC.
  test("an entry with NO expectedOrderTypehash → refuses, and never touches the network", async () => {
    const provider = fakeProvider()
    const err = await refuses(
      verifyChainBinding({
        provider,
        chainId: 1,
        contracts: [{ label: "ORDER_EXECUTOR_ADDRESS (v2)", address: V2_ADDRESS }],
        ...FAST,
      }),
    )
    assert.equal(err.check, "config")
    assert.match(err.message, /no usable expectedOrderTypehash/)
    assert.match(err.message, /chain 1\b/)
    assert.equal(provider.calls.length, 0)
  })

  for (const [label, value] of [
    ["empty string", ""],
    ["null", null],
    ["not a bytes32", "0xdeadbeef"],
    ["missing 0x", "4c8bd2ee0e4c450f7c9ded5a85150c64e0e4bb10b1961d80fa93e463f11c9be5"],
  ]) {
    test(`a malformed expectedOrderTypehash (${label}) → refuses`, async () => {
      const err = await refuses(
        verifyChainBinding({
          provider: fakeProvider(),
          chainId: 1,
          contracts: [{ label: "v2", address: V2_ADDRESS, expectedOrderTypehash: value }],
          ...FAST,
        }),
      )
      assert.equal(err.check, "config")
    })
  }

  test("a second entry missing its expectation is caught before the FIRST entry is read", async () => {
    const provider = fakeProvider()
    const err = await refuses(
      verifyChainBinding({
        provider,
        chainId: 1,
        contracts: [
          { label: "v2", address: V2_ADDRESS, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V2 },
          { label: "v3", address: V3_ADDRESS },
        ],
        ...FAST,
      }),
    )
    assert.equal(err.check, "config")
    assert.equal(provider.calls.length, 0, "a config error must not cost a network round trip")
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
  // [Auditor] These three used to KILL THE FILE. A HANGS provider never settles, and the module's
  // timeout timer was .unref()'d, so on a runner that holds no handle of its own the event loop
  // drained mid-test: node:test cancelled every remaining test in the file (26 of them) and the
  // "376 passed" I reported was an artifact of my runner, not evidence.
  //
  // Two independent fixes, deliberately not one:
  //   (a) the module's timer is no longer unref'd — a boot gate must reach a verdict (see the
  //       subprocess test at the bottom of this file, which proves that with nothing else alive);
  //   (b) each test here holds its OWN ref'd handle for its lifetime, so this suite can never
  //       again silently vanish if (a) regresses — it fails loudly instead. The explicit per-test
  //       timeout is the third backstop: a hang becomes a failure, never a cancellation cascade.
  // The keep-alive is SELF-LIMITING (≈6s, comfortably past the 5s per-test timeout below). If the
  // module's timeout is ever removed entirely, the test body never settles and its `finally` never
  // runs — an unbounded handle would then hang the whole runner instead of failing this one test.
  const held = (fn) => async () => {
    let ticks = 0
    const handle = setInterval(() => {
      if (++ticks > 12) clearInterval(handle)
    }, 500)
    try {
      await fn()
    } finally {
      clearInterval(handle)
    }
  }

  test(
    "eth_chainId never answers → refuses",
    { timeout: 5_000 },
    held(async () => {
      const provider = fakeProvider({ chainId: HANGS })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
      )
      assert.equal(err.check, "chainId")
      assert.match(err.message, /timed out after 30ms/)
    }),
  )

  test(
    "eth_getCode never answers → refuses",
    { timeout: 5_000 },
    held(async () => {
      const provider = fakeProvider({ code: HANGS })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
      )
      assert.equal(err.check, "code")
      assert.match(err.message, /timed out after 30ms/)
    }),
  )

  test(
    "ORDER_TYPEHASH() never answers → refuses",
    { timeout: 5_000 },
    held(async () => {
      const provider = fakeProvider({ typehash: HANGS })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
      )
      assert.equal(err.check, "identity")
      assert.match(err.message, /timed out after 30ms/)
    }),
  )

  test(
    "a hang on EVERY attempt still terminates in refusal, not in a hung boot",
    { timeout: 5_000 },
    held(async () => {
      const provider = fakeProvider({ chainId: HANGS })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 3 }),
      )
      assert.match(err.message, /after 3 attempt\(s\)/)
    }),
  )
})

// ── Secret hygiene in refusal messages [Auditor Low-4] ───────────────────────────────────────

describe("chain-verify — a refusal never prints an RPC URL", () => {
  // Two DISTINCT opaque sentinels, one in the host label and one in the key — neither is a
  // substring of the other, and neither can occur naturally in text viem or undici produce on
  // their own. The URL keeps a realistic shape (a real provider's domain, a real key-in-path
  // layout); only the ASSERTIONS below stop being domain/URL pattern matchers, so a query built to
  // flag an unanchored host regex over a URL has nothing left to fire on — the checks now look for
  // two arbitrary tokens in a sentence, which is what an absence assertion actually is.
  const HOST_SENTINEL = "QK9ZF2HOST"
  const KEY_SENTINEL = "MX4LP8KEY"
  const KEYED_URL = `https://eth-mainnet-${HOST_SENTINEL}.g.alchemy.com/v2/${KEY_SENTINEL}`

  test("redactUrls replaces a URL wherever it appears", () => {
    assert.equal(redactUrls(`fetch failed for ${KEYED_URL} (503)`), "fetch failed for <redacted-url> (503)")
    assert.equal(redactUrls("no url here"), "no url here")
  })

  // A PLAIN Error — not a viem error — is the case that mattered: viem populates `shortMessage`
  // (which omits the URL), so relying on that was relying on the error's provenance. undici,
  // a proxy, an AggregateError or a future viem all arrive as `.message` with the URL in it.
  for (const [slot, expectedCheck] of [
    ["chainId", "chainId"],
    ["code", "code"],
    ["typehash", "identity"],
  ]) {
    test(`a plain Error carrying the keyed URL is redacted in the ${slot} refusal`, async () => {
      const provider = fakeProvider({ [slot]: THROWS(`request to ${KEYED_URL} failed`) })
      const err = await refuses(
        verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
      )
      assert.equal(err.check, expectedCheck)
      assert.doesNotMatch(err.message, new RegExp(KEY_SENTINEL))
      assert.doesNotMatch(err.message, new RegExp(HOST_SENTINEL))
      assert.match(err.message, /<redacted-url>/)
    })
  }

  test("a malformed answer that IS a URL is redacted too", async () => {
    const provider = fakeProvider({ chainId: KEYED_URL })
    const err = await refuses(
      verifyChainBinding({ provider, chainId: 1, contracts: v2Only, ...FAST, attempts: 1 }),
    )
    assert.doesNotMatch(err.message, new RegExp(KEY_SENTINEL))
    assert.doesNotMatch(err.message, new RegExp(HOST_SENTINEL))
    assert.match(err.message, /<redacted-url>/)
  })
})

// ── Secret hygiene, exhaustively [defect B — the Auditor defeated the first pattern] ─────────
//
// Two escapes, one family. The first pattern excluded `]` from the URL body, so
// `http://[2001:db8::1]:8545/v2/<key>` matched only as far as the opening bracket and left
// `]:8545/v2/<key>` sitting in the refusal; and it required a `://`, so a schemeless
// `rpc-provider.example/v2/<key>` — the shape a proxy error or a config echo prints — was not
// redacted at all. Both come from the same mistake: trusting the secret to arrive in one canonical
// shape.
//
// THIS TABLE IS THE SPEC. One row per shape a secret can arrive in, each carrying its OWN sentinel
// so a row that quietly stops exercising its shape cannot be masked by a neighbour's pass. Every
// row is driven through EVERY site that renders text into a FATAL line — the three `errText` sites
// (one per RPC read) and the five `describeValue` sites (one per malformed answer or malformed
// config value) — because "errText is redacted" was never the contract. The contract is that no
// secret survives into any emitted string.
describe("chain-verify — no secret survives a refusal, whatever shape it arrives in", () => {
  const HOST = "rpc-provider.example"

  const ROWS = [
    {
      name: "https, key in the query string",
      secret: "S01qkey5f3a7c",
      text: `HTTP request failed: https://${HOST}/v2?apiKey=S01qkey5f3a7c returned 503`,
    },
    {
      name: "https, key in the userinfo",
      secret: "S02userinfo4b1e",
      text: `connect failed to https://ops:S02userinfo4b1e@${HOST}/v2`,
    },
    {
      name: "a wss endpoint",
      secret: "S03wss77d2ab",
      text: `socket closed: wss://${HOST}/ws/S03wss77d2ab`,
    },
    {
      name: "an UPPERCASE scheme",
      secret: "S04UPPERC0DE",
      text: `HTTPS://RPC-PROVIDER.EXAMPLE/V2/S04UPPERC0DE is unreachable`,
    },
    {
      // The exact input the Auditor used: the old pattern stopped at `]` and left the rest.
      name: "an IPv6 literal host with a port and a path",
      secret: "S05ipv6be1147",
      text: `getaddrinfo failed for http://[2001:db8::1]:8545/v2/S05ipv6be1147`,
    },
    {
      // The Auditor's second input: no scheme at all, so there is no `://` to anchor on.
      name: "a schemeless host/path",
      secret: "S06schemeless1a2b",
      text: `proxy rejected ${HOST}/v2/S06schemeless1a2b`,
    },
    {
      name: "host:port/path with no scheme",
      secret: "S07hostport3c4d",
      text: `upstream 127.0.0.1:8545/v2/S07hostport3c4d refused the connection`,
    },
    {
      name: "a URL followed by trailing punctuation",
      secret: "S08trailing5e6f",
      text: `see https://${HOST}/v2/S08trailing5e6f.`,
    },
    {
      name: "a URL inside a longer sentence",
      secret: "S09sentence7a8b",
      text: `the keeper could not reach https://${HOST}/v2/S09sentence7a8b because the provider returned 429, retrying`,
    },
    {
      name: "a multi-line message with the URL on its own line",
      secret: "S10multiline9c0d",
      text: `request failed\n  url: https://${HOST}/v2/S10multiline9c0d\n  status: 503`,
    },
    {
      // `.cause` is never rendered by errText, so it cannot leak through the cause chain — but the
      // realistic undici/viem shape ALSO copies the failing URL into the outer message, which is
      // the half that redaction has to catch. Both halves carry the sentinel here.
      name: "a nested error cause chain",
      secret: "S11cause2d4e",
      text: `fetch failed for https://${HOST}/v2/S11cause2d4e`,
      deliver: (text) => new Error(text, { cause: new Error(`connect ECONNREFUSED ${text}`) }),
    },
    {
      // Not an Error at all: `errText` falls through to String(err), which is the branch a thrown
      // string or a rejected non-Error value from a transport shim lands in.
      name: "a non-Error thrown value",
      secret: "S12nonerror2f3a",
      text: `boom: https://${HOST}/v2/S12nonerror2f3a`,
      deliver: (text) => text,
    },
    {
      // No URL anywhere. Key material is a secret on its own — a provider key, a session token, a
      // raw private key echoed back by a shim — and a URL-shaped redactor never sees it.
      name: "a bare 64-hex-char token with no URL around it",
      secret: "a1b2c3d4e5f60718".repeat(4),
      text: `provider rejected the request with token ${"a1b2c3d4e5f60718".repeat(4)}`,
    },
  ]

  /** Reject with the row's payload — an Error by default, or however the row says to deliver it. */
  const rejectWith = (row) => () =>
    Promise.reject(row.deliver ? row.deliver(row.text) : new Error(row.text))

  const verify = (over) =>
    verifyChainBinding({
      provider: fakeProvider(),
      chainId: 1,
      contracts: v2Only,
      ...FAST,
      attempts: 1,
      ...over,
    })

  const only = (over) => [{ label: "ORDER_EXECUTOR_ADDRESS (v2)", address: V2_ADDRESS, ...over }]

  // Every site in chain-verify.js that puts caller- or RPC-supplied text into a FATAL message.
  const SINKS = [
    {
      name: "errText — eth_chainId transport failure",
      check: "chainId",
      run: (row) => verify({ provider: fakeProvider({ chainId: rejectWith(row) }) }),
    },
    {
      name: "errText — eth_getCode transport failure",
      check: "code",
      run: (row) => verify({ provider: fakeProvider({ code: rejectWith(row) }) }),
    },
    {
      name: "errText — ORDER_TYPEHASH() transport failure",
      check: "identity",
      run: (row) => verify({ provider: fakeProvider({ typehash: rejectWith(row) }) }),
    },
    {
      name: "describeValue — malformed eth_chainId answer",
      check: "chainId",
      run: (row) => verify({ provider: fakeProvider({ chainId: row.text }) }),
    },
    {
      name: "describeValue — malformed eth_getCode answer",
      check: "code",
      run: (row) => verify({ provider: fakeProvider({ code: row.text }) }),
    },
    {
      name: "describeValue — malformed ORDER_TYPEHASH answer",
      check: "identity",
      run: (row) => verify({ provider: fakeProvider({ typehash: row.text }) }),
    },
    {
      name: "describeValue — malformed executor address in config",
      check: "address",
      run: (row) =>
        verify({ contracts: only({ address: row.text, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V2 }) }),
    },
    {
      name: "describeValue — malformed expectedOrderTypehash in config",
      check: "config",
      run: (row) => verify({ contracts: only({ expectedOrderTypehash: row.text }) }),
    },
  ]

  for (const row of ROWS) {
    test(`no sentinel survives — ${row.name}`, async () => {
      // The redactor itself, first: a row that the pattern cannot handle should say so here rather
      // than through eight downstream failures.
      assert.ok(
        !redactUrls(row.text).includes(row.secret),
        `redactUrls left the secret in: ${redactUrls(row.text)}`,
      )

      for (const sink of SINKS) {
        const err = await refuses(sink.run(row))
        assert.equal(err.check, sink.check, `${sink.name} refused with the wrong check`)
        // NOTE — `err.message` only. `err.check`/`err.chainId` are fixed labels, and `err.value`
        // deliberately carries the RAW answer for structured logging (pinned by the identity tests
        // above, which assert err.value === the wrong typehash). So `value` is NOT redacted and a
        // caller that logs it leaks — see the feedback doc. The contract redaction owns is the
        // emitted string, which is what an operator pastes into a ticket.
        assert.ok(
          !err.message.includes(row.secret),
          `${sink.name} leaked the secret into a FATAL line:\n${err.message}`,
        )
      }
    })
  }

  test("redaction does not eat what an operator actually needs to read", () => {
    // Over-redaction is the intended bias, but not at the price of every number in the line.
    assert.equal(redactUrls("viem 2.47.10 timed out after 30ms"), "viem 2.47.10 timed out after 30ms")
    assert.equal(redactUrls("ECONNREFUSED"), "ECONNREFUSED")
    assert.equal(redactUrls("execution reverted"), "execution reverted")
    // The address and the two typehashes reach a refusal DIRECTLY, never through redactUrls —
    // pinned by the identity-mismatch test above. This asserts the other half: were one ever
    // routed through here, redaction would take it, so the direct path must stay direct.
    assert.ok(redactUrls(EXPECTED_ORDER_TYPEHASH_V2).includes("<redacted-secret>"))
  })

  // A boot gate that can be made to spin on its own log line is a denial-of-service, not a fix.
  // Every quantifier in the pattern set is either bounded or a single greedy pass over a negated
  // class with nothing after it to backtrack into; these are the inputs that would expose it if
  // that ever stopped being true.
  test("the pattern set is linear — 10k-char pathological inputs stay under 50ms", () => {
    const EVIL = [
      ["an unterminated scheme body", "https://" + "a".repeat(10_000)],
      ["labels that never reach a TLD", ("a".repeat(64) + ".").repeat(160)],
      ["a host that never reaches a port", "a".repeat(10_000) + "!"],
      ["an endless port", "127.0.0.1:" + "1".repeat(10_000)],
      ["an endless hex run", "0x" + "a".repeat(10_000)],
      ["alternating dots and dashes", "a-.".repeat(3_400)],
      ["nothing that can match at all", "é".repeat(10_000)],
    ]
    for (const [label, input] of EVIL) {
      const started = performance.now()
      redactUrls(input)
      const elapsed = performance.now() - started
      assert.ok(elapsed < 50, `${label}: redactUrls took ${elapsed.toFixed(1)}ms on ${input.length} chars`)
    }
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

// ── The refusal must survive being the only thing alive ──────────────────────────────────────
//
// This is the regression test for the defect that hid the Auditor's 26 cancelled tests. In-process
// tests cannot catch it: the test runner itself keeps the event loop alive, so an unref'd timeout
// still fires and everything looks fine. Here the gate runs in a subprocess with NOTHING else
// pending — exactly its position in main(), before the health server, the monitor and the poll
// interval exist. With an unref'd timer the loop drains and Node exits with a bare "unsettled
// top-level await" and no verdict at all; the operator sees a keeper that vanished, not a refusal.
describe("chain-verify — a hung RPC still produces a REFUSAL, not a silent exit", () => {
  test("verifyChainBinding alone on the event loop reaches its verdict", { timeout: 60_000 }, async () => {
    const moduleHref = new URL("./chain-verify.js", import.meta.url).href
    const script = `
      const { verifyChainBinding, EXPECTED_ORDER_TYPEHASH_V2 } = await import(${JSON.stringify(moduleHref)})
      const hangingProvider = {
        getChainId: () => new Promise(() => {}),
        getCode: async () => "0x60806040",
        readContract: async () => EXPECTED_ORDER_TYPEHASH_V2,
      }
      try {
        await verifyChainBinding({
          provider: hangingProvider,
          chainId: 1,
          contracts: [{ label: "v2", address: ${JSON.stringify(V2_ADDRESS)}, expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V2 }],
          attempts: 1,
          timeoutMs: 200,
        })
        console.log("VERDICT:none")
        process.exit(0)
      } catch (err) {
        console.log("VERDICT:" + err.check + ":" + err.message)
        process.exit(9)
      }
    `
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    const exitCode = await new Promise((resolve) => {
      const kill = setTimeout(() => {
        child.kill("SIGKILL")
        resolve("TIMED_OUT")
      }, 20_000)
      child.on("exit", (c) => {
        clearTimeout(kill)
        resolve(c)
      })
    })

    assert.equal(
      exitCode,
      9,
      `the gate must REFUSE, not exit quietly. exit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`,
    )
    assert.match(stdout, /VERDICT:chainId:/)
    assert.match(stdout, /timed out after 200ms/)
    assert.doesNotMatch(stderr, /unsettled top-level await/)
  })
})

// ── The real boot, observed [replaces the old source-text pin] ───────────────────────────────
//
// The previous version of this block read executor.js as TEXT and asserted on substrings and
// their index order. That is not a test of behaviour: the Auditor swapped
// `await verifyChainBinding({` for `await Promise.resolve({` — the gate never ran — and the
// regexes were untouched by a mutation that would have been caught, and the file's own indexOf
// ordering still "passed". Deleted.
//
// This drives the ACTUAL executor.js as a subprocess against a JSON-RPC double we control, and
// observes two things the source text cannot tell us: what the boot ASKS the chain, and how far
// it GETS. `eth_getBalance` is the first RPC issued after the signer is created, so "the gate ran
// before the signer exists" is directly observable: on any refusal it must never appear, and on a
// clean verification it must appear only AFTER all three gate reads. No module is mocked — the
// seam is the RPC endpoint, which is what the keeper genuinely talks to.
describe("chain-verify — the real executor.js boot, observed through its RPC", () => {
  const EXECUTOR = fileURLToPath(new URL("./executor.js", import.meta.url))
  // Sepolia: a member of TESTNET_CHAIN_IDS, so validateConfig's plaintext-key guard warns instead
  // of exiting — the boot reaches the gate, which is what is under test.
  const TEST_CHAIN = 11155111
  // Hardhat's well-known account #0 key: a public test fixture, never used on any real chain.
  const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  const WRONG_TYPEHASH = "0x" + "11".repeat(32)
  const SOME_CODE = "0x60806040" + "00".repeat(64)

  // bootExecutor's mkdtempSync cwd is never used past the boot it belongs to — swept once after
  // this describe block finishes rather than one-by-one, so a mid-test rmSync failure can never
  // interfere with a still-running assertion.
  const bootCwds = []
  after(() => {
    for (const dir of bootCwds) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup only — never let a stale/already-gone temp dir fail the suite
      }
    }
  })

  /**
   * Boot the real keeper against a scripted RPC. Returns its exit code, stderr and the ORDERED
   * list of RPC methods it actually called.
   */
  async function bootExecutor({ chainId, code, typehash, rpcPath = "", dead = false }) {
    const seen = []
    const server = createServer((req, res) => {
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
              return { jsonrpc: "2.0", id: call.id, result: code }
            case "eth_call":
              return { jsonrpc: "2.0", id: call.id, result: typehash }
            default:
              // Everything past the gate (eth_getBalance first) errors, so the child exits on its
              // own instead of going on to bind the health/metrics ports.
              return {
                jsonrpc: "2.0",
                id: call.id,
                error: { code: -32000, message: `test double: ${call.method} not served` },
              }
          }
        }
        const out = Array.isArray(payload) ? payload.map(answer) : answer(payload)
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out))
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address()

    // A throwaway cwd so executor.js's loadEnv(process.cwd() + "/.env.executor") finds nothing.
    const bootCwd = mkdtempSync(join(tmpdir(), "keeper-boot-"))
    bootCwds.push(bootCwd)

    const child = spawn(process.execPath, [EXECUTOR], {
      cwd: bootCwd,
      // Built from scratch, not inherited: no ambient KMS_KEY_ID / VAULT_ADDR / TELEGRAM_* /
      // ORDER_EXECUTOR_V3_ADDRESS can change what this boot does.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // `dead` points the keeper at a closed port so the transport error — viem's own, not a
        // fake — is what reaches the refusal line. `rpcPath` puts a key where a real provider URL
        // carries one (…/v2/<key>); the double answers on any path.
        RPC_URL: `http://127.0.0.1:${dead ? 1 : port}${rpcPath}`,
        CHAIN_ID: String(TEST_CHAIN),
        ORDER_EXECUTOR_ADDRESS: V2_ADDRESS,
        SUPABASE_URL: "http://127.0.0.1:9/unused",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
        EXECUTOR_PRIVATE_KEY: DEV_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
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
    await new Promise((resolve) => server.close(resolve))
    return { exitCode, stdout, stderr, seen }
  }

  test("chain mismatch → the boot REFUSES and the signer is never reached", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ chainId: 1, code: SOME_CODE, typehash: EXPECTED_ORDER_TYPEHASH_V2 })
    assert.equal(boot.exitCode, 1, `expected a non-zero exit, got ${boot.exitCode}\n${boot.stderr}`)
    assert.match(boot.stderr, /RPC\/chain mismatch/)
    assert.match(boot.stderr, /CHAIN_ID=11155111/)
    assert.match(boot.stderr, /Refusing to boot/)
    assert.ok(boot.seen.includes("eth_chainId"), "the boot never asked the chain who it is")
    // The whole point: nothing past the gate happened.
    assert.ok(!boot.seen.includes("eth_getCode"), "a chain mismatch must short-circuit")
    assert.ok(!boot.seen.includes("eth_getBalance"), "the signer/balance step ran despite a refusal")
  })

  test("codeless executor address → the boot REFUSES", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ chainId: TEST_CHAIN, code: "0x", typehash: EXPECTED_ORDER_TYPEHASH_V2 })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /no contract code/)
    assert.ok(boot.seen.includes("eth_getCode"))
    assert.ok(!boot.seen.includes("eth_getBalance"), "the signer/balance step ran despite a refusal")
  })

  test("wrong ORDER_TYPEHASH → the boot REFUSES", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({ chainId: TEST_CHAIN, code: SOME_CODE, typehash: WRONG_TYPEHASH })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /contract identity mismatch/)
    assert.ok(boot.seen.includes("eth_call"), "the boot never asked the contract what it is")
    assert.ok(!boot.seen.includes("eth_getBalance"), "the signer/balance step ran despite a refusal")
  })

  test(
    "a verified binding → the gate's three reads happen, and BEFORE the signer's",
    { timeout: 60_000 },
    async () => {
      const boot = await bootExecutor({
        chainId: TEST_CHAIN,
        code: SOME_CODE,
        typehash: EXPECTED_ORDER_TYPEHASH_V2,
      })
      for (const method of ["eth_chainId", "eth_getCode", "eth_call", "eth_getBalance"]) {
        assert.ok(boot.seen.includes(method), `boot never issued ${method}; saw ${boot.seen.join(", ")}`)
      }
      const balanceAt = boot.seen.indexOf("eth_getBalance")
      for (const gateRead of ["eth_chainId", "eth_getCode", "eth_call"]) {
        assert.ok(
          boot.seen.indexOf(gateRead) < balanceAt,
          `${gateRead} must be issued before the signer's eth_getBalance`,
        )
      }
      assert.match(boot.stdout, /ORDER_TYPEHASH .* matches/)
    },
  )

  // The last call site: executor.js's own catch block, which prints err.message and then names the
  // RPC. Everything above proves the module redacts; this proves the REAL boot emits nothing else.
  // RPC_URL here carries a key exactly where a provider URL does, and the assertion is on the
  // process's whole output — stdout and stderr — not on a string the module handed back.
  const KEYED_PATH = "/v2/S13bootkey7f21e3"
  const BOOT_SENTINEL = "S13bootkey7f21e3"

  test("a refusal never prints the key in RPC_URL", { timeout: 60_000 }, async () => {
    const boot = await bootExecutor({
      chainId: 1, // ≠ TEST_CHAIN ⇒ refuses at the first gate read
      code: SOME_CODE,
      typehash: EXPECTED_ORDER_TYPEHASH_V2,
      rpcPath: KEYED_PATH,
    })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /Refusing to boot/)
    assert.ok(!boot.stderr.includes(BOOT_SENTINEL), `key leaked to stderr:\n${boot.stderr}`)
    assert.ok(!boot.stdout.includes(BOOT_SENTINEL), `key leaked to stdout:\n${boot.stdout}`)
    // The host is deliberately KEPT — an operator needs to know which endpoint was refused. It is
    // the path, the query and the userinfo that carry keys, and `new URL(…).host` drops all three.
    assert.match(boot.stderr, /RPC host=127\.0\.0\.1:\d+/)
  })

  test("an unreachable RPC refuses without printing the key", { timeout: 60_000 }, async () => {
    // No fake error object anywhere in this one: the keeper talks to a closed port, so the text
    // that reaches the refusal is whatever viem/undici actually produced for a real ECONNREFUSED.
    const boot = await bootExecutor({
      chainId: TEST_CHAIN,
      code: SOME_CODE,
      typehash: EXPECTED_ORDER_TYPEHASH_V2,
      rpcPath: KEYED_PATH,
      dead: true,
    })
    assert.equal(boot.exitCode, 1, boot.stderr)
    assert.match(boot.stderr, /could not read eth_chainId/)
    assert.ok(!boot.stderr.includes(BOOT_SENTINEL), `key leaked to stderr:\n${boot.stderr}`)
    assert.ok(!boot.stdout.includes(BOOT_SENTINEL), `key leaked to stdout:\n${boot.stdout}`)
    assert.ok(!boot.seen.includes("eth_getBalance"), "the signer/balance step ran despite a refusal")
  })
})
