/**
 * [P218 / ADR-009] Per-chain Chainlink feed registry.
 *
 * Mainnet (chainId 1) REFERENCES the existing CHAINLINK_FEEDS map in
 * constants.ts (token-address → feed-proxy), so the mainnet feed set is
 * guaranteed identical. Base feeds are keyed by Base token address.
 *
 * Conservative population per the prompt Do-NOT: only feeds verified on
 * data.chain.link are included. A missing feed falls through to null (then
 * DefiLlama / fail-safe), which is far safer than a wrong feed address.
 */
import { CHAINLINK_FEEDS, CHAINLINK_ETH_USD, NATIVE_ETH, WETH_ADDRESS } from '../constants'
import { getChainConfig, DEFAULT_CHAIN_ID } from './registry'

export const CHAINLINK_FEEDS_BY_CHAIN: Record<number, Record<string, `0x${string}`>> = {
  // Mainnet — reuse the canonical map (token address → feed proxy).
  1: CHAINLINK_FEEDS,
  // Base (8453) — keyed by Base token address (lowercased; getChainlinkFeed lowercases the lookup).
  // [SPRINT-9S S1 / rule #9] EACH feed verified 3 independent ways — wrong address = wrong
  // validation, so no guessing:
  //   (1) Chainlink reference-data-directory (official feeds-ethereum-mainnet-base-1.json)
  //   (2) on-chain description() + decimals() read on Base mainnet (cast)
  //   (3) BaseScan cross-reference (EACAggregatorProxy, Chainlink deployer)
  8453: {
    // WETH → ETH/USD   description() "ETH / USD", decimals() 8
    '0x4200000000000000000000000000000000000006': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    // USDC → USDC/USD  description() "USDC / USD", decimals() 8  [SPRINT-9S S1]
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '0x458138Fc0D67027E9A6778ef40a6ffC318c69061',
    // DAI  → DAI/USD   description() "DAI / USD", decimals() 8   [SPRINT-9S S1]
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': '0x591e79239a7d679378eC8c847e5038150364C78F',
    // NOT mapped, by design (rule #9 — a wrong feed mis-prices swaps):
    //  • cbETH (0x2Ae3…0DEc22): Chainlink publishes only cbETH/ETH on Base (description()
    //    "CBETH / ETH", 18 dp — ETH-denominated). Dropping it into this USD-keyed map would
    //    read ~1.08 as "$1.08". Correct support needs cbETH/ETH × ETH/USD composition, which
    //    is a validation-layer feature beyond this map (see FEEDBACK 9S — follow-up).
    //  • USDbC (0xd9aA…b6CA): no Chainlink feed exists on Base (absent from the directory).
    //  Both correctly fall through to null → multi-source compare + on-chain minimumOutput.
  },
}

/**
 * Resolve the Chainlink feed-proxy address for a token on a given chain.
 * Defaults to mainnet (chainId 1), whose path is byte-identical to the legacy
 * getChainlinkFeed in chainlink.ts.
 */
export function getChainlinkFeed(
  tokenAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): `0x${string}` | null {
  const addr = tokenAddress.toLowerCase()

  if (chainId === 1) {
    // ── Unchanged mainnet behaviour ──
    if (addr === NATIVE_ETH.toLowerCase() || addr === WETH_ADDRESS.toLowerCase()) {
      return CHAINLINK_ETH_USD
    }
    return CHAINLINK_FEEDS[addr] ?? null
  }

  const feeds = CHAINLINK_FEEDS_BY_CHAIN[chainId]
  if (!feeds) return null
  // Native ETH on an L2 maps to that chain's wrapped-native (WETH) address.
  let wrapped: string
  try {
    wrapped = getChainConfig(chainId).nativeCurrency.wrappedAddress.toLowerCase()
  } catch {
    return null
  }
  const key = addr === NATIVE_ETH.toLowerCase() ? wrapped : addr
  return feeds[key] ?? null
}

