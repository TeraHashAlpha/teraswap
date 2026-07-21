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

// ── v3 executor addresses (per chain) — NOT DEPLOYED ─────
// [SPRINT-V3-P2] TeraSwapOrderExecutorV3 (ADR-013 §1–§3, audit-approved SHA 954c415) is a
// NEW, separately-deployed contract per chain — v2 is not upgradeable. null = v3 signing is
// DISABLED on that chain and the v2 flow above is completely untouched. Set an entry here
// ONLY after a real OrderExecutorV3 is deployed + verified on that chain (same fail-closed
// convention as ORDER_EXECUTOR_BY_CHAIN — "v3 enabled" means an EXPLICIT non-null address
// here, never implied by anything else, e.g. never "v2 configured ⇒ v3 configured").
export const ORDER_EXECUTOR_V3_BY_CHAIN: Record<number, `0x${string}` | null> = {
  1: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS || null) as `0x${string}` | null,
  8453: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE || null) as `0x${string}` | null,
  // [SPRINT-48-ARBITRUM-DCA-PREP] Shipped DARK — no OrderExecutorV3 is deployed on Arbitrum yet.
  // Exact Base pattern: unset env ⇒ null ⇒ v3 signing stays disabled here, byte-identical to
  // before this entry existed.
  42161: (process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM || null) as `0x${string}` | null,
}

// Invariant: "no two chains share a verifyingContract" — catches a config typo where the
// same v3 address is pasted for two chains (each chain's domain still includes its own
// chainId, so signatures can't actually cross-execute, but a shared address is a smell that
// almost certainly means the wrong address was configured for one of the chains).
{
  const configured = Object.values(ORDER_EXECUTOR_V3_BY_CHAIN).filter(
    (a): a is `0x${string}` => a !== null,
  )
  const unique = new Set(configured.map(a => a.toLowerCase()))
  if (unique.size !== configured.length) {
    throw new Error('ORDER_EXECUTOR_V3_BY_CHAIN: the same v3 address is configured on two chains')
  }
}

/** Resolve the OrderExecutorV3 for a chain, or null when v3 isn't deployed there (fail-closed). */
export function getOrderExecutorV3(chainId: number): `0x${string}` | null {
  return ORDER_EXECUTOR_V3_BY_CHAIN[chainId] ?? null
}

/**
 * [BUG-DCA-APPROVE-SPENDER-V3] Resolve the executor a caller must trust for a given order, using
 * the EXACT branch the signing path (useOrderEngine confirmOrder) uses: `order.maxSlippageBps !==
 * undefined` ⇒ v3, else v2. This is the SINGLE SOURCE OF TRUTH for "who is the spender/verifying
 * contract for this order" — callers that need to independently resolve the executor (e.g. the
 * pre-sign ERC-20 approval gate) MUST go through this function instead of re-deriving the v2/v3
 * branch themselves, so the approve() spender and the EIP-712 verifyingContract can never diverge
 * by construction. (Divergence bug: the approval flow called getOrderExecutor(chainId) directly —
 * always v2 — while signing correctly branched to v3, so a v3 DCA order's funds were approved to
 * the v2 executor and the v3 executor was left at zero allowance; the keeper then skipped every
 * cycle with "Insufficient allowance".)
 */
export function resolveSigningExecutor(chainId: number, isV3Order: boolean): `0x${string}` | null {
  return isV3Order ? getOrderExecutorV3(chainId) : getOrderExecutor(chainId)
}

/**
 * [SPRINT-V3-P2] v3 EIP-712 domain: version "3" (vs v2's "2"), so a v2 signature can never be
 * replayed against v3 and vice-versa — mirrors the contract's EIP712("TeraSwapOrderExecutor","3")
 * constructor. Throws when v3 has no address on this chain — callers MUST check
 * getOrderExecutorV3(chainId) first and take the v2 path instead (fail-closed while null).
 */
