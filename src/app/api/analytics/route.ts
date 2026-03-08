import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'

/**
 * GET /api/analytics
 *
 * Server-side analytics dashboard data.
 * Queries the `swaps` table (real transaction data) and computes
 * all metrics needed by the AnalyticsDashboard component.
 *
 * This replaces the broken client-side analytics-tracker approach
 * which tried to use localStorage + a non-existent `trade_events` table.
 */
export async function GET() {
  const supabase = getSupabase()

  if (!supabase) {
    // Return empty dashboard so the UI still renders gracefully
    return NextResponse.json({ enabled: false, dashboard: emptyDashboard() })
  }

  try {
    // Fetch all swaps (limit 5000 for performance)
    const { data: swaps, error } = await supabase
      .from('swaps')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5000)

    if (error) {
      console.error('[analytics] Failed to query swaps:', error.message)
      return NextResponse.json({ enabled: true, dashboard: emptyDashboard(), error: error.message })
    }

    if (!swaps || swaps.length === 0) {
      return NextResponse.json({ enabled: true, dashboard: emptyDashboard() })
    }

    const dashboard = computeFromSwaps(swaps)
    return NextResponse.json(
      { enabled: true, dashboard },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
        },
      },
    )
  } catch (err) {
    console.error('[analytics] Error:', err)
    return NextResponse.json({ enabled: false, dashboard: emptyDashboard() })
  }
}

// ── Types matching DashboardData from analytics-types.ts ──

interface PeriodMetrics {
  totalVolume: number
  totalFees: number
  tradeCount: number
  uniqueWallets: number
}

interface SourceMetrics {
  source: string
  tradeCount: number
  volumeUsd: number
  winRate: number
}

interface PairMetrics {
  pair: string
  tradeCount: number
  volumeUsd: number
}

interface TradeEvent {
  id: string
  type: string
  wallet: string
  timestamp: number
  hour: number
  tokenIn: string
  tokenInAddress: string
  tokenOut: string
  tokenOutAddress: string
  amountIn: string
  amountOut: string
  volumeUsd: number
  feeUsd: number
  source: string
  txHash: string
  chainId: number
}

interface DashboardResponse {
  allTime: PeriodMetrics
  last24h: PeriodMetrics
  last7d: PeriodMetrics
  last30d: PeriodMetrics
  bySource: SourceMetrics[]
  byHour: Array<{ hour: number; volumeUsd: number; tradeCount: number }>
  topPairs: PairMetrics[]
  totalWallets: number
  recentTrades: TradeEvent[]
  dailyVolume: Array<{ date: string; volumeUsd: number; tradeCount: number }>
}

// ── Helpers ──

function emptyPeriod(): PeriodMetrics {
  return { totalVolume: 0, totalFees: 0, tradeCount: 0, uniqueWallets: 0 }
}

function emptyDashboard(): DashboardResponse {
  return {
    allTime: emptyPeriod(),
    last24h: emptyPeriod(),
    last7d: emptyPeriod(),
    last30d: emptyPeriod(),
    bySource: [],
    byHour: Array.from({ length: 24 }, (_, i) => ({ hour: i, volumeUsd: 0, tradeCount: 0 })),
    topPairs: [],
    totalWallets: 0,
    recentTrades: [],
    dailyVolume: [],
  }
}

/** Convert a Supabase swap row into a TradeEvent for the dashboard */
function swapToEvent(row: Record<string, unknown>): TradeEvent {
  const createdAt = row.created_at ? new Date(row.created_at as string) : new Date()
  const ts = createdAt.getTime()

  // Estimate USD value from amount_in_usd or amount_out_usd, fall back to 0
  const amountInUsd = Number(row.amount_in_usd) || 0
  const amountOutUsd = Number(row.amount_out_usd) || 0
  const volumeUsd = amountInUsd || amountOutUsd

  // Fee: if fee_amount is set, estimate fee USD; otherwise derive from fee_collected flag
  const feeCollected = row.fee_collected as boolean
  const feeAmount = row.fee_amount as string | null
  let feeUsd = 0
  if (feeCollected && feeAmount) {
    // fee_amount is in output token wei — use amountOutUsd as proxy for value
    feeUsd = volumeUsd * 0.001 // 0.1% fee estimate
  }

  return {
    id: row.id as string,
    type: 'swap',
    wallet: row.wallet as string,
    timestamp: ts,
    hour: createdAt.getUTCHours(),
    tokenIn: (row.token_in_symbol as string) || '',
    tokenInAddress: (row.token_in as string) || '',
    tokenOut: (row.token_out_symbol as string) || '',
    tokenOutAddress: (row.token_out as string) || '',
    amountIn: (row.amount_in as string) || '0',
    amountOut: (row.amount_out as string) || '0',
    volumeUsd,
    feeUsd,
    source: (row.source as string) || 'unknown',
    txHash: (row.tx_hash as string) || '',
    chainId: Number(row.chain_id) || 1,
  }
}