/**
 * [SPRINT-9V V1 / rule #9] Per-feed Chainlink HEARTBEAT (max seconds between updates), keyed by the
 * feed PROXY address (lowercased). Each value verified against the Chainlink reference-data-directory
 * (feeds-ethereum-mainnet-base-1.json `heartbeat` field) + docs.chain.link + the on-chain decimals
 * already pinned in 9S. A feed NOT listed here → null → the caller's global fallback
 * (fail-conservative). MAINNET feeds are deliberately omitted → they keep the existing global
 * threshold (byte-identical) — the 1h global already matches mainnet majors' ~1h heartbeat, so adding
 * heartbeat×1.5 there would only loosen with no benefit (see FEEDBACK 9V; surfaced for the Auditor).
 */
const FEED_HEARTBEAT_SEC: Record<string, number> = {
  // ── Base (8453) ──
  '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70': 1200,   // ETH/USD  (20 min — L2 feed)
  '0x458138fc0d67027e9a6778ef40a6ffc318c69061': 86400,  // USDC/USD (24 h — the 9S stablecoin problem)
  '0x591e79239a7d679378ec8c847e5038150364c78f': 86400,  // DAI/USD  (24 h)
  '0x806b4ac04501c29769051e42783cf04dce41440b': 86400,  // cbETH/ETH MARKET feed (24 h — V2 base leg; see 9V-M-01 note below)
  '0x868a501e68f3d1e89cfc0d22f6b22e8dabce5f04': 86400,  // cbETH/ETH Exchange-Rate feed (24 h — 9W depeg breaker leg)
}

/** [SPRINT-9V V1] Heartbeat (seconds) for a feed PROXY address, or null when unknown. */
export function getFeedHeartbeatSec(feed: string): number | null {
  return FEED_HEARTBEAT_SEC[feed.toLowerCase()] ?? null
}

/**
 * [SPRINT-9V V1] Per-feed staleness threshold (seconds), shared by the raw gate (fetchChainlinkPriceRaw)
 * AND the UI hook (useChainlinkPrice) so they agree on every feed:
 *   - known heartbeat → heartbeat × 1.5 (margin for a late round);
 *   - unknown heartbeat → `globalFallback` (each consumer's existing global → fail-conservative,
 *     and mainnet — which has no heartbeats here — stays byte-identical).
 * NO loosening of the round-INTEGRITY guards (answer>0 / answeredInRound / startedAt) — those are
 * unchanged in validateRoundData; this only sets the staleness ceiling.
 */
export function getFeedStalenessSec(feed: string, globalFallback: number): number {
  const hb = getFeedHeartbeatSec(feed)
  return hb != null ? Math.round(hb * 1.5) : globalFallback
}

/** [SPRINT-9V V2] A composed USD price: token/USD = base(token/ETH) × quote(ETH/USD). */
export interface ComposedFeed {
  /** Base leg — token priced in ETH (e.g. cbETH/ETH, 18 dp). */
  base: `0x${string}`
  /** Quote leg — ETH priced in USD (ETH/USD, 8 dp). product = base × quote = token/USD. */
  quote: `0x${string}`
}

/**
 * [SPRINT-9V V2 / rule #9] Composed Chainlink feeds: token/USD = base(token/ETH) × quote(ETH/USD).
 * Used ONLY when no DIRECT USD feed exists for the token (getChainlinkFeed → null). BOTH legs are
 * validated INDEPENDENTLY (integrity + per-feed staleness); either leg invalid → the whole
 * composition is unavailable (NO partial pricing) → caller falls back to the existing calm
 * no-oracle path (multi-source compare + on-chain minimumOutput). Keyed by token address
 * (lowercased). MAINNET has none (untouched).
 */
