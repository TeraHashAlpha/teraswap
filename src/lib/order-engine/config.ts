/**
 * TeraSwapOrderExecutor v2 — Contract addresses & config
 */

// ── Contract addresses (per-chain) ───────────────────────
// [CHORE-ORDER-EXEC-PREP A] The OrderExecutor is chain-specific, and the same address means
// DIFFERENT contracts on different chains: 0xeFC31ADb…f130 is the OrderExecutor on MAINNET (has
// executeOrder) but a FeeCollector on BASE (swapTokenWithFee, NO executeOrder — different bytecode,
// same address). So the order engine MUST resolve per-chain and FAIL-CLOSED where no real
// OrderExecutor exists, or it would EIP-712-sign / execute / monitor against the wrong contract.
// Add a chain's address here ONLY after a real OrderExecutor is deployed + verified there.
export const ORDER_EXECUTOR_BY_CHAIN: Record<number, `0x${string}` | null> = {
  // Mainnet OrderExecutor (verified: has executeOrder). Env override kept for mainnet upgrades only.
  1: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS ??
    '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130') as `0x${string}`,
  // Base (8453): OrderExecutor deployed + verified (its own contract with executeOrder — a DIFFERENT
  // deployment from the Base FeeCollector at 0xeFC3…f130). Wired in CHORE-BASE-ORDER-EXECUTOR-WIRE.
  8453: '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598' as `0x${string}`,
}

/** Resolve the OrderExecutor for a chain, or null when none is deployed (caller must fail-closed). */
export function getOrderExecutor(chainId: number): `0x${string}` | null {
  return ORDER_EXECUTOR_BY_CHAIN[chainId] ?? null
}

/**
 * @deprecated Mainnet-only convenience alias = ORDER_EXECUTOR_BY_CHAIN[1]. New / chain-variant code
 * MUST use getOrderExecutor(chainId) and fail-closed on null. Retained only for mainnet-static
 * contexts (the on-chain monitor's mainnet target + tests).
 */
export const ORDER_EXECUTOR_ADDRESS = ORDER_EXECUTOR_BY_CHAIN[1] as `0x${string}`

// ── EIP-712 domain ───────────────────────────────────────
// [H-05] chainId must NOT be `as const` — it's set dynamically from the connected wallet's chain to
// match the contract's deployment chain. [CHORE-ORDER-EXEC-PREP A] verifyingContract is resolved
// per-chain and THROWS when the chain has no OrderExecutor — never sign/verify EIP-712 against a
// non-existent (or wrong-bytecode) executor. Mainnet (chainId 1) result is unchanged.
export function getOrderExecutorDomain(chainId: number) {
  const verifyingContract = getOrderExecutor(chainId)
  if (!verifyingContract) {
    throw new Error(
      `No OrderExecutor deployed on chain ${chainId} — conditional orders are unavailable there`,
    )
  }
  return {
    name: 'TeraSwapOrderExecutor' as const,
    version: '2' as const,
    chainId,
    verifyingContract,
  }
}

// ── EIP-712 cancel-order types [FULL-H-01] ───────────────
// The PATCH /api/orders/[id] cancel endpoint requires a cryptographic
// proof of ownership. The frontend signs this typed-data message and the
// server recovers the signer via recoverTypedDataAddress, comparing it to
// the order owner. Re-uses getOrderExecutorDomain(chainId) — same contract,
// same chain binding as order creation.
export const CANCEL_ORDER_TYPES = {
  CancelOrder: [
    { name: 'id', type: 'string' },     // Supabase order UUID
    { name: 'action', type: 'string' }, // Always "cancel" — prevents type collision
  ],
} as const

// ── Default whitelisted routers ──────────────────────────
// These are the DEX routers whitelisted in the OrderExecutor CONTRACT
// (0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130) — verified on-chain via
// whitelistedRouters(address) (E-1, REVIEW-QUALITY-2026-06-11). Users must
// select one when creating an order; the selection flows into the SIGNED
// order, so this map must mirror the contract exactly.
//
// NOT the same set as the FeeCollector/swap path: the instant-swap fee flow
// routes through Augustus V6 (0x6A000F20005980200259B80c5102003040001068,
// ADR-011), which the OrderExecutor does NOT whitelist. Do not "upgrade" the
// paraswap entry here to V6 — conditional orders would revert until an owner
// whitelist tx landed on the OrderExecutor.
// [H-01] Mainnet only — Sepolia routers removed for production.

