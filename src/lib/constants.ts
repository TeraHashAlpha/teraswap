// ── API & Chain ──────────────────────────────────────────
export const CHAIN_ID = 1 // Ethereum mainnet

// ── Contact / Support ────────────────────────────────────
// PUBLIC support address only — never the recovery-root ops email.
// Single source of truth — every contact touchpoint (footer, docs, help drawer,
// legal pages, beta disclaimer, error boundaries) renders a mailto: from this.
export const SUPPORT_EMAIL = 'support_teraswap@proton.me'

// ── Aggregator APIs ──────────────────────────────────────
export const AGGREGATOR_APIS = {
  '1inch': {
    base: 'https://api.1inch.dev/swap/v6.0/1',
    // [Audit] API keys are server-only env vars — NEVER use NEXT_PUBLIC_ prefix.
    // Set ONEINCH_API_KEY in Vercel Environment Variables (server-only).
    get key() { return process.env.ONEINCH_API_KEY || '' },
  },
  '0x': {
    base: 'https://api.0x.org',
    // Set ZEROX_API_KEY in Vercel Environment Variables (server-only).
    get key() { return process.env.ZEROX_API_KEY || '' },
  },
  velora: {
    base: 'https://api.paraswap.io',
    key: '',
  },
  odos: {
    base: 'https://api.odos.xyz',
    key: '',
  },
  kyberswap: {
    base: 'https://aggregator-api.kyberswap.com/ethereum',
    key: '',
  },
  cowswap: {
    base: 'https://api.cow.fi/mainnet/api/v1',
    key: '',
  },
  uniswap: {
    base: '', // on-chain — no API base
    key: '',
  },
  uniswapv3: {
    base: '', // on-chain direct — same contracts, separate source label for fee-tier detection
    key: '',
  },
  openocean: {
    base: 'https://open-api.openocean.finance/v4/1',
    key: '',
  },
  sushiswap: {
    base: 'https://api.sushi.com/swap/v7/1',
    key: '',
  },
  balancer: {
    base: 'https://api-v3.balancer.fi',
    key: '',
  },
  curve: {
    base: '', // on-chain — uses RateProvider + CurveRouterNG contracts
    key: '',
  },
  bebop: {
    // [ADR-010] Bebop Aggregation API (JAM). The adapter appends
    // /jam/{slug}/v2/quote using getChainConfig(chainId).slug.
    base: 'https://api.bebop.xyz',
    // Server-only — NEVER NEXT_PUBLIC_ (rule #7). Without a key Bebop returns
    // widened demo-mode quotes (dev only).
    get key() { return process.env.BEBOP_API_KEY || '' },
  },
  teraswap_order_engine: {
    base: '', // autonomous — self-hosted executor + Chainlink execution
    key: '',
  },
} as const

export type AggregatorName = keyof typeof AGGREGATOR_APIS

// ── CoW Protocol chain-aware API URLs ─────────────────────
// The static AGGREGATOR_APIS.cowswap.base is mainnet-only.
// Use getCowApiBase(chainId) for multi-chain support.
// [H-01] Sepolia removed for mainnet deployment.
const COW_API_URLS: Record<number, string> = {
  1: 'https://api.cow.fi/mainnet/api/v1',
  100: 'https://api.cow.fi/xdai/api/v1',
  8453: 'https://api.cow.fi/base/api/v1', // [P217] Base L2
  // [SPRINT-46-ARBITRUM-CONFIG] Arbitrum One — CONFIG-ONLY, dark until chain activation.
  42161: 'https://api.cow.fi/arbitrum/api/v1',
}
export function getCowApiBase(chainId: number): string {
  return COW_API_URLS[chainId] || COW_API_URLS[1]
}