const COMPOSED_FEEDS_BY_CHAIN: Record<number, Record<string, ComposedFeed>> = {
  // ── Base (8453) ──
  8453: {
    // cbETH (0x2Ae3…0DEc22): composed cbETH/USD = cbETH/ETH × ETH/USD.
    //  • base  cbETH/ETH  0x806b4Ac0… — "CBETH / ETH" 18 dp   (the MARKET-price feed — CHOSEN)
    //  • quote ETH/USD    0x71041ddd… — "ETH / USD"  8 dp     (the existing WETH feed)
    //
    // [9V-M-01] Base actually has THREE cbETH feeds (all live, v6, on-chain-verified 2026-06-08):
    //   0x806b4Ac0…  "CBETH / ETH"            18 dp  agg 0x53fDcAb0…  ← base leg used here (MARKET price)
    //   0x868a501e…  "cbETH-ETH Exchange Rate" 18 dp  agg 0x4c78deA2…  ← NOT used: protocol redemption
    //       rate, manipulation-resistant but BLIND to market depeg (a swap guard built on it would
    //       over-value a depegged cbETH). It is a lending-collateral feed, not a swap-price feed.
    //   0xd7818272…  "CBETH / USD"             8 dp  agg 0x71E021bc…  ← a DIRECT cbETH/USD feed DOES
    //       exist (20-min heartbeat) — the original V2 premise "no direct feed" was wrong. Adopting it
    //       would collapse this composition to one read, but that changes the base×quote architecture,
    //       so it is deferred to a follow-up sprint (see FEEDBACK 9V — 9V-M-01).
    // The audit's "0x806b… absent from the directory" matched the Exchange-Rate entry; 0x806b… IS in
    // the directory as "CBETH / ETH". Decision (Architect, 9V-M-01): keep the MARKET feed 0x806b….
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': {
      base: '0x806b4Ac04501c29769051e42783cF04dCE41440b',
      quote: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    },
  },
}

/**
 * [SPRINT-9V V2] Resolve a composed feed for a token, or null. Defaults to mainnet (which has
 * none → null → byte-identical). A token with a DIRECT feed should never reach here; callers
 * consult this only after getChainlinkFeed returns null.
 */
export function getComposedFeed(
  tokenAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): ComposedFeed | null {
  const feeds = COMPOSED_FEEDS_BY_CHAIN[chainId]
  if (!feeds) return null
  return feeds[tokenAddress.toLowerCase()] ?? null
}

/**
 * [SPRINT-9W-oracle] An asset that has BOTH a market price feed AND an exchange-rate (redemption)
 * feed for the same pair — the inputs to the depeg circuit-breaker. The MARKET feed remains the
 * swap-price reference (9V); the EXCHANGE-RATE feed is the manipulation-resistant comparison leg.
 */
export interface ExchangeRatePair {
  symbol: string              // for the depeg warning copy (e.g. "cbETH")
  market: `0x${string}`       // market price feed (token/ETH) — the 9V swap-price reference
  exchangeRate: `0x${string}` // exchange-rate / redemption feed (token/ETH) — manipulation-resistant
}

/**
 * [SPRINT-9W-oracle / rule #9] Data-driven registry of assets with both a market and an
 * exchange-rate feed. NOT cbETH-hardcoded — any future LST/LRT with both feeds gets the depeg
 * breaker by adding an entry here. Keyed by token address (lowercased). MAINNET has none.
 * Both feeds on-chain verified in 9V-M-01 (description/decimals/aggregator via cast, 2026-06-08).
 */
const EXCHANGE_RATE_PAIRS_BY_CHAIN: Record<number, Record<string, ExchangeRatePair>> = {
  // ── Base (8453) ──
  8453: {
    // cbETH (0x2Ae3…0DEc22): market "CBETH / ETH" 0x806b… vs "cbETH-ETH Exchange Rate" 0x868a…
    // (both 18 dp). Normal market-vs-ER spread ≪1%; a large gap means depeg/manipulation.
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': {
      symbol: 'cbETH',
      market: '0x806b4Ac04501c29769051e42783cF04dCE41440b',
      exchangeRate: '0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04',
    },
  },
}

/**
 * [SPRINT-9W-oracle] Resolve the market+exchange-rate feed pair for a token, or null when the
 * token has no exchange-rate feed (the common case → no depeg check). Defaults to mainnet (none).
 */
export function getExchangeRatePair(
  tokenAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): ExchangeRatePair | null {
  const pairs = EXCHANGE_RATE_PAIRS_BY_CHAIN[chainId]
  if (!pairs) return null
  return pairs[tokenAddress.toLowerCase()] ?? null
}
