/**
 * TeraSwapOrderExecutor v2 — Type definitions
 */

// ── Enums matching Solidity contract ─────────────────────
export enum OrderType {
  LIMIT = 0,
  STOP_LOSS = 1,
  DCA = 2,
}

export enum PriceCondition {
  ABOVE = 0,
  BELOW = 1,
}

// ── On-chain Order struct ────────────────────────────────
export interface OnChainOrder {
  owner: `0x${string}`
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  amountIn: bigint
  minAmountOut: bigint
  // [SPRINT-V3-P2 / ADR-013 §1] uint16, present ONLY on a v3-signed order. undefined ⇒ v2
  // order (v2 has no such field — no signing/hash/domain impact, byte-identical). A defined
  // value is the discriminator computeOrderHash/confirmOrder use to pick the v3 typehash +
  // domain (version "3") over v2's.
  maxSlippageBps?: number
  orderType: OrderType
  condition: PriceCondition
  targetPrice: bigint
  priceFeed: `0x${string}`
  expiry: bigint
  nonce: bigint
  router: `0x${string}`
  routerDataHash: `0x${string}`  // [C-01] keccak256 of routerData — prevents calldata substitution
  dcaInterval: bigint
  dcaTotal: bigint
}

// ── EIP-712 types for signing (v2) ───────────────────────
export const ORDER_EIP712_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'orderType', type: 'uint8' },
    { name: 'condition', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'priceFeed', type: 'address' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'routerDataHash', type: 'bytes32' },  // [C-01]
    { name: 'dcaInterval', type: 'uint256' },
    { name: 'dcaTotal', type: 'uint256' },
  ],
} as const

// ── EIP-712 types for signing (v3) [ADR-013 §1] ──────────
// Adds `maxSlippageBps` (uint16) right after minAmountOut — MUST mirror
// contracts/order-engine/TeraSwapOrderExecutorV3.sol's ORDER_TYPEHASH field-for-field
// (audit-approved SHA 954c415). A mismatch here would make recoverTypedDataAddress
// disagree with the contract's on-chain signer recovery — escalate as a P1 finding.
export const ORDER_V3_EIP712_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'maxSlippageBps', type: 'uint16' },  // [ADR-013 §1]
    { name: 'orderType', type: 'uint8' },
    { name: 'condition', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'priceFeed', type: 'address' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'routerDataHash', type: 'bytes32' },  // [C-01]
    { name: 'dcaInterval', type: 'uint256' },
    { name: 'dcaTotal', type: 'uint256' },
  ],
} as const

// The exact EIP-712 type string the v3 contract hashes for ORDER_TYPEHASH — pinned here so a
// unit test can assert byte-for-byte parity against the .sol source (read-only reference).
export const ORDER_V3_TYPE_STRING =
  'Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,' +
  'uint256 minAmountOut,uint16 maxSlippageBps,uint8 orderType,uint8 condition,' +
  'uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,' +
  'bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)'

// [ADR-013 §1/N3] Immutable on-chain cap — mirrors MAX_ORDER_SLIPPAGE_BPS in the v3 contract
// (uint16, no setter). Client-side enforcement is defense-in-depth only; the contract enforces
// regardless.
export const MAX_ORDER_SLIPPAGE_BPS = 500
// Phase-0 keeper band default (order-floor.js DCA_ORACLE_FLOOR_BPS) — the starting point shown
// to the user, adjustable up to MAX_ORDER_SLIPPAGE_BPS.
export const DEFAULT_MAX_SLIPPAGE_BPS = 300

// ── Order status (Supabase + UI) ─────────────────────────
export type AutonomousOrderStatus =
  | 'signing'       // User is signing EIP-712
  | 'active'        // Stored in Supabase, executor monitoring
  | 'executing'     // Executor is executing
  | 'filled'        // Successfully executed on-chain
  | 'partially_filled' // DCA: some executions done
  | 'cancelled'     // User cancelled on-chain
  | 'expired'       // Past expiry timestamp
  | 'error'         // Submission or execution error

// ── UI order record ──────────────────────────────────────
export interface AutonomousOrder {
  id: string                    // local UUID
  orderHash: string             // keccak256 of signed order
  order: OnChainOrder           // the raw order struct
  signature: string             // EIP-712 signature
  status: AutonomousOrderStatus
  orderType: OrderType
  // [CHORE-DCA-POSITIONS-DASHBOARD] Chain the order executes on (from orders.chain_id). Optional for
  // legacy/local records; consumers default to mainnet (1). DCA is Base (8453) → drives BaseScan links
  // + chain-keyed token logos.
  chainId?: number
  // Token metadata (for display)
  tokenInSymbol: string
  tokenInDecimals: number
  tokenOutSymbol: string
  tokenOutDecimals: number
  // DCA tracking
  dcaExecuted: number           // how many DCA fills completed
  dcaTotal: number              // total DCA executions
  // Timestamps
  createdAt: number
  executedAt: number | null
  expiresAt: number
  // Error info
  error: string | null
  // Execution result
  amountOut: string | null
  txHash: string | null
}

// ── Config for creating new orders ───────────────────────
export interface CreateOrderConfig {
  tokenIn: { address: string; symbol: string; decimals: number }
  tokenOut: { address: string; symbol: string; decimals: number }
  amountIn: string              // in wei
  minAmountOut: string          // in wei
  orderType: OrderType
  condition: PriceCondition
  targetPrice: string           // in 8 decimals (Chainlink format)
  priceFeed: string             // Chainlink feed address (0x0 = no condition)
  expirySeconds: number         // seconds from now
  router: string                // whitelisted DEX router
  /** Keccak256 hash of the router calldata (ZeroHash for DCA since calldata varies) */
  routerDataHash?: `0x${string}`
  /**
   * [SPRINT-P1B / ADR-014 option (a)] The FULL pinned router calldata for a non-DCA v3 order.
   * Persisted to Supabase (`order_data.routerData`) and replayed VERBATIM by the keeper at
   * trigger — the contract requires `keccak256(routerData) == routerDataHash`
   * (TeraSwapOrderExecutorV3.sol:465). Undefined for DCA (calldata is keeper-built per chunk).
   */
  routerData?: `0x${string}`
  // [SPRINT-V3-P2] Present ONLY when this order should sign against v3 (the caller already
  // checked getOrderExecutorV3(chainId) !== null). undefined ⇒ v2 order, byte-identical to
  // today. useOrderEngine uses its presence (not a separate flag) as the v2/v3 discriminator,
  // matching OnChainOrder.maxSlippageBps.
  maxSlippageBps?: number
  // DCA-specific
  dcaInterval?: number          // seconds between executions
  dcaTotal?: number             // total number of executions
}

// ── Events for UI reactivity ─────────────────────────────
export type OrderEngineEvent =
  | { type: 'order_created'; orderId: string; orderHash: string }
  | { type: 'order_signed'; orderId: string }
  | { type: 'order_cancelled'; orderId: string }
  | { type: 'order_filled'; orderId: string; txHash: string }
  | { type: 'order_error'; orderId: string; error: string }
  | { type: 'dca_execution'; orderId: string; executionNumber: number }
