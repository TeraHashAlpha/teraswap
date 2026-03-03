/**
 * TeraSwap — Conditional Order Types (Stop Loss + Take Profit)
 *
 * Conditional orders monitor on-chain price via Chainlink oracles.
 * When the trigger condition is met, a CoW Protocol limit order is
 * automatically submitted on behalf of the user.
 */

import type { Token } from './tokens'

// ── Order type ─────────────────────────────────────────────
export type ConditionalOrderType = 'stop_loss' | 'take_profit'

// ── Trigger condition ──────────────────────────────────────
export type TriggerDirection = 'above' | 'below'

// ── Status ─────────────────────────────────────────────────
export type ConditionalOrderStatus =
  | 'monitoring'      // watching price, not yet triggered
  | 'triggered'       // price condition met, submitting order
  | 'submitted'       // CoW order submitted, waiting fill
  | 'filled'          // order fully filled
  | 'partiallyFilled' // partially filled
  | 'expired'         // order expired after trigger
  | 'cancelled'       // user cancelled before trigger
  | 'error'           // something went wrong

// ── Configuration ──────────────────────────────────────────
export interface ConditionalOrderConfig {
  type: ConditionalOrderType
  tokenIn: Token               // token to sell when triggered
  tokenOut: Token              // token to receive
  sellAmount: string           // raw bigint string
  triggerPrice: number         // USD price that triggers the order
  triggerDirection: TriggerDirection // 'below' for SL, 'above' for TP
  limitPrice: number           // limit price (tokenOut per tokenIn) for the CoW order
  expirySeconds: number        // how long the CoW order lives after trigger
  partiallyFillable: boolean
}

// ── A conditional order ────────────────────────────────────
export interface ConditionalOrder {
  id: string
  config: ConditionalOrderConfig

  // Price monitoring
  monitorTokenAddress: string  // Chainlink feed reference (tokenIn address)
  currentPrice: number         // last polled price in USD
  triggerPrice: number         // USD price target

  // Status
  status: ConditionalOrderStatus
  orderUid: string | null      // CoW order UID (after trigger)
  filledPercent: number

  // Result
  txHash: string | null
  executedAt: number | null

  // Meta
  createdAt: number
  error: string | null
}

// ── Events ─────────────────────────────────────────────────
export type ConditionalOrderEvent =
  | { type: 'order_created'; orderId: string }
  | { type: 'price_triggered'; orderId: string; price: number }
  | { type: 'order_submitted'; orderId: string; orderUid: string }
  | { type: 'order_filled'; orderId: string; txHash: string }
  | { type: 'order_expired'; orderId: string }
  | { type: 'order_cancelled'; orderId: string }
  | { type: 'order_error'; orderId: string; error: string }

// ── Constants ──────────────────────────────────────────────
export const CONDITIONAL_STORAGE_KEY = 'teraswap:conditional:orders'
export const PRICE_POLL_INTERVAL_MS = 5_000 // 5 seconds — faster than limit orders
export const ORDER_POLL_INTERVAL_MS = 10_000 // 10 seconds for CoW order status
