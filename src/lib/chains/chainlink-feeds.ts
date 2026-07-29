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
 *
 * [ADR-018] Address alone is not identity. An on-chain verification pass (2026-07-29) found 7 of
 * the 40 configured addresses had a description()/decimals() that CONTRADICTED the config key
 * (hand-transcribed hex drift, or a hand-picked "close enough" feed) — 6 fail loudly (no code /
 * dead proxy / wrong denomination) but WBTC/USD silently reads the BTC/USD index feed, which
 * passes every existing guard because nothing ever asked the feed what it is. FEED_EXPECTATIONS
 * below declares the description()/decimals() every address MUST return before its answer is
 * trusted; the read path (chainlink.ts, useChainlinkPrice.ts) enforces it. See ADR-018.
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
  // [SPRINT-46-ARBITRUM-CONFIG → CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] Arbitrum (42161) — 5 core
  // feeds. AUDIT-ARBITRUM-46-47 HIGH: ALL 5 recon-sourced feed addresses had ZERO on-chain code
  // (hand-transcribed hex drift — each shares a prefix with, but diverges from, the real feed).
  // Corrected via scripts/verify-arbitrum-addresses.mjs: resolved from Chainlink's official
  // reference-data directory (the ENS-named canonical path per pair, e.g. "eth-usd" — NOT the
  // "-svr"/"-shared-svr" sibling entries also present there), verified on two independent
  // Arbitrum RPCs (description() matches the pair, decimals()===8, fresh latestRoundData(),
  // answer>0). Keyed by Arbitrum token address (lowercased) — the token addresses were ALSO
  // corrected in registry.ts for USDT/DAI/WBTC, so the map keys changed too. CONFIG-ONLY / dark:
  // unreachable while contracts.feeCollector is null (isChainActive(42161) === false). See
  // docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json + ARBITRUM-ADDRESS-VERIFICATION.md.
  42161: {
    // WETH → ETH/USD
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    // USDC (native) → USDC/USD
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    // DAI → DAI/USD (key updated to the CORRECTED DAI token address, see registry.ts)
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',
    // USDT → USDT/USD (key updated to the CORRECTED USDT token address, see registry.ts)
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
    // WBTC → WBTC/USD (key updated to the CORRECTED WBTC token address, see registry.ts;
    // dedicated WBTC feed — NOT the BTC/USD index feed)
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': '0xd0C7101eACbB49F3deCcCc166d238410D6D46d57',
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
  // ── Arbitrum (42161) [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] — keys are the CORRECTED feed
  // addresses (see the CHAINLINK_FEEDS_BY_CHAIN[42161] block above); heartbeats are the exact
  // `heartbeat` field from Chainlink's official reference-data directory for each feed's
  // canonical ENS-named entry (not the untrusted recon report's rounded ~1h/~24h estimates).
  '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612': 1755,  // ETH/USD
  '0x50834f3163758fcc1df9973b6e91f0f0f0434ad3': 255,   // USDC/USD
  '0xc5c8e77b397e531b8ec06bfb0048328b30e9ecfb': 86400, // DAI/USD
  '0x3f3f5df88dc9f13eac63df89ec16ef6e7e25dde7': 255,   // USDT/USD
  '0xd0c7101eacbb49f3decccc166d238410d6d46d57': 86400, // WBTC/USD
  // ── Ethereum mainnet (1) [FIX-MAINNET-FEED-REMEDIATION] ──
  // The header above says mainnet feeds are deliberately omitted because the 1h global matches
  // mainnet MAJORS' ~1h heartbeat. That reasoning holds for ETH/USD, BTC/USD and the stablecoins
  // (all 3600s, still omitted, still on the global) — but NOT for these long-tail feeds, which
  // Chainlink publishes at a 86400s (24h) heartbeat. Judged against the 3600s global they read as
  // permanently stale: at the time of writing WBTC/BTC was 22.6h old, GRT/ETH 17.4h, APE/USD 10.5h
  // — every one of them >1h, so the remediation would have shipped feeds that resolve to null
  // ~always. Values are the exact `heartbeat` field from Chainlink's official reference-data
  // directory (feeds-mainnet.json, 2026-07-29); ×1.5 ⇒ a 36h ceiling.
  '0x17d054ecac33d91f7340645341efb5de9009f1c1': 86400, // GRT/ETH   (composed base leg)
  '0x4e844125952d32acdf339be976c98e22f6f318db': 86400, // LDO/ETH   (composed base leg)
  '0x8dd1cd88f43af196ae478e91b9f5e4ac69a97c61': 86400, // SHIB/ETH  (composed base leg)
  '0xfdfd9c85ad200c506cf9e21f1fd8dd01932fbb23': 86400, // WBTC/BTC  (composed base leg)
  '0xd10abbc76679a20055e167bb80a24ac851b37056': 86400, // APE/USD   (direct)
  '0x9944d86ceb9160af5c5feb251fd671923323f8c3': 86400, // PAXG/USD  (direct)
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
 * (lowercased).
 *
 * [FIX-MAINNET-FEED-REMEDIATION] Mainnet is no longer empty. The general form is
 * token/USD = base × quote, where base need not be ETH-denominated — WBTC composes through BTC
 * (WBTC/BTC × BTC/USD), which is what makes a WBTC-vs-BTC depeg visible instead of invisible.
 */
const COMPOSED_FEEDS_BY_CHAIN: Record<number, Record<string, ComposedFeed>> = {
  // ── Ethereum mainnet (1) [FIX-MAINNET-FEED-REMEDIATION] ──
  // Four tokens whose configured "…/USD" address was never a USD feed. Every address below is
  // sourced from Chainlink's official reference-data directory (feeds-mainnet.json, fetched
  // 2026-07-29, canonical ENS-named entry per pair) AND confirmed on-chain via description() +
  // decimals() on two independent RPCs (ethereum-rpc.publicnode.com, eth.drpc.org).
  //
  // Three of the four (GRT/LDO/SHIB) reuse the EXACT address already in config — it was always a
  // valid /ETH feed, merely read as though it were USD. No address changes for those; only the
  // interpretation does. Arithmetic cross-check on GRT: composed 7.8257e-6 ETH × $1901.44 =
  // $0.014880 vs the independent direct GRT/USD feed's $0.014991 — 0.74% apart, confirming the
  // composition is denominated correctly.
  1: {
    // GRT (0xc944…44a7): "GRT / ETH" 18dp × "ETH / USD" 8dp
    '0xc944e90c64b2c07662a292be6244bdf05cda44a7': {
      base: '0x17D054ECAC33D91F7340645341eFB5DE9009F1C1',
      quote: CHAINLINK_ETH_USD,
    },
    // LDO (0x5a98…1b32): "LDO / ETH" 18dp × "ETH / USD" 8dp
    '0x5a98fcbea516cf06857215779fd812ca3bef1b32': {
      base: '0x4e844125952D32AcdF339BE976c98E22F6F318dB',
      quote: CHAINLINK_ETH_USD,
    },
    // SHIB (0x95ad…c4ce): "SHIB / ETH" 18dp × "ETH / USD" 8dp
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': {
      base: '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61',
      quote: CHAINLINK_ETH_USD,
    },
    // WBTC (0x2260…c599): "WBTC / BTC" 8dp × "BTC / USD" 8dp. NOT ETH-denominated — this is the
    // entry the whole ADR-018 investigation started from. 0xF4030086… (the quote leg) is the
    // canonical BTC index feed and was previously mapped as if it were WBTC/USD, so a WBTC
    // depeg was structurally invisible: the guard compared BTC's price to WBTC's execution
    // price and a depeg moves both together. Pricing WBTC through an explicit WBTC/BTC leg
    // makes the peg itself an input, so a discount now shows up as a real deviation.
    //   • base  WBTC/BTC 0xfdFD9C85… — "WBTC / BTC" 8dp (NEW address; reads 1.00025 at time of writing)
    //   • quote BTC/USD  0xF4030086… — "BTC / USD"  8dp (the address formerly mis-keyed as WBTC/USD)
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
      base: '0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23',
      quote: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    },
  },
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

