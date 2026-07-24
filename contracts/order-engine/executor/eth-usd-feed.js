/**
 * eth-usd-feed.js — chain-aware resolution of the keeper's ETH/USD Chainlink aggregator.
 *
 * [FIX-KEEPER-ETH-USD-FEED-CHAINAWARE] The keeper's ETH_USD_FEED default was hardcoded to the
 * MAINNET aggregator on EVERY chain. That is not just a freeze/low-gas-alert concern: readEthUsd
 * feeds fetchReferencePriceUsd, which is the ETH leg of the DCA Phase-0 oracle floor reference
 * (order-floor.js). On any non-mainnet chain with ETH_USD_FEED unset the keeper read a CODELESS
 * address, readEthUsd returned null, and the ETH leg silently lost its Chainlink-first price —
 * degrading to DefiLlama with no signal that anything was wrong. Prod is safe today (Base's
 * .env.executor sets ETH_USD_FEED; #345 added a 42161 code default) — this closes the latent trap
 * so a new chain, or a Base keeper redeployed from a fresh .env, cannot fall into it.
 *
 * Extracted as a pure module (no I/O, no clock, no env read of its own) because executor.js
 * auto-runs main() on import and so is not unit-testable — same reason gas-tier.js /
 * submission-policy.js / order-floor.js are separate.
 *
 * FAIL-CLOSED, never a wrong address: a chain with no known aggregator resolves to `null`, NOT to
 * some other chain's feed. The caller then skips the Chainlink read entirely and the existing
 * DefiLlama / no-reference fallback in fetchReferencePriceUsd takes over UNCHANGED (a missing
 * reference already flags the fill rather than filling it blind — see order-floor.js decideFloor
 * and decideFailOpen). A wrong address would be strictly worse than none: it reads as a plausible
 * price on a chain where it means nothing.
 */

export const MAINNET_CHAIN_ID = 1

/**
 * ETH/USD aggregator per chain. MIRRORS the app's source of truth — the keeper is a standalone
 * Node package and cannot import the app's TypeScript, so these are pinned against it by
 * eth-usd-feed.test.mjs, which parses the TS and fails on any drift:
 *
 *   1     -> src/lib/constants.ts            CHAINLINK_ETH_USD
 *   8453  -> src/lib/chains/chainlink-feeds.ts  CHAINLINK_FEEDS_BY_CHAIN[8453]  WETH -> ETH/USD
 *   42161 -> src/lib/chains/chainlink-feeds.ts  CHAINLINK_FEEDS_BY_CHAIN[42161] WETH -> ETH/USD
 *
 * Chain 1's value is the SAME literal the keeper hardcoded before this fix, so mainnet — with or
 * without ETH_USD_FEED set — resolves byte-identically.
 */
export const ETH_USD_FEED_BY_CHAIN = {
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
}

/**
 * Resolve which ETH/USD aggregator this keeper instance should read.
 *
 * Precedence is exactly the pre-fix expression's, with the mainnet tail replaced by a per-chain
 * lookup: `ETH_USD_FEED` env (verbatim, including a deliberately odd operator value) -> the
 * chain's known aggregator -> null. An empty-string env is treated as unset, matching the `||`
 * the keeper used before.
 *
 * @param {object} p
 * @param {number|string} p.chainId
 * @param {string|undefined} p.envFeed  process.env.ETH_USD_FEED, passed in (this module reads no env)
 * @returns {{ feed: string|null, source: 'env'|'chain-default'|'none', reason: string }}
 *   feed=null ⇒ do NOT attempt a Chainlink read; fall back to the existing reference path.
 */
export function resolveEthUsdFeed({ chainId, envFeed }) {
  if (envFeed) {
    return {
      feed: envFeed,
      source: "env",
      reason: `explicit ETH_USD_FEED override (chain ${chainId})`,
    }
  }

  const known = ETH_USD_FEED_BY_CHAIN[Number(chainId)]
  if (known) {
    return {
      feed: known,
      source: "chain-default",
      reason: `chain ${chainId} ETH/USD aggregator (mirrors src/lib/chains/chainlink-feeds.ts)`,
    }
  }

  return {
    feed: null,
    source: "none",
    reason:
      `no ETH/USD aggregator known for chain ${chainId} and ETH_USD_FEED is unset — ` +
      `skipping the Chainlink read (the ETH leg falls back to DefiLlama and the fill is flagged, ` +
      `never priced off another chain's feed). Set ETH_USD_FEED to fix.`,
  }
}