// ── Aggregator metadata (for UI) ─────────────────────────
export const AGGREGATOR_META: Record<AggregatorName, {
  label: string
  mevProtected: boolean
  intentBased: boolean
  isDirect: boolean
  /** Estimated extra execution time in seconds (vs instant tx) */
  estimatedTime?: number
}> = {
  '1inch': { label: '1inch', mevProtected: false, intentBased: false, isDirect: false },
  '0x': { label: '0x/Matcha', mevProtected: false, intentBased: false, isDirect: false },
  velora: { label: 'Velora', mevProtected: false, intentBased: false, isDirect: false },
  odos: { label: 'Odos', mevProtected: false, intentBased: false, isDirect: false },
  kyberswap: { label: 'KyberSwap', mevProtected: false, intentBased: false, isDirect: false },
  cowswap: { label: 'CoW Protocol', mevProtected: true, intentBased: true, isDirect: false, estimatedTime: 30 },
  uniswap: { label: 'Uniswap V3', mevProtected: false, intentBased: false, isDirect: true },
  uniswapv3: { label: 'Uniswap V3', mevProtected: false, intentBased: false, isDirect: true },
  openocean: { label: 'OpenOcean', mevProtected: false, intentBased: false, isDirect: false },
  sushiswap: { label: 'SushiSwap', mevProtected: false, intentBased: false, isDirect: false },
  balancer: { label: 'Balancer', mevProtected: false, intentBased: false, isDirect: false },
  curve: { label: 'Curve Finance', mevProtected: false, intentBased: false, isDirect: true },
  bebop: { label: 'Bebop', mevProtected: false, intentBased: false, isDirect: false },
  teraswap_order_engine: { label: 'TeraSwap Order Engine', mevProtected: true, intentBased: false, isDirect: false },
}

// [ADR-010] Bebop partner identifier — server-only (query `source={BEBOP_SOURCE}`,
// paired with the `source-auth: {BEBOP_API_KEY}` header). NEVER NEXT_PUBLIC_.
export const BEBOP_SOURCE = process.env.BEBOP_SOURCE || ''

// [ADR-010] Bebop JAM contracts — identical on every supported EVM chain except
// zkSync, so the SAME on Ethereum (1) and Base (8453). The adapter validates the
// quote's response addresses against the per-chain router whitelist (fail-closed);
// these are the only Bebop addresses we ever route to / approve.
export const BEBOP_JAM_SETTLEMENT = '0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6' as `0x${string}` // tx.to
export const BEBOP_BALANCE_MANAGER = '0xC5a350853E4e36b73EB0C24aaA4b8816C9A3579a' as `0x${string}` // approvalTarget

// ── Fee ──────────────────────────────────────────────────
export const FEE_PERCENT = Number(process.env.NEXT_PUBLIC_FEE_PERCENT ?? '0.1')
export const FEE_BPS = Math.round(FEE_PERCENT * 100) // 0.1% → 10 bps

// [C-07] SECURITY: Never default to zero address — fees would be permanently burned.
// These MUST be set in env vars. The validation layer (env-validation.ts) will
// catch missing values at startup.
const _feeRecipient = process.env.NEXT_PUBLIC_FEE_RECIPIENT ?? ''
if (_feeRecipient && _feeRecipient === '0x0000000000000000000000000000000000000000') {
  console.error('[TeraSwap] CRITICAL: FEE_RECIPIENT is zero address — fees will be burned!')
}
export const FEE_RECIPIENT = (_feeRecipient || '0x107F6eB7C3866c9cEf5860952066e185e9383ABA') as `0x${string}`

// [C-08] FeeCollector proxy — deploy contracts/TeraSwapFeeCollector.sol and set this env var.
// Hard default to deployed mainnet FeeCollector V2 so fees are never silently disabled.
//
// V2 (current — swapETHWithFee/swapTokenWithFee accept tokenOut + minimumOutput
//   and revert with InsufficientOutput when the user's balance delta is short [H-04]):
//   0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459
//
// V1 (frozen — kept here for analytics continuity so historical swaps still
//   resolve their FeeCollector hop on Etherscan and in our own history views):
//   0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD
const _feeCollector = process.env.NEXT_PUBLIC_FEE_COLLECTOR ?? ''
export const FEE_COLLECTOR_ADDRESS = (_feeCollector || '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459') as `0x${string}`
export const FEE_COLLECTOR_V1_ADDRESS = '0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD' as `0x${string}`