// ══════════════════════════════════════════════════════════
//  [ADR-018] Feed self-identification
// ══════════════════════════════════════════════════════════

/** The description()/decimals() a feed proxy MUST return before its answer is trusted. */
export interface FeedExpectation {
  /** Exact on-chain description() string (e.g. "ETH / USD"). Case- and spacing-sensitive. */
  description: string
  /** Exact on-chain decimals() value. */
  decimals: number
}

/**
 * [ADR-018] Per-address self-identification registry — keyed by feed PROXY address (lowercased),
 * same convention as FEED_HEARTBEAT_SEC. Every address referenced anywhere in
 * CHAINLINK_FEEDS / CHAINLINK_FEEDS_BY_CHAIN / COMPOSED_FEEDS_BY_CHAIN must have an entry here (the
 * completeness assert below enforces this at import time). Populated by READING each address
 * on-chain — never derived from the config key or the address alone (ADR-018 invariant (b)).
 *
 * For the 7 mainnet entries AUDIT-ARBITRUM-46-47's sibling verification pass found defective
 * (WBTC/USD → the BTC/USD index feed; GRT/LDO/SHIB/USD → their ETH-denominated feeds; APE/PEPE/USD
 * → no on-chain code; PAXG/USD → a dead proxy), the value recorded is the CORRECT description/
 * decimals FOR THE PAIR THE KEY CLAIMS (Chainlink's own "TOKEN / USD", 8dp convention — the same
 * shape as every one of this table's other 33 entries) — NOT what the current (wrong) address
 * actually returns. That is deliberate: it makes each of the 7 fail closed against its own
 * misconfigured address rather than pass by matching its own bug. Their address remediation is a
 * separate goal; this entry only makes the existing wrong address visibly wrong.
 */
