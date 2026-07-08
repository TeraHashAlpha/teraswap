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

import { resolveSubmissionPolicy } from "./submission-policy.js"

describe("resolveSubmissionPolicy — Base (private sequencer mempool)", () => {
  test("Base mainnet (8453) with no relay submits via the private sequencer mempool", () => {
    const d = resolveSubmissionPolicy({ chainId: 8453, hasPrivateRelay: false, allowPublicOverride: false })
    assert.equal(d.ok, true)
    assert.equal(d.mode, "sequencer-private")
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