// Sources that collect TeraSwap's fee NATIVELY via their own API partner-fee
// params (no FeeCollector hop). INVARIANT: a source belongs here IF AND ONLY IF
// its adapter attaches partner-fee params to an outgoing request —
//   - '0x'      swapFeeRecipient + swapFeeBps + swapFeeToken (adapters/zerox.ts
//               applyPartnerFee, on BOTH the /price quote and the /quote build)
//   - 'cowswap' metadata.partnerFee { bps, recipient } in the order appData
//               (adapters/cow.ts buildCowAppData, quote + order paths)
//   - 'bebop'   fee + fee_recipient on the FIRM quote only (adapters/bebop.ts
//               fetchSwapData); the price quote stays GROSS so Bebop ranks fairly
// partner-fee-drift.test.ts drives every registered adapter and enforces the
// invariant in BOTH directions, so a new integration cannot silently drift out
// of this list (which is what happened to '0x' between SPRINT-9T T1 and
// fix/zerox-partner-fee-armed: the params shipped, the list stayed empty).
//
// This list is what ARMS the M-01 fee-integrity check in useSwap/useSplitSwap
// and what names the fee mechanism in the UI (lib/fee-mode.ts). It is NOT the
// same concept as FEE_INCOMPATIBLE_SOURCES (cannot route through the
// FeeCollector) — they happen to hold the same three members today, which is a
// measured coincidence, not a definition. Fee is partner-fee XOR FeeCollector,
// never both (partner-fee-invariant.test.ts).
export const FEE_NATIVE_SOURCES: AggregatorName[] = [
  '0x', 'cowswap', 'bebop',
]

// Sources incompatible with FeeCollector proxy routing.
// These sources cannot route through the FeeCollector contract due to
// structural mismatches in their swap architecture:
//   - '0x'      Uses Permit2 pull model (not standard ERC-20 approve).
//   - 'cowswap' Intent-based (EIP-712 signing, no on-chain tx to wrap).
//   - 'bebop'   [ADR-010] Bebop builds the tx for its own JAM settlement; our
//               fee is taken via Bebop partner-fee params, not the FeeCollector.
// All other sources route through FeeCollector V2 for 0.1% fee collection.
export const FEE_INCOMPATIBLE_SOURCES: AggregatorName[] = [
  '0x', 'cowswap', 'bebop',
]

// ── Disabled Sources ────────────────────────────────────
// Sources temporarily disabled for security/operational reasons.
// Excluded from ALL quote and swap requests. Reversible by removing the entry.
// cowswap re-enabled 2026-04-23 — post-mortem complete, RegistryLock confirmed.
// See INC-2026-04-14-001 for context.
export const DISABLED_SOURCES: Record<string, string> = {
  // [CHORE-QUOTE-SOURCE-FIXES C2] The v2 SOR order endpoint the adapter calls
  // (api-v3.balancer.fi/order/{chainId} — single host, so this covers both
  // chains) returns 404 ('only /, /graphql and /log allowed'); 0 prod quotes
  // ever (T-SAF W7-L-02, 2026-07-02). Re-enable ONLY after migrating
  // src/lib/adapters/balancer.ts to the Balancer v3 GraphQL SOR
  // (POST /graphql, sorGetSwapPaths).
  balancer: 'SOR order endpoint dead (404) — re-enable requires migrating to the Balancer v3 GraphQL SOR (sorGetSwapPaths)',
  // Odos ceased ALL operations 2026-07-30 (vendor shutdown, announced
  // publicly). PERMANENT — re-enable is impossible, the company no longer
  // exists. Adapter file kept (never delete, see CLAUDE.md) with a
  // @deprecated header; the on-chain router whitelist entries stay too
  // (immutable on Arbitrum by design) — dormant and harmless since the API
  // layer never quotes it.
  odos: 'vendor shutdown 2026-07-30 — permanent, re-enable impossible (company no longer exists)',
  // [CHORE-2026-09-03 / INC-2026-09-03-001] Measured in production
  // 2026-09-03 10:01-10:06 UTC: every probe returns HttpError 403 (an HTML
  // Cloudflare challenge on a JSON endpoint). The vendor publishes no key
  // programme and never answered the owner's request for one. RE-ENABLE
  // CRITERION: a vendor-issued key (or documented public endpoint) returns
  // 200 JSON for the canonical USDC→USDT probe on chains 1 and 8453.
  openocean: 'HttpError 403 on every probe (Cloudflare challenge, no key programme) — re-enable requires a vendor-issued key or documented public endpoint returning 200 JSON for USDC→USDT on chains 1 and 8453',
  // [CHORE-2026-09-03 / INC-2026-09-03-001] Measured in production
  // 2026-09-03 10:01-10:06 UTC: "[bebop] skipped on every chain —
  // BEBOP_API_KEY not set" on every tick. The owner never received a key
  // from the vendor; demo mode has no executable settlement, so this
  // source has never quoted in production. RE-ENABLE CRITERION:
  // BEBOP_API_KEY issued by the vendor, set in production, and a firm JAM
  // quote returns an executable settlement on chains 1 and 8453.
  bebop: 'BEBOP_API_KEY never issued by vendor — skipped on every tick, never quoted in production — re-enable requires a vendor-issued key set in production plus a firm JAM quote returning executable settlement on chains 1 and 8453',
}

