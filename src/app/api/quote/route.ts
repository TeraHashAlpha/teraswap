import { NextResponse, type NextRequest } from 'next/server'
import { fetchMetaQuote } from '@/lib/api'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { isSystemHalted } from '@/lib/circuit-breaker'

/**
 * Shared 503 response for when the circuit breaker has halted routing.
 * Returns Retry-After: 300 (5 min) so clients back off without hammering.
 */
function haltResponse(): NextResponse {
  return NextResponse.json(
    { error: 'System temporarily paused for safety. Please try again later.', halted: true },
    {
      status: 503,
      headers: { 'Retry-After': '300' },
    },
  )
}

/**
 * Server-side proxy for meta-quote requests.
 *
 * Running quotes server-side avoids browser CORS restrictions that
 * block direct calls to 1inch, Odos, 0x, Balancer and other DEX APIs.
 * KyberSwap and ParaSwap happen to allow browser CORS, but most do not.
 */
export async function GET(req: NextRequest) {
  // [H-03] Circuit breaker halt — short-circuit before rate limiting
  if (await isSystemHalted()) return haltResponse()

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rateCheck = await checkRateLimit(`quote:${ip}`, QUOTE_RATE_LIMIT.limit, QUOTE_RATE_LIMIT.windowMs)
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a minute.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }
  const { searchParams } = req.nextUrl
  const src = searchParams.get('src')
  const dst = searchParams.get('dst')
  const amount = searchParams.get('amount')
  const srcDecimals = Number(searchParams.get('srcDecimals') ?? '18')
  const dstDecimals = Number(searchParams.get('dstDecimals') ?? '18')
  const excludeParam = searchParams.get('exclude') // comma-separated source names to exclude

  if (!src || !dst || !amount) {
    return NextResponse.json(
      { error: 'Missing required params: src, dst, amount' },
      { status: 400 },
    )
  }

  // Q8: Validate address format
  if (!isValidAddress(src) || !isValidAddress(dst)) {
    return NextResponse.json({ error: 'Invalid token address format' }, { status: 400 })
  }

  try {
    const excludeSources = excludeParam ? excludeParam.split(',').map(s => s.trim()) : undefined
    const result = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, excludeSources)

    // Serialize BigInt-safe (toAmount is already a string in NormalizedQuote)
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

// Also support POST for larger payloads (future-proofing)
export async function POST(req: NextRequest) {
  // [H-03] Circuit breaker halt — short-circuit before rate limiting
  if (await isSystemHalted()) return haltResponse()

  const postIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const postRateCheck = await checkRateLimit(`quote:${postIp}`, QUOTE_RATE_LIMIT.limit, QUOTE_RATE_LIMIT.windowMs)
  if (!postRateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(postRateCheck.resetAt),
        },
      },
    )
  }
  try {
    const body = await req.json()
    const { src, dst, amount, srcDecimals = 18, dstDecimals = 18 } = body

    if (!src || !dst || !amount) {
      return NextResponse.json(
        { error: 'Missing required fields: src, dst, amount' },
        { status: 400 },
      )
    }

    // API-HIGH-05: Validate addresses in POST (was missing)
    if (!isValidAddress(src) || !isValidAddress(dst)) {
      return NextResponse.json({ error: 'Invalid token address format' }, { status: 400 })
    }

    const result = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals)

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-RateLimit-Remaining': String(postRateCheck.remaining),
        'X-RateLimit-Reset': String(postRateCheck.resetAt),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