type RouterEntry = { address: `0x${string}`; label: string }

const MAINNET_ROUTERS: Record<string, RouterEntry> = {
  '1inch': {
    address: '0x111111125421cA6dc452d289314280a0f8842A65' as `0x${string}`,
    label: '1inch v6',
  },
  '0x': {
    address: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF' as `0x${string}`,
    label: '0x Exchange Proxy',
  },
  paraswap: {
    // Augustus V5 — the address was always V5 and is whitelisted on the
    // OrderExecutor; only the LABEL wrongly said v6 (fixed, E-1).
    address: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57' as `0x${string}`,
    label: 'Paraswap Augustus v5',
  },
  uniswapV3: {
    // Uniswap V3 protocol's original SwapRouter (not SwapRouter02 — that one
    // is the swap path's router; the OrderExecutor whitelists this one).
    address: '0xE592427A0AEce92De3Edee1F18E0157C05861564' as `0x${string}`,
    label: 'Uniswap V3 SwapRouter',
  },
}

/** Get whitelisted routers for a given chainId */
export function getWhitelistedRouters(chainId: number): Record<string, RouterEntry> {
  // Only mainnet routers supported in production
  return MAINNET_ROUTERS
}

/** Default router for a given chainId */
export function getDefaultRouter(chainId: number): RouterEntry {
  return MAINNET_ROUTERS['1inch']
}

// Legacy export for backward compatibility (mainnet default)
export const WHITELISTED_ROUTERS = MAINNET_ROUTERS

// ── Chainlink price feeds ────────────────────────────────
type FeedEntry = { address: `0x${string}`; label: string; decimals: number }

const MAINNET_FEEDS: Record<string, FeedEntry> = {
  'ETH/USD':  { address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', label: 'ETH / USD',  decimals: 8 },
  'BTC/USD':  { address: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', label: 'BTC / USD',  decimals: 8 },
  'LINK/USD': { address: '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c', label: 'LINK / USD', decimals: 8 },
  'UNI/USD':  { address: '0x553303d460EE0afB37EdFf9bE42922D8FF63220e', label: 'UNI / USD',  decimals: 8 },
  'AAVE/USD': { address: '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9', label: 'AAVE / USD', decimals: 8 },
  'DAI/USD':  { address: '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9', label: 'DAI / USD',  decimals: 8 },
  'USDC/USD': { address: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', label: 'USDC / USD', decimals: 8 },
}

// [H-01] Sepolia Chainlink feeds removed for mainnet deployment.

/** Get Chainlink feeds for a given chainId */
export function getChainlinkFeeds(chainId: number): Record<string, FeedEntry> {
  // Only mainnet feeds supported in production
  return MAINNET_FEEDS
}

// Legacy export (mainnet default)
export const CHAINLINK_FEEDS = MAINNET_FEEDS

// ── Supabase config ──────────────────────────────────────
export const SUPABASE_ORDERS_TABLE = 'orders'
export const SUPABASE_EXECUTIONS_TABLE = 'order_executions'

// ── Order constraints ────────────────────────────────────
export const MAX_EXPIRY_DAYS = 90
export const MAX_ACTIVE_ORDERS = 20
export const ORDER_POLL_INTERVAL_MS = 10_000  // poll Supabase every 10s

// ── Presets for expiry ───────────────────────────────────
export const EXPIRY_PRESETS = [
  { label: '1h',  seconds: 3600 },
  { label: '24h', seconds: 86400 },
  { label: '7d',  seconds: 604800 },
  { label: '30d', seconds: 2592000 },
  { label: '90d', seconds: 7776000 },
] as const

// ── DCA interval presets ─────────────────────────────────
export const DCA_INTERVAL_PRESETS = [
  { label: '4h',  seconds: 14400 },
  { label: '8h',  seconds: 28800 },
  { label: '12h', seconds: 43200 },
  { label: '1d',  seconds: 86400 },
  { label: '3d',  seconds: 259200 },
  { label: '7d',  seconds: 604800 },
] as const

// ── DCA total presets ────────────────────────────────────
export const DCA_TOTAL_PRESETS = [3, 5, 7, 10, 14, 30] as const