// FeeCollector ABI (only the functions we call from the frontend)
// [H-04] swapETHWithFee / swapTokenWithFee now take tokenOut + minimumOutput
// and the contract reverts with InsufficientOutput if the user's post-swap
// balance delta is below the declared minimum.
export const FEE_COLLECTOR_ABI = [
  {
    name: 'swapETHWithFee',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'router', type: 'address' },
      { name: 'routerData', type: 'bytes' },
      { name: 'tokenOut', type: 'address' },
      { name: 'minimumOutput', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'swapTokenWithFee',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'totalAmount', type: 'uint256' },
      { name: 'router', type: 'address' },
      { name: 'routerData', type: 'bytes' },
      { name: 'tokenOut', type: 'address' },
      { name: 'minimumOutput', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'SwapWithFee',
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'router', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: false },
      { name: 'totalAmount', type: 'uint256', indexed: false },
      { name: 'feeAmount', type: 'uint256', indexed: false },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'outputAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'InsufficientOutput',
    type: 'error',
    inputs: [
      { name: 'actual', type: 'uint256' },
      { name: 'minimum', type: 'uint256' },
    ],
  },
] as const

// ── Swap defaults ────────────────────────────────────────
export const DEFAULT_SLIPPAGE = 0.5
export const QUOTE_REFRESH_MS = 15_000
export const INPUT_DEBOUNCE_MS = 500
export const QUOTE_TIMEOUT_MS = 10_000
// [SPRINT-9J J2] Swap-BUILD (calldata) timeout/retry. The build is idempotent
// (it never broadcasts a tx), so a transient/timeout failure can be retried
// safely. Two attempts × 12s = 24s, comfortably inside the route's maxDuration
// (60s) so the function fails fast as clean JSON instead of a platform HTML 504.
export const SWAP_BUILD_TIMEOUT_MS = 12_000
export const SWAP_BUILD_MAX_ATTEMPTS = 2
export const SWAP_BUILD_RETRY_BACKOFF_MS = 400
// [SPRINT-9J review F2] Upper bound on a CONSENTABLE Chainlink-vs-execution
// deviation. 2–15% is plausible price impact on an illiquid route (the user's
// max slippage is 15%), so it stays informed-consent. A deviation beyond this
// ceiling, against a HEALTHY oracle, is not normal impact — it's almost
// certainly manipulation or a broken quote → hard-block (no click-through).
export const PRICE_IMPACT_CONSENT_CEILING = 0.25 // 25%
// [SPRINT-9J review F1] Consent is granted for a specific deviation; it stays
// valid only while the live deviation doesn't worsen by more than this tolerance.
// A quote refresh that escalates the impact beyond accepted+tolerance re-arms the
// checkbox so the user explicitly re-accepts the worse price. Small jitter within
// the band does not nag.
export const PRICE_IMPACT_CONSENT_TOLERANCE = 0.005 // 0.5%

// ── [SPRINT-9W-oracle] cbETH depeg / manipulation circuit-breaker ──────────────
// A SECOND, independent safety use of an asset's exchange-rate (redemption) feed,
// on the divergence between its MARKET price feed and its EXCHANGE-RATE feed:
//   divergence = |market − exchangeRate| / exchangeRate
// (The swap-price reference itself is UNCHANGED — it stays the market feed, 9V.)
// Justification for the thresholds: cbETH's market price tracks its protocol
// redemption rate closely — the normal market-vs-ER spread is WELL under 1%. So a
// 2% divergence already signals an abnormal dislocation (depeg, pool attack, or a
// manipulated market feed), and 10% is a near-certain depeg/manipulation. These
// mirror the 9J band shape (warn → consent, ceiling → hard block) but are tuned to
// the much tighter normal spread of a liquid-staking token vs its redemption rate.
export const DEPEG_DIVERGENCE_WARN = 0.02   // 2%  — informed-consent band starts
export const DEPEG_DIVERGENCE_BLOCK = 0.10  // 10% — hard block (no click-through)
// Consent is granted for a specific divergence and auto-revokes if it worsens past
// accepted + this tolerance (mirrors PRICE_IMPACT_CONSENT_TOLERANCE).
export const DEPEG_CONSENT_TOLERANCE = 0.005 // 0.5%