const FEED_EXPECTATIONS: Record<string, FeedExpectation> = {
  // ── Mainnet (1) — CHAINLINK_ETH_USD + CHAINLINK_FEEDS (constants.ts) ──
  // ETH/USD
  '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419': { description: 'ETH / USD', decimals: 8 },
  // Stablecoins
  '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6': { description: 'USDC / USD', decimals: 8 },
  '0x3e7d1eab13ad0104d2750b8863b489d65364e32d': { description: 'USDT / USD', decimals: 8 },
  '0xaed0c38402a5d19df6e4c03f4e2dced6e29c1ee9': { description: 'DAI / USD', decimals: 8 },
  '0xa569d910839ae8865da8f8e70fffb0cba869f961': { description: 'USDe / USD', decimals: 8 },
  '0xb9e1e3a9feff48998e45fa90847ed4d467e8bcfd': { description: 'FRAX / USD', decimals: 8 },
  '0x3d7ae7e594f2f2091ad8798313450130d0aba3a0': { description: 'LUSD / USD', decimals: 8 },
  // Blue chips
  // [FIX-MAINNET-FEED-REMEDIATION] 0xF4030086… is the canonical BTC/USD index feed and now serves as
  // the QUOTE leg of composed WBTC/USD. Under ADR-018 it was declared "WBTC / USD" so it would fail
  // closed against its own misuse; now that it is used AS BTC/USD, the expectation is corrected to
  // the identity it actually (and always did) self-report on-chain: "BTC / USD" @ 8dp.
  '0xf4030086522a5beea4988f8ca5b36dbc97bee88c': { description: 'BTC / USD', decimals: 8 },
  // [FIX-MAINNET-FEED-REMEDIATION] WBTC/BTC — the new composed BASE leg. On-chain verified.
  '0xfdfd9c85ad200c506cf9e21f1fd8dd01932fbb23': { description: 'WBTC / BTC', decimals: 8 },
  '0x2c1d072e956affc0d435cb7ac38ef18d24d9127c': { description: 'LINK / USD', decimals: 8 },
  '0x553303d460ee0afb37edff9be42922d8ff63220e': { description: 'UNI / USD', decimals: 8 },
  '0x547a514d5e3769680ce22b2361c10ea13619e8a9': { description: 'AAVE / USD', decimals: 8 },
  '0xdbd020caef83efd542f4de03e3cf0c28a4428bd5': { description: 'COMP / USD', decimals: 8 },
  '0xec1d1b3b0443256cc3860e24a46f108e699484aa': { description: 'MKR / USD', decimals: 8 },
  '0xdc3ea94cd0ac27d9a86c180091e7f78c683d3699': { description: 'SNX / USD', decimals: 8 },
  // [FIX-MAINNET-FEED-REMEDIATION] GRT/ETH — same address as before, now used as the composed BASE
  // leg and declared as the identity it genuinely self-reports on-chain.
  '0x17d054ecac33d91f7340645341efb5de9009f1c1': { description: 'GRT / ETH', decimals: 18 },
  // DeFi governance
  '0xcd627aa160a6fa45eb793d19ef54f5062f20f33f': { description: 'CRV / USD', decimals: 8 },
  '0xa027702dbb89fbd58938e4324ac03b58d812b0e1': { description: 'YFI / USD', decimals: 8 },
  '0xdf2917806e30300537aeb49a7663062f4d1f2b5f': { description: 'BAL / USD', decimals: 8 },
  '0xcc70f09a6cc17553b2e31954cd36e4a2d89501f7': { description: 'SUSHI / USD', decimals: 8 },
  // [FIX-MAINNET-FEED-REMEDIATION] LDO/ETH — same address, now the composed BASE leg, declared as
  // the identity it genuinely self-reports on-chain.
  '0x4e844125952d32acdf339be976c98e22f6f318db': { description: 'LDO / ETH', decimals: 18 },
  // [FIX-MAINNET-FEED-REMEDIATION] APE/USD — address CORRECTED to the real proxy (…b37056; the old
  // …b37571 was hex drift with zero on-chain code and is now gone from the config entirely).
  '0xd10abbc76679a20055e167bb80a24ac851b37056': { description: 'APE / USD', decimals: 8 },
  // LSDs & others
  '0x7bac85a8a13a4bcd8abb3eb7d6b4d632c5a57676': { description: 'MATIC / USD', decimals: 8 },
  '0x5c00128d4d1c2f4f652c267d7bcdd7ac99c16e16': { description: 'ENS / USD', decimals: 8 },
  '0xc929ad75b72593967de83e7f7cda0493458261d9': { description: '1INCH / USD', decimals: 8 },
  '0x6ebc52c8c1089be9eb3945c4350b68b8e4c2233f': { description: 'FXS / USD', decimals: 8 },
  '0x4e155ed98afe9034b7a5962f6c84c86d869daa9d': { description: 'RPL / USD', decimals: 8 },
  // Liquid staking (on-chain description() is upper-case "STETH / USD", not "stETH / USD")
  '0xcfe54b5cd566ab89272946f602d76ea879cab4a8': { description: 'STETH / USD', decimals: 8 },
  // Meme / popular
  // [FIX-MAINNET-FEED-REMEDIATION] SHIB/ETH — same address, now the composed BASE leg, declared as
  // the identity it genuinely self-reports on-chain.
  '0x8dd1cd88f43af196ae478e91b9f5e4ac69a97c61': { description: 'SHIB / ETH', decimals: 18 },
  // [ADR-018 / FIX-MAINNET-FEED-REMEDIATION] PEPE/USD — STILL MISCONFIGURED, DELIBERATELY. The
  // address has zero on-chain code and Chainlink publishes no PEPE feed of any denomination on
  // mainnet, so there is nothing correct to point it at. Left blocking (UNRESOLVED): the expectation
  // stays the identity a real PEPE/USD feed WOULD report, which this dead address can never match.
  '0x02de28ab3c28a5b1e8236b1069a211b7494f0f35': { description: 'PEPE / USD', decimals: 8 },
  // Commodities
  // [FIX-MAINNET-FEED-REMEDIATION] PAXG/USD — address CORRECTED to the live proxy (0x9944D86C…);
  // the old 0x9B97304E… is a retired deployment whose aggregator() is address(0) (all reads revert)
  // and is now gone from the config entirely.
  '0x9944d86ceb9160af5c5feb251fd671923323f8c3': { description: 'PAXG / USD', decimals: 8 },

  // ── Base (8453) ──
  '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70': { description: 'ETH / USD', decimals: 8 },
  '0x458138fc0d67027e9a6778ef40a6ffc318c69061': { description: 'USDC / USD', decimals: 8 },
  '0x591e79239a7d679378ec8c847e5038150364c78f': { description: 'DAI / USD', decimals: 8 },
  // cbETH composed legs (SPRINT-9V V2 / 9V-M-01) — ETH-denominated by design, not USD.
  '0x806b4ac04501c29769051e42783cf04dce41440b': { description: 'CBETH / ETH', decimals: 18 },
  '0x868a501e68f3d1e89cfc0d22f6b22e8dabce5f04': { description: 'cbETH-ETH Exchange Rate', decimals: 18 },

  // ── Arbitrum (42161) [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] ──
  '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612': { description: 'ETH / USD', decimals: 8 },
  '0x50834f3163758fcc1df9973b6e91f0f0f0434ad3': { description: 'USDC / USD', decimals: 8 },
  '0xc5c8e77b397e531b8ec06bfb0048328b30e9ecfb': { description: 'DAI / USD', decimals: 8 },
  '0x3f3f5df88dc9f13eac63df89ec16ef6e7e25dde7': { description: 'USDT / USD', decimals: 8 },
  '0xd0c7101eacbb49f3decccc166d238410d6d46d57': { description: 'WBTC / USD', decimals: 8 },
}

