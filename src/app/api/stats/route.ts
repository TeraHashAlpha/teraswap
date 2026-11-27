import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'
import { publicSwaps, swapsPublicVerifiedOnly } from '@/lib/swap-log/public-filter'

/**
 * GET /api/stats
 *
 * Public analytics: total swaps, volume, top sources, top pairs.
 * [ADR-029] With SWAPS_PUBLIC_VERIFIED_ONLY on, every count here is of rows the server verified on-chain.
 */
export async function GET() {
  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ enabled: false })
  }

  try {
    // Total swaps: confirmed + pending-with-tx (real txns whose status wasn't updated)
    const { count: totalSwaps } = await publicSwaps(
      supabase
        .from('swaps')
        .select('*', { count: 'exact', head: true })
        .or('status.eq.confirmed,and(status.eq.pending,tx_hash.not.is.null)'),
    )

    // Total quotes
    const { count: totalQuotes } = await supabase
      .from('quotes')
      .select('*', { count: 'exact', head: true })

    // Top sources (by swap count)
    const { data: sourceStats } = await publicSwaps(
      supabase
        .from('swaps')
        .select('source')
        .or('status.eq.confirmed,and(status.eq.pending,tx_hash.not.is.null)'),
    )

    const sourceCounts: Record<string, number> = {}
    for (const row of sourceStats ?? []) {
      sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + 1
    }

    // Top winning sources from quotes
    const { data: quoteWinners } = await supabase
      .from('quotes')
      .select('best_source')
      .not('best_source', 'is', null)
      .limit(1000)

    const winCounts: Record<string, number> = {}
    for (const row of quoteWinners ?? []) {
      if (row.best_source) {
        winCounts[row.best_source] = (winCounts[row.best_source] ?? 0) + 1
      }
    }

    // [P103 / 13A-L-01] Gasless adoption metrics via Supabase RPC.
    // Previous implementation pulled every gasless row back to Node to
    // .reduce() the SUM client-side — O(N) memory + network. The
    // gasless_stats() function (migration 20260514) returns COUNT + SUM
    // in a single row, so we never see individual swap records here.
    // [ADR-029] The SQL function counts every gasless row and cannot see the server flag. With the flag on, the same
    // COUNT and SUM are taken here over verified rows only (same status rule as the function); with it off, the
    // function is called exactly as before.
    let gaslessRow: { total_gasless?: unknown; total_gas_saved?: unknown } | null | undefined
    if (swapsPublicVerifiedOnly()) {
      const { data: verifiedGasless } = await supabase
        .from('swaps')
        .select('gas_savings_usd')
        .eq('is_gasless', true)
        .or('status.eq.confirmed,and(status.eq.pending,tx_hash.not.is.null)')
        .not('verified_at', 'is', null)
      const gasless = verifiedGasless ?? []
      gaslessRow = {
        total_gasless: gasless.length,
        total_gas_saved: gasless.reduce((sum, row) => sum + (Number(row.gas_savings_usd) || 0), 0),
      }
    } else {
      const { data: gaslessRpc } = await supabase.rpc('gasless_stats')
      gaslessRow = Array.isArray(gaslessRpc) ? gaslessRpc[0] : gaslessRpc
    }
    const totalGaslessSwaps = Number(gaslessRow?.total_gasless ?? 0)
    const totalGasSavedUsd = Number(gaslessRow?.total_gas_saved ?? 0)

    const denom = totalSwaps ?? 0
    const gaslessRatio = denom > 0 ? totalGaslessSwaps / denom : 0
    const avgGasSavingsPerSwap =
      totalGaslessSwaps > 0 ? totalGasSavedUsd / totalGaslessSwaps : 0

    return NextResponse.json({
      enabled: true,
      totalSwaps: totalSwaps ?? 0,
      totalQuotes: totalQuotes ?? 0,
      topSwapSources: Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      topQuoteWinners: Object.entries(winCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      // [P96] Gasless adoption block. Always present (zero-valued when no
      // swaps have happened yet) so consumers don't need to branch.
      gasless: {
        totalGaslessSwaps,
        totalGasSavedUsd: Number(totalGasSavedUsd.toFixed(2)),
        gaslessRatio: Number(gaslessRatio.toFixed(4)),
        avgGasSavingsPerSwap: Number(avgGasSavingsPerSwap.toFixed(2)),
      },
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    })
  } catch (err) {
    console.error('[stats] Error:', err)
    return NextResponse.json({ enabled: false, error: 'Failed to fetch stats' })
  }
}
