// submission-policy.js — pure fail-closed decision for HOW a DCA fill is
// submitted (pure, unit-tested; no I/O, never throws).
//
// [SPRINT-ORDER-ONCHAIN-FLOOR / P1a step 2] executor.js used
// `FLASHBOTS_RPC ? flashbotsWalletClient : walletClient` — a SILENT fallback to
// the public mempool whenever FLASHBOTS_RPC_URL was unset. On a public-mempool
// chain (Ethereum mainnet) that exposes every conditional-order fill to
// sandwiching, on a predictable schedule. This module makes the choice explicit
// and FAIL-CLOSED, mirroring the executor's plaintext-key guard:
//
//   - Base / OP-stack (8453): transactions go to a SINGLE sequencer whose
//     mempool is private (no public pending-tx gossip), so the classic retail
//     sandwich vector is absent. There is no Flashbots-equivalent on Base and
//     none is needed — submit via the sequencer ("sequencer-private"). The
//     residual (sequencer-level / cross-domain MEV) is covered by the
//     oracle-bounded floor (order-floor.js), not by a relay.
//   - Ethereum mainnet (1) / any unknown production chain: PUBLIC mempool. A
//     private relay (Flashbots Protect) is REQUIRED; with none configured the
//     fill is REFUSED unless the operator sets an explicit, documented override
//     (ALLOW_PUBLIC_MEMPOOL) — never a silent public submission.
//   - Testnets (Sepolia 11155111, Base Sepolia 84532): permissive — public is
//     fine for dev; no relay required.
//
// Base having a private sequencer mempool (vs the threat model's assumption of a
// naked public mempool) is documented in FEEDBACK.md and ADR-013.

/** OP-stack chains whose sequencer mempool is private (no public tx gossip). */
export const SEQUENCER_PRIVATE_CHAIN_IDS = new Set([8453 /* Base */])

/** Testnets — public submission is acceptable for development. Base Sepolia is
 *  also sequencer-private, but the testnet classification (permissive) wins. */
export const SUBMISSION_TESTNET_CHAIN_IDS = new Set([11155111 /* Sepolia */, 84532 /* Base Sepolia */])

/**
 * Decide the submission mode for a fill on `chainId`.
 * @param {object} p
 * @param {number|string} p.chainId
 * @param {boolean} p.hasPrivateRelay      FLASHBOTS_RPC_URL (or equivalent) configured
 * @param {boolean} p.allowPublicOverride  ALLOW_PUBLIC_MEMPOOL explicit override
 * @returns {{ mode: 'private'|'sequencer-private'|'public', ok: boolean, reason: string }}
 *   ok=false ⇒ do NOT submit (fail-closed): a public-mempool chain with no relay
 *   and no override.
 */
export function resolveSubmissionPolicy({ chainId, hasPrivateRelay, allowPublicOverride }) {
  const id = Number(chainId)

  // Testnets: permissive (dev). Public mempool is fine; no relay required.
  if (SUBMISSION_TESTNET_CHAIN_IDS.has(id)) {
    return { mode: "public", ok: true, reason: `testnet ${id}: public submission acceptable for dev` }
  }

  // Base / OP-stack: private sequencer mempool — no public gossip, submit via it.
  if (SEQUENCER_PRIVATE_CHAIN_IDS.has(id)) {
    return {
      mode: "sequencer-private",
      ok: true,
      reason: `chain ${id}: OP-stack sequencer mempool is private (no public pending-tx gossip) — classic sandwich vector absent; oracle floor covers residual`,
    }
  }

  // Ethereum mainnet + any unknown production chain: PUBLIC mempool. Require a
  // private relay or an explicit override — never submit public silently.
  if (hasPrivateRelay) {
    return { mode: "private", ok: true, reason: `chain ${id}: submitting via configured private relay` }
  }
  if (allowPublicOverride) {
    return {
      mode: "public",
      ok: true,
      reason: `chain ${id}: no private relay — submitting PUBLIC via explicit ALLOW_PUBLIC_MEMPOOL override (DANGEROUS: sandwichable)`,
    }
  }
  return {
    mode: "public",
    ok: false,
    reason: `chain ${id}: public-mempool chain with no private relay and no ALLOW_PUBLIC_MEMPOOL override — refusing to submit (fail-closed)`,
  }
}
