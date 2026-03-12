import { NextResponse, type NextRequest } from 'next/server'
import { getSupabase } from '@/lib/supabase'
import { trackQuoteFailure } from '@/lib/security-tracker'

/**
 * POST /api/log-quote
 *
 * Fire-and-forget endpoint to log quote requests to Supabase.
 * Used for analytics: which sources win, response times, popular pairs.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase()
    if (!supabase) {
      return NextResponse.json({ ok: true, skipped: true })
    }

    const body = await req.json()

    const {
      tokenIn,
      tokenInSymbol,
      tokenOut,
      tokenOutSymbol,
      amountIn,
      sourcesQueried = [],
      sourcesResponded = [],
      bestSource,
      bestAmountOut,
      allQuotes,
      responseTimeMs = 0,
      wallet,
    } = body

    if (!tokenIn || !tokenOut || !amountIn) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 },
      )
    }

    const { error } = await supabase.from('quotes').insert({
      token_in: tokenIn.toLowerCase(),
      token_in_symbol: tokenInSymbol ?? '',
      token_out: tokenOut.toLowerCase(),
      token_out_symbol: tokenOutSymbol ?? '',
      amount_in: amountIn,
      sources_queried: sourcesQueried,
      sources_responded: sourcesResponded,
      best_source: bestSource ?? null,
      best_amount_out: bestAmountOut ?? null,
      all_quotes: allQuotes ?? null,
      response_time_ms: responseTimeMs,
      wallet: wallet?.toLowerCase() ?? null,
    })

    if (error) {
      console.error('[log-quote] Supabase insert error:', error.message)
    }

    // ── Server-side: track sources that failed to respond ──
    const failed = (sourcesQueried as string[]).filter(
      (s: string) => !(sourcesResponded as string[]).includes(s)
    )
    for (const src of failed) {
      trackQuoteFailure({ source: src, tokenIn: tokenInSymbol || tokenIn, tokenOut: tokenOutSymbol || tokenOut, error: 'No response' })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[log-quote] Error:', err)
    return NextResponse.json({ ok: true }) // Never fail
  }
}
