import { NextResponse, type NextRequest } from 'next/server'
// [P114/M-03] log-quote is a pure-insert path → INSERT-only logger
// client. A leaked key here can't read orders/api_keys or delete rows.
import { getSupabaseLogger } from '@/lib/supabase'
import { trackQuoteFailure } from '@/lib/security-tracker'
import { trackWalletAction } from '@/lib/wallet-activity-server'
import { checkRateLimitWithin, LOG_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { bodySizeGuard, clientIp } from '@/lib/body-limit'
import { boundLogQuoteBody } from '@/lib/log-quote-input'

/**
 * POST /api/log-quote
 *
 * Fire-and-forget endpoint to log quote requests to Supabase.
 * Used for analytics: which sources win, response times, popular pairs.
 */
export async function POST(req: NextRequest) {
  try {
    // [AUDIT-W6 / W6-L-01 + W6-M-02] Body cap + shared per-IP log budget,
    // BEFORE any parse or Supabase work.
    const tooLarge = bodySizeGuard(req)
    if (tooLarge) return tooLarge
    const rate = await checkRateLimitWithin(`log:${clientIp(req)}`, LOG_RATE_LIMIT.limit, LOG_RATE_LIMIT.windowMs)
    if (!rate.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429, headers: { 'X-RateLimit-Reset': String(rate.resetAt) } },
      )
    }

    const supabase = getSupabaseLogger()
    if (!supabase) {
      return NextResponse.json({ ok: true, skipped: true })
    }

    const body = await req.json()

    // [SEC-3] Registry source names only (de-duplicated, at most one per registry source) and a size bound on every
    // other field; a value past its bound is dropped like an absent one (lib/log-quote-input.ts).
    const {
      tokenIn,
      tokenInSymbol,
      tokenOut,
      tokenOutSymbol,
      amountIn,
      sourcesQueried,
      sourcesResponded,
      bestSource,
      bestAmountOut,
      allQuotes,
      responseTimeMs,
      wallet,
    } = boundLogQuoteBody(body as Record<string, unknown>)

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

    // ── Server-side wallet activity tracking (fire-and-forget) ──
    if (wallet) {
      trackWalletAction(wallet, {
        category: 'quote',
        action: 'quote_requested',
        tokenIn: tokenInSymbol || tokenIn,
        tokenOut: tokenOutSymbol || tokenOut,
        source: bestSource ?? undefined,
        durationMs: responseTimeMs,
        metadata: {
          sourcesQueried: sourcesQueried.length,
          sourcesResponded: sourcesResponded.length,
          bestSource,
        },
      })
    }

    // ── Server-side: track sources that failed to respond ──
    // [SEC-3] sourcesQueried holds each registry name at most once, so this is at most one event per registry source.
    const failed = sourcesQueried.filter((s) => !sourcesResponded.includes(s))
    for (const src of failed) {
      trackQuoteFailure({ source: src, tokenIn: tokenInSymbol || tokenIn, tokenOut: tokenOutSymbol || tokenOut, error: 'No response' })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[log-quote] Error:', err)
    return NextResponse.json({ ok: true }) // Never fail
  }
}
