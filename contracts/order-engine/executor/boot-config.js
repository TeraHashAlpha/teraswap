/**
 * boot-config.js — [FIX-KEEPER-MULTICHAIN-INSTANCE-IDENTITY] identity-bearing env, no defaults.
 *
 * PROBLEM. `const CHAIN_ID = parseInt(process.env.CHAIN_ID || "1")` made a keeper started WITHOUT
 * the variable a MAINNET keeper, silently, and `parseInt` made "8453abc" a Base keeper. With two
 * processes on one host (Base + Arbitrum One, each from its own env file — see env.js) a missing
 * or mistyped variable must be a loud refusal, never a guess: the chain id selects which orders
 * are polled (`chain_id=eq.${CHAIN_ID}`), which gas regime applies, which per-chain tables are
 * consulted and — via chain-verify.js — which chain the RPC must prove it is.
 *
 * This module is PURE (no process.env read, no I/O) so the rule is unit-testable in isolation;
 * executor.js applies it at module scope, before any client exists, and exits on `ok: false`.
 */

/**
 * Parse the raw CHAIN_ID env value. Accepts ONLY a base-10 positive safe integer (surrounding
 * whitespace tolerated). There is deliberately no default: `undefined`, "", junk suffixes, hex,
 * fractions, zero and negatives all refuse, naming the variable.
 *
 * @param {string|undefined} raw  process.env.CHAIN_ID, passed in
 * @returns {{ ok: true, chainId: number } | { ok: false, reason: string }}
 */
export function parseChainIdEnv(raw) {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "CHAIN_ID is not set — there is no default chain; set CHAIN_ID to the chain this keeper INSTANCE serves (e.g. 8453 for Base, 42161 for Arbitrum One)" }
  }
  const text = String(raw).trim()
  if (text === "") {
    return { ok: false, reason: "CHAIN_ID is empty — there is no default chain; set CHAIN_ID to the chain this keeper INSTANCE serves" }
  }
  if (!/^\d+$/.test(text)) {
    return { ok: false, reason: `CHAIN_ID is not a base-10 integer (received ${JSON.stringify(text)}) — refusing to guess a chain` }
  }
  const chainId = Number(text)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return { ok: false, reason: `CHAIN_ID is not a positive chain id (received ${JSON.stringify(text)})` }
  }
  return { ok: true, chainId }
}
