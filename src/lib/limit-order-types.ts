import type { Token } from './tokens'

// ── Order kind ────────────────────────────────────────────
export type LimitOrderKind = 'sell' | 'buy'

// ── Expiry presets ────────────────────────────────────────
export const LIMIT_EXPIRY_PRESETS = [
  { label: '1 hour',  seconds: 60 * 60 },
  { label: '24 hours', seconds: 24 * 60 * 60 },
  { label: '7 days',  seconds: 7 * 24 * 60 * 60 },
  { label: '30 days', seconds: 30 * 24 * 60 * 60 },
  { label: '90 days', seconds: 90 * 24 * 60 * 60 },
] as const

export type LimitExpirySeconds = (typeof LIMIT_EXPIRY_PRESETS)[number]['seconds']

// ── Order status (mirrors CoW API status) ──────────────────
export type LimitOrderStatus =
  | 'signing'        // waiting for wallet signature
  | 'open'           // submitted to orderbook, waiting for fill
  | 'partiallyFilled' // some amount filled
  | 'fulfilled'      // fully filled
  | 'expired'        // validTo passed without fill
  | 'cancelled'      // user cancelled
  | 'error'          // submission failed

// ── Configuration for creating a limit order ───────────────
export interface LimitOrderConfig {
  tokenIn: Token
  tokenOut: Token
  sellAmount: string          // raw bigint string — amount of tokenIn to sell
  targetPrice: number         // desired rate: how many tokenOut per tokenIn
  kind: LimitOrderKind
  expirySeconds: number       // seconds from now
  partiallyFillable: boolean  // allow partial fills
  slippage: number            // % tolerance on top of target price (default 0)
}

// ── A submitted limit order ────────────────────────────────
export interface LimitOrder {
  id: string                  // local UUID
  orderUid: string            // CoW Protocol order UID (56 bytes hex)
  config: LimitOrderConfig

  // Computed
  buyAmount: string           // raw bigint string — target tokenOut amount
  validTo: number             // Unix timestamp (seconds)

  // Status
  status: LimitOrderStatus
  filledAmount: string        // raw bigint string — how much tokenOut filled so far
  filledPercent: number       // 0-100

  // Result
  txHash: string | null
  executedAt: number | null

  // Meta
  createdAt: number           // epoch ms
  error: string | null
}

// ── Events for UI reactivity ──────────────────────────────
export type LimitOrderEvent =
  | { type: 'order_created'; orderId: string }
  | { type: 'order_signed'; orderId: string; orderUid: string }
  | { type: 'order_filled'; orderId: string; txHash: string }
  | { type: 'order_partially_filled'; orderId: string; filledPercent: number }
  | { type: 'order_expired'; orderId: string }
  | { type: 'order_cancelled'; orderId: string }
  | { type: 'order_error'; orderId: string; error: string }

// ── localStorage key ──────────────────────────────────────
export const LIMIT_STORAGE_KEY = 'teraswap:limit:orders'

// ── Poll interval for checking order status ────────────────
export const LIMIT_POLL_INTERVAL_MS = 10_000 // 10 seconds
