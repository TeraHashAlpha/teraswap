import type { AggregatorName } from './constants'
import type { Token } from './tokens'

// Re-export Token as DCAToken for clarity in DCA context
export type DCAToken = Token

// ── Interval presets ─────────────────────────────────────
export const DCA_INTERVALS = [
  { label: '4 hours',  ms: 4  * 60 * 60 * 1000 },
  { label: '8 hours',  ms: 8  * 60 * 60 * 1000 },
  { label: '12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: '1 day',    ms: 24 * 60 * 60 * 1000 },
  { label: '3 days',   ms: 3  * 24 * 60 * 60 * 1000 },
  { label: '7 days',   ms: 7  * 24 * 60 * 60 * 1000 },
] as const

export type DCAIntervalMs = (typeof DCA_INTERVALS)[number]['ms']

// ── Execution reason ─────────────────────────────────────
export type ExecutionReason =
  | 'price_below_yesterday'   // currentPrice < yesterdayPrice → buy immediately
  | 'dip_achieved'            // currentPrice dropped 0.3% from window-open price
  | 'window_expired'          // window closed, forced execution
  | 'manual'                  // user triggered manually

// ── Window status ────────────────────────────────────────
export type WindowStatus = 'pending' | 'active' | 'monitoring' | 'closed'

// ── Execution status ─────────────────────────────────────
export type ExecutionStatus =
  | 'scheduled'     // waiting for window to open
  | 'window_open'   // smart window active, monitoring prices
  | 'executing'     // swap in progress
  | 'executed'      // swap confirmed on-chain
  | 'failed'        // swap failed
  | 'skipped'       // cancelled before execution
  | 'awaiting_sig'  // waiting for user wallet signature

// ── Per-buy execution record ─────────────────────────────
export interface DCAExecution {
  id: string
  positionId: string
  index: number                     // 0-based (Buy #1 = index 0)
  amountIn: string                  // raw bigint string (capital / numberOfParts)

  // Schedule
  scheduledTime: number             // epoch ms — when the buy should happen
  windowOpenTime: number            // scheduledTime - (interval × 0.10)
  windowCloseTime: number           // = scheduledTime (deadline)

  // Price context (populated when window opens)
  priceAtWindowOpen: number | null  // Chainlink USD price when window opened
  priceYesterday: number | null     // Chainlink USD price ~24h ago
  targetDipPrice: number | null     // priceAtWindowOpen × 0.997

  // Status
  status: ExecutionStatus
  windowStatus: WindowStatus
  executionReason: ExecutionReason | null

  // Result
  executedAt: number | null
  amountOut: string | null          // raw bigint string — how much tokenOut received
  txHash: string | null
  source: AggregatorName | null     // which aggregator won
  error: string | null
}

// ── Position configuration ───────────────────────────────
export interface DCAConfig {
  id: string
  tokenIn: DCAToken
  tokenOut: DCAToken
  totalAmount: string               // raw bigint string — total capital to spend
  numberOfParts: number             // how many buys
  intervalMs: number                // time between buys
  amountPerPart: string             // totalAmount / numberOfParts (pre-calculated)
  slippage: number                  // e.g. 0.5 (%)
  createdAt: number
}

// ── Full DCA position ────────────────────────────────────
export interface DCAPosition {
  config: DCAConfig
  executions: DCAExecution[]
  status: 'active' | 'paused' | 'completed' | 'cancelled'

  // Aggregated stats
  totalExecuted: number             // count of executed buys
  totalSpent: string                // sum of amountIn for executed buys
  totalReceived: string             // sum of amountOut for executed buys
  averagePriceUsd: number | null    // derived

  // Timestamps
  startedAt: number | null
  pausedAt: number | null
  completedAt: number | null
}

// ── Smart window snapshot (for UI display) ───────────────
export interface SmartWindowSnapshot {
  positionId: string
  executionIndex: number
  windowStatus: WindowStatus
  priceAtWindowOpen: number | null
  priceYesterday: number | null
  currentPrice: number | null
  targetDipPrice: number | null
  percentFromTarget: number | null  // how far from 0.3% dip (negative = past target)
  timeRemainingMs: number           // ms until window closes
  reason: string                    // human-readable status line
}

// ── Engine events (for UI reactivity) ────────────────────
export type DCAEvent =
  | { type: 'position_created'; positionId: string }
  | { type: 'position_paused'; positionId: string }
  | { type: 'position_resumed'; positionId: string }
  | { type: 'position_cancelled'; positionId: string }
  | { type: 'position_completed'; positionId: string }
  | { type: 'window_opened'; positionId: string; executionIndex: number }
  | { type: 'price_update'; positionId: string; executionIndex: number; snapshot: SmartWindowSnapshot }
  | { type: 'execution_started'; positionId: string; executionIndex: number }
  | { type: 'awaiting_signature'; positionId: string; executionIndex: number }
  | { type: 'execution_success'; positionId: string; executionIndex: number; txHash: string }
  | { type: 'execution_failed'; positionId: string; executionIndex: number; error: string }

// ── localStorage keys ────────────────────────────────────
export const DCA_STORAGE_KEY = 'teraswap:dca:positions'

// ── Smart window constants ───────────────────────────────
export const WINDOW_OPEN_RATIO = 0.10        // window opens 10% of interval before scheduled time
export const DIP_THRESHOLD_PERCENT = 0.003   // 0.3% drop target
export const PRICE_POLL_INTERVAL_MS = 10_000 // poll Chainlink every 10s during window
export const HISTORICAL_PRICE_AGE_S = 86400  // 24 hours in seconds