// [LP-04] Smart MEV preference threshold.
// When the user has NOT toggled "Force MEV Protection" on, the SwapBox
// auto-routes through CoW Protocol (or any other mevProtected source)
// if its quoted output is within this fraction of the highest non-CoW
// output AND the gasless engine reports it as net-positive for the
// user. 0.0015 = 15 bps — tight enough that the price shortfall is
// always smaller than the gas savings CoW provides.
export const MEV_PREFERENCE_THRESHOLD = 0.0015

// ── [LP-08] Public API key tiers ─────────────────────────
// Limits applied per-key via sliding-window KV rate limiting. Both
// windows are enforced — a request must satisfy BOTH per-minute and
// per-day quotas or auth returns 429.
//
// Changing a tier's limits here does NOT retroactively change existing
// rows in `api_keys` — the per-key columns rate_limit_per_min /
// rate_limit_per_day are snapshot-on-create. Use the admin route to
// re-issue with the new tier defaults or update existing rows directly
// in Supabase.

export type ApiKeyTier = 'free' | 'pro' | 'enterprise'

export interface ApiKeyTierLimits {
  perMin: number
  perDay: number
}

export const API_KEY_TIERS: Record<ApiKeyTier, ApiKeyTierLimits> = {
  free: { perMin: 10, perDay: 100 },
  pro: { perMin: 60, perDay: 10_000 },
  enterprise: { perMin: 300, perDay: 100_000 },
}

/** Validate a tier name received from an untrusted source. */
export function isApiKeyTier(value: unknown): value is ApiKeyTier {
  return value === 'free' || value === 'pro' || value === 'enterprise'
}

// ── Contracts ────────────────────────────────────────────
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

/**
 * [ADR-021] 0x API v2 AllowanceHolder — the swap target (`transaction.to`) AND the
 * ERC-20 approval spender of the `/swap/allowance-holder/*` endpoint family.
 *
 * Deterministic: the SAME address on every chain 0x deploys it to. Already hardcoded
 * (pre-ADR-021) as the `'0x'` entry for Base + Arbitrum in chains/routers.ts; a test
 * pins this constant against both of those literals so the three cannot drift.
 *
 * Verified on Ethereum mainnet 2026-09-03 via public RPC `eth_getCode`:
 * 1009 bytes of runtime code, whose dispatch table contains BOTH selectors we rely on —
 * `exec` (0x2213bc0b, the swap entry point) and `transferFrom` (0x15dacbea, how it pulls
 * the taker's ERC-20, which is why the taker approves THIS address and not Permit2).
 *
 * Unlike 0x's Settler (the permit2 endpoint's `transaction.to`), this address does NOT
 * rotate between 0x releases — which is the whole reason it can be whitelisted at all.
 */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734' as const

// CoW Protocol contracts
export const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const
export const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const

// Odos Router V3 (same address on all EVM chains)
export const ODOS_ROUTER_V3 = '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559' as const

// Uniswap V3 contracts (Ethereum mainnet)
export const UNISWAP_SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const
export const UNISWAP_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const

// Uniswap V3 fee tiers (in hundredths of a bip)
export const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000] as const // 0.01%, 0.05%, 0.3%, 1%

export const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const

