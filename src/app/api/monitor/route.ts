import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'
import { safeCompare, isAllowedOrigin } from '@/lib/validation'

// API-HIGH-03: CORS restricted to app domain (was wildcard *)
function corsHeaders(req: Request) {
  const origin = req.headers.get('origin')
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin! : 'https://teraswap.app',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

/** Preflight handler for CORS */
export function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
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

  // API-CRITICAL-01: Timing-safe comparison prevents token brute-force
  if (!secret || !key || !safeCompare(key, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(req) })
  }

  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503, headers: corsHeaders(req) })
  }

  // ── Wallet Lookup mode: ?wallet=0x... returns per-wallet timeline ──
  const url = new URL(req.url)
  const walletQuery = url.searchParams.get('wallet')?.toLowerCase()

  if (walletQuery && /^0x[a-f0-9]{40}$/i.test(walletQuery)) {
    try {
      const [activityRes, walletSwapsRes, walletQuotesRes, walletSecurityRes] = await Promise.all([
        Promise.resolve(
          supabase
            .from('wallet_activity')
            .select('created_at, category, action, source, token_in, token_out, amount_usd, success, error_code, error_msg, tx_hash, order_id, duration_ms, metadata')
            .eq('wallet', walletQuery)
            .order('created_at', { ascending: false })
            .limit(200)
        ).catch(() => ({ data: null, error: { message: 'wallet_activity table not found' } })),
        supabase
          .from('swaps')
          .select('created_at, source, token_in_symbol, token_out_symbol, amount_in_usd, status, tx_hash, mev_protected')
          .eq('wallet', walletQuery)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('quotes')
          .select('created_at, token_in_symbol, token_out_symbol, best_source, response_time_ms, sources_queried, sources_responded')
          .eq('wallet', walletQuery)
          .order('created_at', { ascending: false })
          .limit(100),
        Promise.resolve(
          supabase
            .from('security_events')
            .select('type, severity, timestamp, message, amount_usd, deviation')
            .eq('wallet', walletQuery)
            .order('timestamp', { ascending: false })
            .limit(50)
        ).catch(() => ({ data: null, error: null })),
      ])

      const activity = activityRes.data || []
      const swaps = walletSwapsRes.data || []
      const quotes = walletQuotesRes.data || []
      const security = walletSecurityRes.data || []

      // Summary stats
      const totalSwaps = swaps.length
      const successfulSwaps = swaps.filter((s: Record<string, unknown>) => s.status === 'confirmed').length
      const failedSwaps = swaps.filter((s: Record<string, unknown>) => s.status === 'failed').length
      const totalVolume = swaps.reduce((acc: number, s: Record<string, unknown>) => acc + (Number(s.amount_in_usd) || 0), 0)
      const lastActive = activity.length > 0 ? activity[0].created_at : (swaps.length > 0 ? (swaps[0] as Record<string, unknown>).created_at : null)

      return NextResponse.json({
        wallet: walletQuery,
        summary: {
          totalSwaps,
          successfulSwaps,
          failedSwaps,
          successRate: totalSwaps > 0 ? Math.round((successfulSwaps / totalSwaps) * 10000) / 100 : 0,
          totalVolume: Math.round(totalVolume),
          totalQuotes: quotes.length,
          securityEvents: security.length,
          lastActive,
        },
        activity,
        swaps,
        quotes,
        security,
      }, { headers: corsHeaders(req) })
    } catch (err) {
      console.error('[monitor] Wallet lookup error:', err)
      return NextResponse.json({ error: 'Wallet lookup failed' }, { status: 500, headers: corsHeaders(req) })
    }
  }

  try {
    // Parallel fetch — select ONLY needed columns (never select('*') for security & performance)
    const [swapsRes, quotesRes, securityRes, usageRes] = await Promise.all([
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
      Promise.resolve(
        supabase
          .from('usage_events')
          .select('created_at, session_id, event_type, page, click_target, click_tag, click_id, duration_ms, screen_w, user_agent')
          .order('created_at', { ascending: false })
          .limit(10000)
      ).catch(() => ({ data: null, error: { message: 'usage_events table not found' } })),
    ])

    const swaps = swapsRes.data || []
    const quotes = quotesRes.data || []
    const securityEvents = securityRes.data || []
    const usageEvents = usageRes.data || []

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

    // ── 6. Usage analytics ──
    interface UsageEvent {
      created_at: string
      session_id: string
      event_type: string
      page: string
      click_target: string | null
      click_tag: string | null
      click_id: string | null
      duration_ms: number | null
      screen_w: number | null
      user_agent: string | null
    }

    const typedUsage = usageEvents as UsageEvent[]

    // Page views
    const pageViews = typedUsage.filter(e => e.event_type === 'page_view')
    const clicks = typedUsage.filter(e => e.event_type === 'click')
    const sessions = typedUsage.filter(e => e.event_type === 'session_end')

    // Unique sessions & page views by period
    function usagePeriodStats(cutoff: number) {
      const filtered = pageViews.filter(e => new Date(e.created_at).getTime() >= cutoff)
      const uniqueSessions = new Set(filtered.map(e => e.session_id))
      return { pageViews: filtered.length, uniqueVisitors: uniqueSessions.size }
    }

    // Page breakdown
    const pageCounts: Record<string, { views: number; clicks: number; avgDuration: number; durations: number[] }> = {}
    for (const pv of pageViews) {
      if (!pageCounts[pv.page]) pageCounts[pv.page] = { views: 0, clicks: 0, avgDuration: 0, durations: [] }
      pageCounts[pv.page].views++
    }
    for (const c of clicks) {
      if (!pageCounts[c.page]) pageCounts[c.page] = { views: 0, clicks: 0, avgDuration: 0, durations: [] }
      pageCounts[c.page].clicks++
    }
    for (const s of sessions) {
      if (s.duration_ms != null && pageCounts[s.page]) {
        pageCounts[s.page].durations.push(s.duration_ms)
      }
    }
    const pageBreakdown = Object.entries(pageCounts)
      .map(([page, stats]) => ({
        page,
        views: stats.views,
        clicks: stats.clicks,
        avgDurationSec: stats.durations.length > 0
          ? Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length / 1000)
          : 0,
      }))
      .sort((a, b) => b.views - a.views)

    // Click breakdown — top clicked elements
    const clickCounts: Record<string, { count: number; tag: string; id: string | null; page: string }> = {}
    for (const c of clicks) {
      const label = c.click_target || c.click_id || c.click_tag || 'unknown'
      const key = `${c.page}::${label}`
      if (!clickCounts[key]) clickCounts[key] = { count: 0, tag: c.click_tag || '', id: c.click_id, page: c.page }
      clickCounts[key].count++
    }
    const topClicks = Object.entries(clickCounts)
      .map(([key, stats]) => ({
        label: key.split('::')[1] || 'unknown',
        page: stats.page,
        tag: stats.tag,
        id: stats.id,
        count: stats.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50)

    // Device breakdown (mobile <768, tablet 768-1024, desktop >1024)
    const devices = { mobile: 0, tablet: 0, desktop: 0 }
    const sessionDevices = new Map<string, number>()
    for (const pv of pageViews) {
      if (pv.screen_w != null && !sessionDevices.has(pv.session_id)) {
        sessionDevices.set(pv.session_id, pv.screen_w)
      }
    }
    for (const [, w] of sessionDevices) {
      if (w < 768) devices.mobile++
      else if (w <= 1024) devices.tablet++
      else devices.desktop++
    }

    // Average session duration
    const allDurations = sessions.filter(s => s.duration_ms != null).map(s => s.duration_ms as number)
    const avgSessionDurationSec = allDurations.length > 0
      ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length / 1000)
      : 0

    // Daily usage timeseries (last 30d)
    const dailyUsageMap = new Map<string, { views: number; visitors: Set<string>; clicks: number }>()
    for (const pv of pageViews) {
      const ts = new Date(pv.created_at).getTime()
      if (ts < d30) continue
      const date = new Date(ts).toISOString().split('T')[0]
      const entry = dailyUsageMap.get(date) || { views: 0, visitors: new Set<string>(), clicks: 0 }
      entry.views++
      entry.visitors.add(pv.session_id)
      dailyUsageMap.set(date, entry)
    }
    for (const c of clicks) {
      const ts = new Date(c.created_at).getTime()
      if (ts < d30) continue
      const date = new Date(ts).toISOString().split('T')[0]
      const entry = dailyUsageMap.get(date)
      if (entry) entry.clicks++
    }
    const dailyUsageTimeseries = Array.from(dailyUsageMap.entries())
      .map(([date, d]) => ({ date, views: d.views, visitors: d.visitors.size, clicks: d.clicks }))
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
      usage: {
        totals: {
          allTime: usagePeriodStats(0),
          last24h: usagePeriodStats(h24),
          last7d: usagePeriodStats(d7),
          last30d: usagePeriodStats(d30),
        },
        totalClicks: clicks.length,
        avgSessionDurationSec,
        devices,
        pageBreakdown,
        topClicks,
        dailyUsageTimeseries,
      },
    }, {
      headers: {
        ...corsHeaders(req),
        'Cache-Control': 'private, s-maxage=15, stale-while-revalidate=30',
      },
    })
  } catch (err) {
    console.error('[monitor] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: corsHeaders(req) })
  }
}
