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

// ── EIP-712 types for signing ────────────────────────────
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