export function getOrderExecutorV3Domain(chainId: number) {
  const verifyingContract = getOrderExecutorV3(chainId)
  if (!verifyingContract) {
    throw new Error(
      `No OrderExecutorV3 deployed on chain ${chainId} — v3 conditional orders are unavailable there`,
    )
  }
  return {
    name: 'TeraSwapOrderExecutor' as const,
    version: '3' as const,
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

// ── Base (8453) whitelisted routers ──────────────────────
// [chore/dca-router-chainaware] Conditional orders sign `order.router`, and the
// keeper must build calldata for THAT router (executeOrder approves + calls it).
// These are the routers that are BOTH (a) whitelisted on the Base OrderExecutor
// (0x135B339902Ea4E0fB4CF059961dc8856bA1D2598 — verified on-chain via
// whitelistedRouters()) AND (b) serveable by /api/swap (so the keeper can fetch
// matching calldata): Augustus V6 ← source `velora`, SwapRouter02 ← source
// `uniswapv3`. 1inch v6 is also whitelisted on-chain but /api/swap CANNOT build
// 1inch calldata on Base (HTTP 502) — deliberately EXCLUDED so orders never
// commit an unserveable router (the original SwapFailed root cause, PR #225).
const BASE_ROUTERS: Record<string, RouterEntry> = {
  augustusV6: {
    address: '0x6A000F20005980200259B80c5102003040001068' as `0x${string}`,
    label: 'ParaSwap Augustus v6',
  },
  uniswapV3: {
    address: '0x2626664c2603336E57B271c5C0b26F421741e481' as `0x${string}`,
    label: 'Uniswap SwapRouter02',
  },
}

const ROUTERS_BY_CHAIN: Record<number, Record<string, RouterEntry>> = {
  1: MAINNET_ROUTERS,
  8453: BASE_ROUTERS,
}

// The router-map key whose entry is committed by default at order creation.
const DEFAULT_ROUTER_KEY_BY_CHAIN: Record<number, string> = {
  1: '1inch',         // mainnet unchanged
  8453: 'augustusV6', // Base → Augustus V6 (serveable via /api/swap `velora`)
}

/**
 * Get whitelisted routers for a given chainId. Unknown chains fall back to the
 * mainnet map (mainnet behaviour byte-identical). [chore/dca-router-chainaware]
 */
export function getWhitelistedRouters(chainId: number): Record<string, RouterEntry> {
  return ROUTERS_BY_CHAIN[chainId] ?? MAINNET_ROUTERS
}

/** Default router for a given chainId (the one order creation commits). */
export function getDefaultRouter(chainId: number): RouterEntry {
  const routers = getWhitelistedRouters(chainId)
  const key = DEFAULT_ROUTER_KEY_BY_CHAIN[chainId] ?? '1inch'
  return routers[key] ?? MAINNET_ROUTERS['1inch']
}

/**
 * [SPRINT-P1B / ADR-014 option (a)] The router key used for PINNED canonical routes (non-DCA
 * Limit/Take-Profit on v3). Deliberately NOT `getDefaultRouter` — that resolves to Augustus V6 on
 * Base, whose calldata embeds quoted amounts and deadlines and therefore cannot be pinned at
 * signing. Only a canonical Uniswap V3 route is quote-free (see canonical-route.ts).
 */
export const CANONICAL_ROUTE_ROUTER_KEY = 'uniswapV3'

/**
 * Resolve the SwapRouter02 entry a pinned route must commit to, or null when this chain has no
 * canonical router in its whitelisted set.
 *
 * Fail-closed by construction: the entry is looked up FROM the chain's already-whitelisted router
 * map, so this can never widen the whitelist — it can only select a router the executor already
 * accepts.
 */
export function getCanonicalRouteRouter(chainId: number): RouterEntry | null {
  const routers = getWhitelistedRouters(chainId)
  return routers[CANONICAL_ROUTE_ROUTER_KEY] ?? null
}

/**
 * True when `router` is a member of this chain's whitelisted set. Used as an assertion before
 * signing a pinned route — never as a way to add a router.
 */
export function isWhitelistedRouter(chainId: number, router: string): boolean {
  const routers = getWhitelistedRouters(chainId)
  return Object.values(routers).some(r => r.address.toLowerCase() === router.toLowerCase())
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

// [CHORE-DCA-PRELAUNCH-FIXES] Minimum order amount, in token base units — the SINGLE
// SOURCE OF TRUTH mirroring the on-chain constant
//   TeraSwapOrderExecutor.sol:126  `uint256 public constant MIN_ORDER_AMOUNT = 10_000;`
// (pinned by contracts/order-engine/test-run.js: "MIN_ORDER_AMOUNT is 10000"). Used by the
// client pre-sign guard (useOrderEngine) AND the server create-order API so the client floor
// and the contract floor can't drift. For DCA this applies PER EXECUTION
// (floor(amountIn / dcaTotal)); below it the contract reverts DCAChunkTooSmall / OrderTooSmall.
export const MIN_ORDER_AMOUNT = 10_000n

// ── Presets for expiry ───────────────────────────────────
export const EXPIRY_PRESETS = [
  { label: '1h',  seconds: 3600 },
  { label: '24h', seconds: 86400 },
  { label: '7d',  seconds: 604800 },
  { label: '30d', seconds: 2592000 },
  { label: '90d', seconds: 7776000 },
] as const

// ── DCA interval presets ─────────────────────────────────
// [chore/dca-ux-tweaks] 1h (3600s) added as the first option (server accepts
// dcaInterval ≥ 60s). Prepending shifts indices — DCAPanel's default intervalIdx
// is bumped to keep 1d the default.
export const DCA_INTERVAL_PRESETS = [
  { label: '1h',  seconds: 3600 },
  { label: '4h',  seconds: 14400 },
  { label: '8h',  seconds: 28800 },
  { label: '12h', seconds: 43200 },
  { label: '1d',  seconds: 86400 },
  { label: '3d',  seconds: 259200 },
  { label: '7d',  seconds: 604800 },
] as const

// ── DCA total presets ────────────────────────────────────
// [chore/dca-ux-tweaks] dropped 7 + 14, added 15 + 20. The per-chunk
// MIN_ORDER_AMOUNT floor (DCAPanel) still gates 20/30 on a small total.
export const DCA_TOTAL_PRESETS = [3, 5, 10, 15, 20, 30] as const
