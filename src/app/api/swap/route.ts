import { NextResponse, type NextRequest } from 'next/server'
import { fetchSwapFromSource } from '@/lib/api'
import type { AggregatorName } from '@/lib/constants'
import { validateSwapPrice } from '@/lib/defillama'
import { isKnownSwapSelector, getSelector } from '@/lib/swap-selectors'
import { checkRateLimit, SWAP_RATE_LIMIT } from '@/lib/kv-rate-limiter'

/**
 * Server-side proxy for swap calldata requests.
 *
 * Like the quote route, this avoids browser CORS restrictions
 * when fetching swap calldata from external DEX APIs.
 */

// ── [Audit] Max request body size (prevent oversized payloads)
const MAX_BODY_SIZE = 10_000 // 10KB

export async function POST(req: NextRequest) {
  // [Audit B-06] Rate limiting by IP — persistent via Vercel KV
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown'
  const rateCheck = await checkRateLimit(`swap:${ip}`, SWAP_RATE_LIMIT.limit, SWAP_RATE_LIMIT.windowMs)

  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in 60 seconds.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }

  try {

    // [Audit] Request size check
    const contentLength = parseInt(req.headers.get('content-length') || '0', 10)
    if (contentLength > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: 'Request body too large' },
        { status: 413 },
      )
    }

    const body = await req.json()
    const {
      source,
      src,
      dst,
      amount,
      from,
      slippage = 0.5,
      srcDecimals = 18,
      dstDecimals = 18,
      quoteMeta,
      chainId,
    } = body

    if (!source || !src || !dst || !amount || !from) {
      return NextResponse.json(
        { error: 'Missing required fields: source, src, dst, amount, from' },
        { status: 400 },
      )
    }

    // [Audit] Validate address format
    const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
    if (!ADDRESS_RE.test(src) || !ADDRESS_RE.test(dst) || !ADDRESS_RE.test(from)) {
      return NextResponse.json(
        { error: 'Invalid address format' },
        { status: 400 },
      )
    }

    // [Audit / L-01] Validate slippage range — max 15% for mainnet safety
    const slippageNum = Number(slippage)
    if (isNaN(slippageNum) || slippageNum < 0 || slippageNum > 15) {
      return NextResponse.json(
        { error: 'Slippage must be between 0 and 15%' },
        { status: 400 },
      )
    }

    const result = await fetchSwapFromSource(
      source as AggregatorName,
      src,
      dst,
      amount,
      from,
      slippageNum,
      srcDecimals,
      dstDecimals,
      quoteMeta,
      chainId ? Number(chainId) : undefined,
    )

    // [SC-04] Server-side defense-in-depth — mirrors frontend KNOWN_SWAP_SELECTORS
    if (result.tx?.data) {
      if (!isKnownSwapSelector(result.tx.data as string)) {
        const selector = getSelector(result.tx.data as string)
        console.warn('[SC-04] Rejected unknown swap selector:', selector, 'source:', source)
        return NextResponse.json(
          { error: 'Unknown swap function selector', selector },
          { status: 400 },
        )
      }
    }

    // ── [Security] Server-side price validation via DefiLlama ──
    // Validates swap output against independent oracle to catch
    // price manipulation, extreme slippage, or rogue aggregator responses.
    // Non-blocking: if DefiLlama is unreachable, swap proceeds normally.
    if (result.toAmount) {
      try {
        const priceCheck = await validateSwapPrice({
          tokenIn: src,
          tokenOut: dst,
          amountIn: amount,
          amountOut: result.toAmount,
          decimalsIn: srcDecimals,
          decimalsOut: dstDecimals,
        })

        if (priceCheck && !priceCheck.valid) {
          console.warn(
            `[PRICE-GUARD] Blocked swap ${source}: ${src} → ${dst}`,
            `deviation=${(priceCheck.deviation * 100).toFixed(1)}%`,
            `reason=${priceCheck.reason}`,
          )
          return NextResponse.json(
            {
              error: priceCheck.reason,
              priceGuard: true,
              deviation: priceCheck.deviation,
            },
            { status: 422 },
          )
        }

        // Attach oracle info for client-side display (non-blocking data)
        if (priceCheck) {
          const ext = result as unknown as Record<string, unknown>
          ext.oracleDeviation = priceCheck.deviation
          ext.oraclePriceIn = priceCheck.oraclePriceIn
          ext.oraclePriceOut = priceCheck.oraclePriceOut
        }
      } catch {
        // Never block swaps due to oracle errors
      }
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetAt),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