/** [ADR-018] The description()/decimals() a feed proxy at `feed` must self-report, or null if the
 *  address has no declared expectation (fails closed — see the callers in chainlink.ts). */
export function getFeedExpectation(feed: string): FeedExpectation | null {
  return FEED_EXPECTATIONS[feed.toLowerCase()] ?? null
}

/** [ADR-018] One leg of a resolved feed: the address plus the identity it must self-report. */
export interface FeedLeg {
  address: `0x${string}`
  expectedDescription: string
  expectedDecimals: number
}

/**
 * [ADR-018] A resolved price source for a token — exhaustive at compile time. A caller that
 * switches on `kind` and handles both cases (with a `never` check in `default`) is guaranteed by
 * the type checker to cover every shape this registry can produce; adding a third shape later
 * forces every such switch to be revisited.
 */
export type ResolvedFeed =
  | { kind: 'single'; leg: FeedLeg }
  | { kind: 'composed'; base: FeedLeg; quote: FeedLeg }

function toLeg(address: `0x${string}`): FeedLeg | null {
  const expectation = getFeedExpectation(address)
  if (!expectation) return null
  return { address, expectedDescription: expectation.description, expectedDecimals: expectation.decimals }
}

/**
 * [ADR-018] Resolve a token to its price source — single feed or composed (base × quote) — with
 * each leg's declared self-identification attached. Returns null when no feed is configured AT
 * ALL (the pre-existing "no oracle" case) OR when a configured feed/leg has no FEED_EXPECTATIONS
 * entry (fails closed; should be unreachable given the completeness assert below, but a per-call
 * defensive check costs nothing and never trusts an address with no declared identity).
 */
