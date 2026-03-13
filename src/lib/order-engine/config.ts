/**
 * TeraSwapOrderExecutor v2 — Contract addresses & config
 */

// ── Contract address (mainnet) ───────────────────────────
// Deployed TeraSwapOrderExecutor v2 on Ethereum mainnet.
// Env var override available for migration/upgrade scenarios.
export const ORDER_EXECUTOR_ADDRESS = (
  process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS ??
  '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
) as `0x${string}`

// ── EIP-712 domain ───────────────────────────────────────
// [H-05] chainId must NOT be `as const` — it's set dynamically from the
// connected wallet's chain to match the contract's deployment chain.
// Using `as const` prevented runtime updates and hardcoded chainId: 1.
export function getOrderExecutorDomain(chainId: number) {
  return {
    name: 'TeraSwapOrderExecutor' as const,
    version: '2' as const,
    chainId,
    verifyingContract: ORDER_EXECUTOR_ADDRESS,
  }
}

/** @deprecated Use getOrderExecutorDomain(chainId) instead */
export const ORDER_EXECUTOR_DOMAIN = {
  name: 'TeraSwapOrderExecutor',
  version: '2',
  chainId: 1,
  verifyingContract: ORDER_EXECUTOR_ADDRESS,
}

// ── Default whitelisted routers ──────────────────────────
// These are the DEX routers that are whitelisted in the contract.
// Users must select one when creating an order.
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
    address: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57' as `0x${string}`,
    label: 'Paraswap Augustus v6',
  },
  uniswapV3: {
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