export const CHAINLINK_FEEDS: Record<string, `0x${string}`> = {
  // ── Stablecoins ──
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', // USDC/USD
  '0xdac17f958d2ee523a2206206994597c13d831ec7': '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', // USDT/USD
  '0x6b175474e89094c44da98b954eedeac495271d0f': '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9', // DAI/USD
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': '0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961', // USDe/USD
  '0x853d955acef822db058eb8505911ed77f175b99e': '0xB9E1E3A9feFf48998E45Fa90847ed4D467E8BcfD', // FRAX/USD
  '0x5f98805a4e8be255a32880fdec7f6728c6568ba0': '0x3D7aE7E594f2f2091Ad8798313450130d0Aba3a0', // LUSD/USD
  // ── Blue chips ──
  // [FIX-MAINNET-FEED-REMEDIATION] WBTC (0x2260…c599) MOVED to COMPOSED_FEEDS_BY_CHAIN[1] —
  // WBTC/USD = WBTC/BTC × BTC/USD. It was mapped to 0xF4030086… which self-reports "BTC / USD":
  // the canonical BTC *index* feed, blind to a WBTC-vs-BTC depeg. That address is retained as the
  // composition's QUOTE leg; the WBTC/BTC base leg is new. A direct WBTC/USD feed does not exist
  // on mainnet. Composed entries must NOT appear here — resolveFeed consults the composed map only
  // when this direct lookup returns null.
  '0x514910771af9ca656af840dff83e8264ecf986ca': '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c', // LINK/USD
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': '0x553303d460EE0afB37EdFf9bE42922D8FF63220e', // UNI/USD
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9', // AAVE/USD
  '0xc00e94cb662c3520282e6f5717214004a7f26888': '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5', // COMP/USD
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': '0xec1D1B3b0443256cc3860e24a46F108e699484Aa', // MKR/USD
  '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f': '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699', // SNX/USD
  // [FIX-MAINNET-FEED-REMEDIATION] GRT (0xc944…44a7) MOVED to COMPOSED_FEEDS_BY_CHAIN[1] — the
  // address it was mapped to is the GRT/ETH feed ("GRT / ETH", 18dp), read here as if it were USD.
  // Same address, now correctly composed against ETH/USD.
  // ── DeFi governance ──
  '0xd533a949740bb3306d119cc777fa900ba034cd52': '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f', // CRV/USD
  '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e': '0xA027702dbb89fbd58938e4324ac03B58d812b0E1', // YFI/USD
  '0xba100000625a3754423978a60c9317c58a424e3d': '0xdF2917806E30300537aEB49A7663062F4d1F2b5F', // BAL/USD
  '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2': '0xCc70F09A6CC17553b2E31954cD36E4A2d89501f7', // SUSHI/USD
  // ── LSDs & others ──
  // [FIX-MAINNET-FEED-REMEDIATION] LDO (0x5a98…1b32) MOVED to COMPOSED_FEEDS_BY_CHAIN[1] — its
  // address is the LDO/ETH feed ("LDO / ETH", 18dp). Same address, now composed against ETH/USD.
  // [FIX-MAINNET-FEED-REMEDIATION] APE — address CORRECTED. Was 0xD10aBbC7…b37571, which has ZERO
  // on-chain code: hand-transcribed hex drift from the real APE/USD proxy 0xD10aBbC7…b37056 (same
  // 36-char prefix, last 4 differ). New address sourced from Chainlink's official reference-data
  // directory (ens "ape-usd") and confirmed on-chain: description() "APE / USD", decimals() 8.
  '0x4d224452801aced8b2f0aebe155379bb5d594381': '0xD10aBbC76679a20055E167BB80A24ac851b37056', // APE/USD
  '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676', // MATIC/USD
  '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': '0x5C00128d4d1c2F4f652C267d7bcdD7aC99C16E16', // ENS/USD
  '0x111111111117dc0aa78b770fa6a738034120c302': '0xc929ad75B72593967DE83E7F7Cda0493458261D9', // 1INCH/USD
  '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0': '0x6Ebc52C8C1089be9eB3945C4350B68B8E4C2233f', // FXS/USD
  '0xd33526068d116ce69f19a9ee46f0bd304f21a51f': '0x4E155eD98aFE9034b7A5962f6C84c86d869daA9d', // RPL/USD
  // ── Liquid staking ──
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': '0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8', // stETH/USD
  // TODO: rETH (0xae78736cd615f374d3085123a210448e74fc6393) → 0x536218f9E9Eb48863970252233c8F271f554C2d0 — ETH-denominated feed, needs conversion before evaluateDeviation() can compare against USD execution prices.
  // TODO: wstETH (0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0) → 0x4F67e4d9BD67eFa28236013288737D39AeF48e79 — stETH-denominated feed, needs conversion before evaluateDeviation() can compare against USD execution prices.
  // ── Meme / popular ──
  // [FIX-MAINNET-FEED-REMEDIATION] SHIB (0x95ad…c4ce) MOVED to COMPOSED_FEEDS_BY_CHAIN[1] — its
  // address is the SHIB/ETH feed ("SHIB / ETH", 18dp). Same address, now composed against ETH/USD.
  // [FIX-MAINNET-FEED-REMEDIATION] PEPE — UNRESOLVED, deliberately left as-is and therefore still
  // BLOCKED by the ADR-018 guard. 0x02DE28aB… has zero on-chain code, and Chainlink publishes NO
  // PEPE feed of any denomination on Ethereum mainnet: a search of the official reference-data
  // directory (feeds-mainnet.json, 316 entries, fetched 2026-07-29) returns zero matches for PEPE
  // in either `name` or `ens`. There is no correct address to substitute, so per the remediation's
  // no-unverified-address rule nothing is changed here. Fail-closed is the correct end state until
  // Chainlink publishes one; PEPE prices via the DefiLlama/multi-source path meanwhile.
  '0x6982508145454ce325ddbe47a25d4ec3d2311933': '0x02DE28aB3C28A5B1E8236B1069a211b7494F0f35', // PEPE/USD — UNRESOLVED (dead address, no feed exists)
  // ── Commodities ──
  // [FIX-MAINNET-FEED-REMEDIATION] PAXG — address CORRECTED. Was 0x9B97304E…f269e, a live proxy
  // whose aggregator() is address(0) so every read reverts (a retired deployment). New address
  // sourced from Chainlink's official reference-data directory (ens "paxg-usd") and confirmed
  // on-chain: description() "PAXG / USD", decimals() 8.
  '0x45804880de22913dafe09f4980848ece6ecbaf78': '0x9944D86CEB9160aF5C5feB251FD671923323f8C3', // PAXG/USD
}