export function resolveFeed(
  tokenAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): ResolvedFeed | null {
  const direct = getChainlinkFeed(tokenAddress, chainId)
  if (direct) {
    const leg = toLeg(direct)
    return leg ? { kind: 'single', leg } : null
  }
  const composed = getComposedFeed(tokenAddress, chainId)
  if (!composed) return null
  const base = toLeg(composed.base)
  const quote = toLeg(composed.quote)
  if (!base || !quote) return null
  return { kind: 'composed', base, quote }
}

/**
 * [FIX-HOOK-COMPOSED-FEEDS] Every (chainId, token) pair that has a configured price source of ANY
 * shape, single or composed. Exists so a structural test can enumerate the whole registry and assert
 * that each configured token actually resolves through the consuming code path — the check that
 * catches a token being configured for one path and invisible to another. It is derived from the
 * registries themselves, so a feed added later is covered automatically with no test edit.
 */
export function listConfiguredFeedTokens(): Array<{
  chainId: number
  token: string
  kind: 'single' | 'composed'
}> {
  const out: Array<{ chainId: number; token: string; kind: 'single' | 'composed' }> = []
  for (const [chainIdStr, feeds] of Object.entries(CHAINLINK_FEEDS_BY_CHAIN)) {
    for (const token of Object.keys(feeds)) {
      out.push({ chainId: Number(chainIdStr), token, kind: 'single' })
    }
  }
  for (const [chainIdStr, composed] of Object.entries(COMPOSED_FEEDS_BY_CHAIN)) {
    for (const token of Object.keys(composed)) {
      out.push({ chainId: Number(chainIdStr), token, kind: 'composed' })
    }
  }
  return out
}

// [ADR-018 invariant (a)] Completeness assert, run once at module load: every address the registry
// can ever hand out (direct, composed base, composed quote) must have a declared self-identification
// expectation. A future feed added to CHAINLINK_FEEDS / CHAINLINK_FEEDS_BY_CHAIN / COMPOSED_FEEDS_BY_
// CHAIN without a matching FEED_EXPECTATIONS entry throws IMMEDIATELY on import (loud everywhere,
// including every test run) rather than silently trusting an un-self-identified feed in production.
;(function assertFeedExpectationsComplete(): void {
  const addresses = new Set<string>()
  addresses.add(CHAINLINK_ETH_USD.toLowerCase())
  for (const feed of Object.values(CHAINLINK_FEEDS)) addresses.add(feed.toLowerCase())
  for (const chainFeeds of Object.values(CHAINLINK_FEEDS_BY_CHAIN)) {
    for (const feed of Object.values(chainFeeds)) addresses.add(feed.toLowerCase())
  }
  for (const chainComposed of Object.values(COMPOSED_FEEDS_BY_CHAIN)) {
    for (const { base, quote } of Object.values(chainComposed)) {
      addresses.add(base.toLowerCase())
      addresses.add(quote.toLowerCase())
    }
  }
  const missing = [...addresses].filter((a) => !FEED_EXPECTATIONS[a])
  if (missing.length > 0) {
    throw new Error(
      `[ADR-018] ${missing.length} Chainlink feed address(es) configured without a self-identification ` +
      `expectation in FEED_EXPECTATIONS: ${missing.join(', ')}`,
    )
  }
})()
