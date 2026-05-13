/**
 * [P98] Per-wallet analytics aggregation.
 *
 * The protocol-wide AnalyticsDashboard reads the `swaps` table across
 * every wallet; this module is the inverse — given one wallet, summarise
 * their performance into KPI-card-friendly numbers. Aggregation happens
 * server-side via Supabase (filtered + a single scan), so we never ship
 * the row set to the client.
 *
 * The route handler at /api/analytics/personal wraps fetchPersonalAnalytics
 * with rate limiting + 5-minute Upstash KV caching, but the function
 * itself is pure aggregation — callable from any server context.
 */

import { getSupabase } from './supabase'

export interface TopPair {
  pair: string
  count: number
  volumeUsd: number
}

export interface PersonalAnalytics {
  wallet: string
  totalSwaps: number
  totalVolumeUsd: number
  /** Sum of gas_savings_usd over CoW-routed swaps. */
  totalGasSavedUsd: number
  gaslessSwapCount: number
  /** gaslessSwapCount / totalSwaps, in [0, 1]. */
  gaslessRatio: number
  /** Source → percentage of confirmed swaps that used it (0–100). */
  sourceWinRates: Record<string, number>
  topPairs: TopPair[]
  /** UTC hour of day (0–23) with the most swaps; null when no data. */
  bestHour: number | null
  /** 0 = Sunday … 6 = Saturday; null when no data. */
  bestDayOfWeek: number | null
  /** ISO timestamp of the earliest swap, or '' when none. */
  periodStart: string
  /** ISO timestamp of the most recent swap, or '' when none. */
  periodEnd: string
  /** When this aggregate was computed. */
  lastUpdated: string
}

/** Minimum row shape we read from `swaps` for aggregation. */
interface SwapRow {
  created_at: string
  source: string
  token_in_symbol: string | null
  token_out_symbol: string | null
  amount_in_usd: number | string | null
  is_gasless: boolean | null
  gas_savings_usd: number | string | null
  status: string | null
  tx_hash: string | null
}

function emptyAnalytics(wallet: string): PersonalAnalytics {
  return {
    wallet,
    totalSwaps: 0,
    totalVolumeUsd: 0,
    totalGasSavedUsd: 0,
    gaslessSwapCount: 0,
    gaslessRatio: 0,
    sourceWinRates: {},
    topPairs: [],
    bestHour: null,
    bestDayOfWeek: null,
    periodStart: '',
    periodEnd: '',
    lastUpdated: new Date().toISOString(),
  }
}

function isCompleted(row: SwapRow): boolean {
  return row.status === 'confirmed' || (row.status === 'pending' && !!row.tx_hash)
}

/**
 * Aggregate the wallet's completed swaps into KPI numbers.
 *
 * Exported separately from the row fetch so the test suite can drive it
 * with fixtures; the API route wraps it around the Supabase query +
 * caching. Wallet addresses are lowercased before comparison everywhere —
 * we store them lowercase in the swaps table.
 */