// ── Native ETH ───────────────────────────────────────────
export const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const

// ── Etherscan ────────────────────────────────────────────
export const ETHERSCAN_TX = 'https://etherscan.io/tx/'

// ── Price deviation (Chainlink) ─────────────────────────
// [L-02] Tightened for mainnet safety: block at 3% (was 5%).
// A 5% deviation on mainnet blue-chips is almost certainly a
// stale oracle or price manipulation attack. 3% covers normal
// volatility while catching anomalies earlier.
export const PRICE_DEVIATION_WARN = 0.02  // 2%
export const PRICE_DEVIATION_BLOCK = 0.03 // 3% — tightened from 5%

// ── Oracle Unavailable Protection ───────────────────────
// When no Chainlink feed exists for a token, we can't independently verify the
// swap price. Large swaps on unverified tokens are extremely dangerous (see: $50M
// aEthUSDT→aEthAAVE incident via CoW Protocol, where aggregators couldn't price
// wrapped Aave tokens). These thresholds add friction for unverified swaps.
/** USD value above which unverified swaps show a strong warning */
export const UNVERIFIED_SWAP_WARN_USD = 1_000
/** USD value above which unverified swaps are hard-blocked */
export const UNVERIFIED_SWAP_BLOCK_USD = 10_000

// ── Permit2 Security ────────────────────────────────────
/** Maximum signature deadline for Permit2 signatures (30 minutes) */
export const PERMIT2_MAX_DEADLINE_SEC = 30 * 60 // 1800 seconds
/** Maximum expiration for Permit2 allowances (24 hours) */
export const PERMIT2_MAX_EXPIRATION_SEC = 24 * 60 * 60 // 86400 seconds

// ── CoW Protocol Order Limits ───────────────────────────
// [L-04] Separate constant for CoW order duration — CoW solvers need more time
// than Permit2 signatures. 30 min matches the typical solver auction window.
/** Maximum CoW Protocol order validity (30 minutes) */
export const COW_MAX_ORDER_DURATION_SEC = 30 * 60 // 1800 seconds

// ── Chainlink Staleness ─────────────────────────────────
/** Max age for Chainlink data before considered stale (1 hour) */
export const CHAINLINK_MAX_STALENESS_SEC = 3600
