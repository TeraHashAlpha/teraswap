import { NextResponse, type NextRequest } from 'next/server'
import { fetchSwapFromSource } from '@/lib/api'
import type { AggregatorName } from '@/lib/constants'
import { validateSwapPrice } from '@/lib/defillama'

/**
 * Server-side proxy for swap calldata requests.
 *
 * Like the quote route, this avoids browser CORS restrictions
 * when fetching swap calldata from external DEX APIs.
 */

// ── [Audit B-06 / M-02] Rate limiting ───────────────────
// NOTE: In-memory rate limiting resets on serverless cold starts.
// For production, replace with Redis/KV store or use Vercel's
// edge rate limiting middleware.
//
// This still provides protection against sustained abuse within
// a single instance's lifetime (typically 5-15 min on Vercel).
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 20           // [M-02] Reduced from 30 to 20 for tighter control
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

// Periodic cleanup every 2 minutes to prevent memory leak
// (shorter interval since serverless instances are short-lived)
if (typeof globalThis !== 'undefined') {
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of rateLimitMap.entries()) {
      if (now > value.resetAt) rateLimitMap.delete(key)
    }
  }, 120_000)
  // Don't prevent process from exiting
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref()
  }
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

// ── [Audit] Max request body size (prevent oversized payloads)
const MAX_BODY_SIZE = 10_000 // 10KB

export async function POST(req: NextRequest) {
  try {
    // [Audit B-06] Rate limiting by IP
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || req.headers.get('x-real-ip')
      || 'unknown'

    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Try again in 60 seconds.' },
        { status: 429 },
      )
    }

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
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