function filterByPeriod(events: TradeEvent[], ms: number): TradeEvent[] {
  const cutoff = Date.now() - ms
  return events.filter(e => e.timestamp >= cutoff)
}

function computePeriodMetrics(events: TradeEvent[]): PeriodMetrics {
  const wallets = new Set(events.map(e => e.wallet))
  return {
    totalVolume: events.reduce((s, e) => s + e.volumeUsd, 0),
    totalFees: events.reduce((s, e) => s + e.feeUsd, 0),
    tradeCount: events.length,
    uniqueWallets: wallets.size,
  }
}

function computeFromSwaps(swaps: Record<string, unknown>[]): DashboardResponse {
  const events = swaps.map(swapToEvent)

  // Period metrics
  const allTime = computePeriodMetrics(events)
  const last24h = computePeriodMetrics(filterByPeriod(events, 24 * 60 * 60 * 1000))
  const last7d = computePeriodMetrics(filterByPeriod(events, 7 * 24 * 60 * 60 * 1000))
  const last30d = computePeriodMetrics(filterByPeriod(events, 30 * 24 * 60 * 60 * 1000))

  // Source metrics
  const sourceMap = new Map<string, { count: number; volume: number }>()
  for (const e of events) {
    const entry = sourceMap.get(e.source) || { count: 0, volume: 0 }
    entry.count++
    entry.volume += e.volumeUsd
    sourceMap.set(e.source, entry)
  }
  const total = events.length || 1
  const bySource = Array.from(sourceMap.entries())
    .map(([source, data]) => ({
      source,
      tradeCount: data.count,
      volumeUsd: data.volume,
      winRate: (data.count / total) * 100,
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)

  // Hourly volume
  const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, volumeUsd: 0, tradeCount: 0 }))
  for (const e of events) {
    byHour[e.hour].volumeUsd += e.volumeUsd
    byHour[e.hour].tradeCount++
  }

  // Top pairs
  const pairMap = new Map<string, { count: number; volume: number }>()
  for (const e of events) {
    if (!e.tokenIn || !e.tokenOut) continue
    const pair = `${e.tokenIn}/${e.tokenOut}`
    const entry = pairMap.get(pair) || { count: 0, volume: 0 }
    entry.count++
    entry.volume += e.volumeUsd
    pairMap.set(pair, entry)
  }
  const topPairs = Array.from(pairMap.entries())
    .map(([pair, data]) => ({ pair, tradeCount: data.count, volumeUsd: data.volume }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, 10)

  // Unique wallets
  const totalWallets = new Set(events.map(e => e.wallet)).size

  // Recent trades (latest 50)
  const recentTrades = events.slice(0, 50)

  // Daily volume (last 30 days)
  const dailyMap = new Map<string, { volume: number; count: number }>()
  const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000
  for (const e of events) {
    if (e.timestamp < cutoff30d) continue
    const date = new Date(e.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    const entry = dailyMap.get(date) || { volume: 0, count: 0 }
    entry.volume += e.volumeUsd
    entry.count++
    dailyMap.set(date, entry)
  }
  const dailyVolume = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, volumeUsd: data.volume, tradeCount: data.count }))

  return {
    allTime,
    last24h,
    last7d,
    last30d,
    bySource,
    byHour,
    topPairs,
    totalWallets,
    recentTrades,
    dailyVolume,
  }
}
