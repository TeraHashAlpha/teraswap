import type { AggregatorName } from './constants'

// ── Analytics Event Types ────────────────────────────────────
// Every trackable interaction in the protocol

export type TradeType = 'swap' | 'dca_buy' | 'limit_fill' | 'sltp_trigger'

export interface TradeEvent {
  /** Unique ID (txHash or generated UUID) */
  id: string
  /** Type of trade */
  type: TradeType
  /** Wallet address (checksummed) */
  wallet: string
  /** Unix timestamp (ms) */
  timestamp: number
  /** Hour of day (0-23) for time-of-day analysis */
  hour: number
  /** Token sold */
  tokenIn: string
  tokenInAddress: string
  /** Token bought */
  tokenOut: string
  tokenOutAddress: string
  /** Human-readable input amount */
  amountIn: string
  /** Human-readable output amount */
  amountOut: string
  /** Estimated USD value of the trade */
  volumeUsd: number
  /** Fee in USD */
  feeUsd: number
  /** Winning aggregator source */
  source: AggregatorName
  /** Transaction hash (if available) */
  txHash: string
  /** Chain ID */
  chainId: number
}

export interface WalletProfile {
  /** Wallet address */
  address: string
  /** Total number of trades */
  tradeCount: number
  /** Total volume in USD */
  totalVolumeUsd: number
  /** First interaction timestamp */
  firstSeen: number
  /** Last interaction timestamp */
  lastSeen: number
  /** Distinct trade types used */
  typesUsed: Set<TradeType>
  /** Favourite pair (most traded) */
  topPair: string
}

// ── Aggregated Metrics ──

export interface PeriodMetrics {
  totalVolume: number
  totalFees: number
  tradeCount: number
  uniqueWallets: number
}

export interface SourceMetrics {
  source: AggregatorName
  tradeCount: number
  volumeUsd: number
  winRate: number // % of times this source won the quote
}

export interface HourlyVolume {
  hour: number // 0-23
  volumeUsd: number
  tradeCount: number
}

export interface PairMetrics {
  pair: string // e.g. "ETH/USDC"
  tradeCount: number
  volumeUsd: number
}

export interface DashboardData {
  /** All-time metrics */
  allTime: PeriodMetrics
  /** Last 24h */
  last24h: PeriodMetrics
  /** Last 7 days */
  last7d: PeriodMetrics
  /** Last 30 days */
  last30d: PeriodMetrics
  /** Volume per aggregator */
  bySource: SourceMetrics[]
  /** Volume per hour of day (all-time) */
  byHour: HourlyVolume[]
  /** Top traded pairs */
  topPairs: PairMetrics[]
  /** Unique wallet profiles */
  wallets: WalletProfile[]
  /** Total unique wallets */
  totalWallets: number
  /** Recent trades (latest 50) */
  recentTrades: TradeEvent[]
  /** Daily volume for chart (last 30 days) */
  dailyVolume: Array<{ date: string; volumeUsd: number; tradeCount: number }>
}

// ── Storage key ──
export const ANALYTICS_STORAGE_KEY = 'teraswap_analytics_events'
export const ANALYTICS_VERSION = 1
