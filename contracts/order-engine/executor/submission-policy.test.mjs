// Tests for submission-policy.js — the pure fail-closed decision for HOW a DCA
// fill is submitted (private relay vs Base sequencer-private mempool vs public).
//
// [SPRINT-ORDER-ONCHAIN-FLOOR / P1a step 2] executor.js:1188 silently fell back
// to the PUBLIC mempool whenever FLASHBOTS_RPC_URL was unset. On a public-mempool
// chain (Ethereum mainnet) that exposes every fill to sandwiching. This gate
// makes the choice explicit and FAIL-CLOSED (mirrors the plaintext-key guard):
// a public-mempool chain with no private relay refuses to submit unless an
// operator sets an explicit override. Base (OP-stack) routes to a single
// sequencer whose mempool is private (no public pending-tx gossip), so the
// classic retail sandwich vector is absent there — it submits normally.
//
// Pure, never-throwing, no I/O. Test-first (module written after this file).

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { resolveSubmissionPolicy, SEQUENCER_PRIVATE_CHAIN_IDS } from "./submission-policy.js"

describe("resolveSubmissionPolicy — Base (private sequencer mempool)", () => {
  test("Base mainnet (8453) with no relay submits via the private sequencer mempool", () => {
    const d = resolveSubmissionPolicy({ chainId: 8453, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "sequencer-private")
  })
})

// [SPRINT-KEEPER-MULTICHAIN-ARBITRUM] Arbitrum One is Nitro/ArbOS, not OP-stack, but shares the
// property this gate cares about: ONE centralized sequencer, no public pending-tx gossip, no
// Flashbots-equivalent relay. Nitro orders first-come-first-served, so there is not even a
// tip-reordering surface. It must therefore submit NORMALLY (sequencer-private) and must NEVER be
// classified as a public-mempool chain.
describe("resolveSubmissionPolicy — Arbitrum One (42161, Nitro sequencer)", () => {
  test("42161 with no relay submits via the private sequencer mempool — same class as Base", () => {
    const d = resolveSubmissionPolicy({ chainId: 42161, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "sequencer-private")
  })

  test("42161 is NEVER a public-mempool path — no MEV exposure, under any relay/override combo", () => {
    for (const hasPrivateRelay of [true, false]) {
      for (const allowPublicOverride of [true, false]) {
        const d = resolveSubmissionPolicy({ chainId: 42161, hasPrivateRelay, allowPublicOverride })
        assert.notEqual(d.mode, "public", `relay=${hasPrivateRelay} override=${allowPublicOverride} must not be public`)
        assert.equal(d.mode, "sequencer-private")
        assert.equal(d.ok, true)
      }
    }
  })

  test("REGRESSION: 42161 never fail-closes for want of a relay (the pre-sprint unknown-chain path)", () => {
    // Before this sprint 42161 fell through to "unknown production chain ⇒ public-mempool", so a
    // keeper with no FLASHBOTS_RPC_URL would have REFUSED every Arbitrum fill.
    const d = resolveSubmissionPolicy({ chainId: 42161, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true, "an Arbitrum keeper must not need a relay it cannot have")
    assert.match(d.reason, /Arbitrum Nitro/)
  })

  test("a string chainId '42161' is coerced (env-shaped input never throws)", () => {
    const d = resolveSubmissionPolicy({ chainId: "42161", hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "sequencer-private")
  })

  test("42161 is a member of the exported SEQUENCER_PRIVATE_CHAIN_IDS set", () => {
    assert.ok(SEQUENCER_PRIVATE_CHAIN_IDS.has(42161))
    assert.ok(SEQUENCER_PRIVATE_CHAIN_IDS.has(8453), "Base must still be a member")
  })
})

describe("[SPRINT-KEEPER-MULTICHAIN-ARBITRUM] adding 42161 left chains 1 and 8453 BYTE-IDENTICAL", () => {
  test("Base's decision object is unchanged down to the reason string", () => {
    assert.deepEqual(
      resolveSubmissionPolicy({ chainId: 8453, hasPrivateRelay: false, allowPublicOverride: false }),
      {
        mode: "sequencer-private",
        ok: true,
        reason:
          "chain 8453: OP-stack sequencer mempool is private (no public pending-tx gossip) — classic sandwich vector absent; oracle floor covers residual",
      },
    )
  })

  test("mainnet (1) still fail-closes without a relay, and still uses one when present", () => {
    assert.deepEqual(resolveSubmissionPolicy({ chainId: 1, hasPrivateRelay: false, allowPublicOverride: false }), {
      mode: "public",
      ok: false,
      reason:
        "chain 1: public-mempool chain with no private relay and no ALLOW_PUBLIC_MEMPOOL override — refusing to submit (fail-closed)",
    })
    assert.deepEqual(resolveSubmissionPolicy({ chainId: 1, hasPrivateRelay: true, allowPublicOverride: false }), {
      mode: "private",
      ok: true,
      reason: "chain 1: submitting via configured private relay",
    })
  })

  test("an unknown production chain is STILL treated as public-mempool (42161 was carved out explicitly, not by widening the fallback)", () => {
    const d = resolveSubmissionPolicy({ chainId: 42170, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, false)
    assert.equal(d.mode, "public")
  })
})

describe("resolveSubmissionPolicy — public-mempool chains fail closed", () => {
  test("Ethereum mainnet (1) with a private relay uses it", () => {
    const d = resolveSubmissionPolicy({ chainId: 1, hasPrivateRelay: true, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "private")
  })

  test("Ethereum mainnet (1) with NO relay and NO override is REFUSED (fail-closed, not public)", () => {
    const d = resolveSubmissionPolicy({ chainId: 1, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, false)
    assert.equal(d.mode, "public")
  })

  test("Ethereum mainnet (1) with NO relay but an EXPLICIT override submits public (dangerous, allowed)", () => {
    const d = resolveSubmissionPolicy({ chainId: 1, hasPrivateRelay: false, allowPublicOverride: true })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "public")
  })

  test("an UNKNOWN production chain is treated as public-mempool ⇒ fail-closed without a relay", () => {
    const d = resolveSubmissionPolicy({ chainId: 999999, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, false)
  })
})

describe("resolveSubmissionPolicy — testnets are permissive (dev)", () => {
  test("Sepolia (11155111) submits public without a relay", () => {
    const d = resolveSubmissionPolicy({ chainId: 11155111, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "public")
  })

  test("Base Sepolia (84532) submits public without a relay", () => {
    const d = resolveSubmissionPolicy({ chainId: 84532, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
  })
})

describe("resolveSubmissionPolicy — pure/deterministic", () => {
  test("repeated calls are identical and never throw", () => {
    const args = { chainId: 1, hasPrivateRelay: false, allowPublicOverride: false }
    const first = resolveSubmissionPolicy(args)
    for (let i = 0; i < 25; i++) assert.deepEqual(resolveSubmissionPolicy(args), first)
  })

  test("a string chainId is coerced (never throws on env-shaped input)", () => {
    const d = resolveSubmissionPolicy({ chainId: "8453", hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "sequencer-private")
  })
})
