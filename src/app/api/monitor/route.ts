import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'

// CORS headers — allows local file:// (origin null) and the production domain
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

/** Preflight handler for CORS */
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

interface SwapEvent {
  ts: number
  wallet: string
  source: string
  tokenIn: string
  tokenOut: string
  amountUsd: number
  status: string
  mevProtected: boolean
  feeCollected: boolean
}

/**
 * GET /api/monitor
 *
 * Advanced monitoring endpoint for the TeraSwap security dashboard.
 * Combines analytics data with security events, source health, and anomaly signals.
 *
 * Protected by API key: ?key=MONITOR_SECRET
 */
export async function GET(req: Request) {
  // Auth via Authorization header (never URL query params — those leak in logs/history)
  const authHeader = req.headers.get('authorization')
  const key = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const secret = process.env.MONITOR_SECRET

  if (!secret || !key || key !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS })
  }

  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503, headers: CORS_HEADERS })
  }

  try {
    // Parallel fetch — select ONLY needed columns (never select('*') for security & performance)
    const [swapsRes, quotesRes, securityRes] = await Promise.all([
      supabase
        .from('swaps')
        .select('created_at, wallet, source, token_in_symbol, token_out_symbol, amount_in_usd, status, mev_protected, fee_collected')
        .order('created_at', { ascending: false })
        .limit(5000),
      supabase
        .from('quotes')
        .select('sources_queried, sources_responded, best_source, response_time_ms')
        .order('created_at', { ascending: false })
        .limit(2000),
      Promise.resolve(
        supabase
          .from('security_events')
          .select('type, severity, timestamp, message, wallet, amount_usd, deviation')
          .order('timestamp', { ascending: false })
          .limit(1000)
      ).catch(() => ({ data: null, error: { message: 'security_events table not found' } })),
    ])

    const swaps = swapsRes.data || []
    const quotes = quotesRes.data || []
    const securityEvents = securityRes.data || []

    // ── 1. Trade metrics ──
    const now = Date.now()
    const h24 = now - 24 * 3600_000
    const d7 = now - 7 * 24 * 3600_000
    const d30 = now - 30 * 24 * 3600_000

    const swapEvents: SwapEvent[] = swaps.map((s: Record<string, unknown>) => ({
      ts: new Date(s.created_at as string).getTime(),
      wallet: s.wallet as string,
      source: s.source as string,
      tokenIn: s.token_in_symbol as string,
      tokenOut: s.token_out_symbol as string,
      amountUsd: Number(s.amount_in_usd) || 0,
      status: s.status as string,
      mevProtected: s.mev_protected as boolean,
      feeCollected: s.fee_collected as boolean,
    }))

    function periodStats(cutoff: number) {
      const filtered = swapEvents.filter(s => s.ts >= cutoff)
      const wallets = new Set(filtered.map(s => s.wallet))
      const volume = filtered.reduce((acc, s) => acc + s.amountUsd, 0)
      const fees = filtered.filter(s => s.feeCollected).reduce((acc, s) => acc + s.amountUsd * 0.001, 0)
      const failed = filtered.filter(s => s.status === 'failed').length
      return {
        trades: filtered.length,
        volume,
        fees,
        wallets: wallets.size,
        failed,
        avgTradeSize: filtered.length > 0 ? volume / filtered.length : 0,
      }
    }

    // ── 2. Source health ──
    const sourceHealth: Record<string, {
      quotes: number
      wins: number
      failures: number
      avgResponseMs: number
      responseTimes: number[]
      volume: number
    }> = {}

    for (const q of quotes) {
      const sources = (q.sources_queried as string[]) || []
      const responded = (q.sources_responded as string[]) || []
      const best = q.best_source as string
      const responseMs = Number(q.response_time_ms) || 0

      for (const src of sources) {
        if (!sourceHealth[src]) {
          sourceHealth[src] = { quotes: 0, wins: 0, failures: 0, avgResponseMs: 0, responseTimes: [], volume: 0 }
        }
        sourceHealth[src].quotes++
        if (!responded.includes(src)) sourceHealth[src].failures++
        if (src === best) sourceHealth[src].wins++
        sourceHealth[src].responseTimes.push(responseMs)
      }
    }

    // Add volume from swaps
    for (const s of swapEvents) {
      if (sourceHealth[s.source]) {
        sourceHealth[s.source].volume += s.amountUsd
      }
    }

    // Compute avg response times
    for (const [, stats] of Object.entries(sourceHealth)) {
      if (stats.responseTimes.length > 0) {
        stats.avgResponseMs = Math.round(
          stats.responseTimes.reduce((a, b) => a + b, 0) / stats.responseTimes.length
        )
      }
    }

    const sourceHealthArr = Object.entries(sourceHealth)
      .map(([source, s]) => ({
        source,
        quoteCount: s.quotes,
        winCount: s.wins,
        winRate: s.quotes > 0 ? ((s.wins / s.quotes) * 100).toFixed(1) : '0',
        failureCount: s.failures,
        failureRate: s.quotes > 0 ? ((s.failures / s.quotes) * 100).toFixed(1) : '0',
        avgResponseMs: s.avgResponseMs,
        volumeUsd: Math.round(s.volume),
      }))
      .sort((a, b) => b.volumeUsd - a.volumeUsd)

    // ── 3. Security summary ──
    const securitySummary: Record<string, number> = {}
    const recentSecurity = securityEvents.slice(0, 100).map((e: Record<string, unknown>) => ({
      type: e.type,
      severity: e.severity,
      timestamp: e.timestamp,
      message: e.message,
      wallet: e.wallet,
      amountUsd: e.amount_usd,
      deviation: e.deviation,
    }))

    for (const e of securityEvents) {
      const type = e.type as string
      securitySummary[type] = (securitySummary[type] || 0) + 1
    }

    // ── 4. Anomaly signals ──
    // Volume Z-score: compare last hour vs rolling 24h average
    const lastHourSwaps = swapEvents.filter(s => s.ts >= now - 3600_000)
    const last24hSwaps = swapEvents.filter(s => s.ts >= h24)
    const hourlyVolumes: number[] = []
    for (let h = 0; h < 24; h++) {
      const start = now - (h + 1) * 3600_000
      const end = now - h * 3600_000
      hourlyVolumes.push(
        last24hSwaps.filter(s => s.ts >= start && s.ts < end).reduce((a, s) => a + s.amountUsd, 0)
      )
    }
    const avgHourlyVol = hourlyVolumes.reduce((a, b) => a + b, 0) / (hourlyVolumes.length || 1)
    const stdHourlyVol = Math.sqrt(
      hourlyVolumes.reduce((a, v) => a + (v - avgHourlyVol) ** 2, 0) / (hourlyVolumes.length || 1)
    )
    const currentHourVol = lastHourSwaps.reduce((a, s) => a + s.amountUsd, 0)
    const volumeZScore = stdHourlyVol > 0 ? (currentHourVol - avgHourlyVol) / stdHourlyVol : 0

    // Trade frequency anomaly
    const lastHourTrades = lastHourSwaps.length
    const avgHourlyTrades = last24hSwaps.length / 24
    const tradeFreqZScore = avgHourlyTrades > 0 ? (lastHourTrades - avgHourlyTrades) / Math.max(avgHourlyTrades * 0.5, 1) : 0

    // Single wallet dominance
    const walletVolumes: Record<string, number> = {}
    for (const s of last24hSwaps) {
      walletVolumes[s.wallet] = (walletVolumes[s.wallet] || 0) + s.amountUsd
    }
    const totalVol24h = last24hSwaps.reduce((a, s) => a + s.amountUsd, 0)
    const topWalletVol = Math.max(0, ...Object.values(walletVolumes))
    const walletDominance = totalVol24h > 0 ? topWalletVol / totalVol24h : 0

    // Failed tx rate
    const failedLast24h = last24hSwaps.filter(s => s.status === 'failed').length
    const failRate24h = last24hSwaps.length > 0 ? failedLast24h / last24hSwaps.length : 0

    // ── 5. Daily volume timeseries ──
    const dailyMap = new Map<string, { volume: number; trades: number; wallets: Set<string>; fees: number }>()
    for (const s of swapEvents) {
      if (s.ts < d30) continue
      const date = new Date(s.ts).toISOString().split('T')[0]
      const entry = dailyMap.get(date) || { volume: 0, trades: 0, wallets: new Set<string>(), fees: 0 }
      entry.volume += s.amountUsd
      entry.trades++
      entry.wallets.add(s.wallet)
      if (s.feeCollected) entry.fees += s.amountUsd * 0.001
      dailyMap.set(date, entry)
    }
    const dailyTimeseries = Array.from(dailyMap.entries())
      .map(([date, d]) => ({ date, volume: Math.round(d.volume), trades: d.trades, wallets: d.wallets.size, fees: Math.round(d.fees * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // ── Response ──
    return NextResponse.json({
      timestamp: new Date().toISOString(),
      metrics: {
        allTime: periodStats(0),
        last24h: periodStats(h24),
        last7d: periodStats(d7),
        last30d: periodStats(d30),
      },
      sourceHealth: sourceHealthArr,
      security: {
        summary: securitySummary,
        recentEvents: recentSecurity,
      },
      anomalies: {
        volumeZScore: Math.round(volumeZScore * 100) / 100,
        tradeFreqZScore: Math.round(tradeFreqZScore * 100) / 100,
        walletDominance: Math.round(walletDominance * 10000) / 100, // %
        failRate24h: Math.round(failRate24h * 10000) / 100, // %
        currentHourVolume: Math.round(currentHourVol),
        avgHourlyVolume: Math.round(avgHourlyVol),
        alerts: [
          ...(Math.abs(volumeZScore) > 2 ? [{
            level: volumeZScore > 0 ? 'warn' : 'info',
            message: `Volume Z-score ${volumeZScore.toFixed(1)} — ${volumeZScore > 0 ? 'unusual spike' : 'unusually low'}`,
          }] : []),
          ...(walletDominance > 0.5 ? [{
            level: 'warn',
            message: `Single wallet accounts for ${(walletDominance * 100).toFixed(0)}% of 24h volume`,
          }] : []),
          ...(failRate24h > 0.1 ? [{
            level: 'critical',
            message: `${(failRate24h * 100).toFixed(0)}% of swaps failed in last 24h`,
          }] : []),
          ...(tradeFreqZScore > 3 ? [{
            level: 'warn',
            message: `Trade frequency ${tradeFreqZScore.toFixed(1)}x above average this hour`,
          }] : []),
        ],
      },
      dailyTimeseries,
    }, {
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'private, s-maxage=15, stale-while-revalidate=30',
      },
    })
  } catch (err) {
    console.error('[monitor] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: CORS_HEADERS })
  }
}