export function aggregatePersonalAnalytics(
  wallet: string,
  rows: SwapRow[],
): PersonalAnalytics {
  const out = emptyAnalytics(wallet.toLowerCase())
  const completed = rows.filter(isCompleted)
  if (completed.length === 0) return out

  // Per-source win counts → percentages at the end.
  const sourceCounts: Record<string, number> = {}
  // Per-pair stats.
  const pairCounts: Map<string, { count: number; volumeUsd: number }> = new Map()
  // Per-hour / per-DOW counts (UTC).
  const hourCounts: number[] = new Array(24).fill(0)
  const dowCounts: number[] = new Array(7).fill(0)

  let periodStartMs = Number.POSITIVE_INFINITY
  let periodEndMs = Number.NEGATIVE_INFINITY

  for (const row of completed) {
    const usd = Number(row.amount_in_usd ?? 0)
    if (Number.isFinite(usd) && usd > 0) {
      out.totalVolumeUsd += usd
    }

    sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + 1

    if (row.is_gasless) {
      out.gaslessSwapCount += 1
      const saved = Number(row.gas_savings_usd ?? 0)
      if (Number.isFinite(saved) && saved > 0) {
        out.totalGasSavedUsd += saved
      }
    }

    if (row.token_in_symbol && row.token_out_symbol) {
      const pair = `${row.token_in_symbol}/${row.token_out_symbol}`
      const existing = pairCounts.get(pair) ?? { count: 0, volumeUsd: 0 }
      existing.count += 1
      if (Number.isFinite(usd) && usd > 0) existing.volumeUsd += usd
      pairCounts.set(pair, existing)
    }

    const ms = Date.parse(row.created_at)
    if (Number.isFinite(ms)) {
      const d = new Date(ms)
      hourCounts[d.getUTCHours()] += 1
      dowCounts[d.getUTCDay()] += 1
      if (ms < periodStartMs) periodStartMs = ms
      if (ms > periodEndMs) periodEndMs = ms
    }
  }

  out.totalSwaps = completed.length
  out.gaslessRatio = out.totalSwaps > 0 ? out.gaslessSwapCount / out.totalSwaps : 0
  out.totalVolumeUsd = Number(out.totalVolumeUsd.toFixed(2))
  out.totalGasSavedUsd = Number(out.totalGasSavedUsd.toFixed(2))
  out.gaslessRatio = Number(out.gaslessRatio.toFixed(4))

  for (const [source, count] of Object.entries(sourceCounts)) {
    out.sourceWinRates[source] = Number(((count / out.totalSwaps) * 100).toFixed(2))
  }

  out.topPairs = [...pairCounts.entries()]
    .map(([pair, v]) => ({
      pair,
      count: v.count,
      volumeUsd: Number(v.volumeUsd.toFixed(2)),
    }))
    .sort((a, b) => b.count - a.count || b.volumeUsd - a.volumeUsd)
    .slice(0, 5)

  // bestHour / bestDay: only meaningful with enough samples. Below 10
  // swaps the dominant bucket is noise — we surface null so the UI can
  // hide the timing insight rather than display a misleading "best".
  if (out.totalSwaps >= 10) {
    let bestHour = 0
    for (let h = 1; h < 24; h++) if (hourCounts[h] > hourCounts[bestHour]) bestHour = h
    out.bestHour = hourCounts[bestHour] > 0 ? bestHour : null

    let bestDow = 0
    for (let d = 1; d < 7; d++) if (dowCounts[d] > dowCounts[bestDow]) bestDow = d
    out.bestDayOfWeek = dowCounts[bestDow] > 0 ? bestDow : null
  }

  if (Number.isFinite(periodStartMs)) {
    out.periodStart = new Date(periodStartMs).toISOString()
    out.periodEnd = new Date(periodEndMs).toISOString()
  }

  return out
}

export async function fetchPersonalAnalytics(
  wallet: string,
): Promise<PersonalAnalytics> {
  const supabase = getSupabase()
  if (!supabase) return emptyAnalytics(wallet.toLowerCase())

  // Lowercase to match how log-swap persists the wallet column.
  const walletLc = wallet.toLowerCase()

  const { data, error } = await supabase
    .from('swaps')
    .select(
      'created_at, source, token_in_symbol, token_out_symbol, amount_in_usd, is_gasless, gas_savings_usd, status, tx_hash',
    )
    .eq('wallet', walletLc)
    // Bound the scan — a wallet with > 10k swaps is wildly out of band
    // for retail use and the aggregate stays stable enough on the most
    // recent slice.
    .order('created_at', { ascending: false })
    .limit(10_000)

  if (error) {
    console.error('[personal-analytics] supabase error:', error.message)
    return emptyAnalytics(walletLc)
  }

  return aggregatePersonalAnalytics(walletLc, (data ?? []) as SwapRow[])
}
