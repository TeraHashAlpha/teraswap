import { NextResponse, type NextRequest } from 'next/server'
import { fetchMetaQuote, diagnoseQuoteSources } from '@/lib/api'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { isSystemHalted } from '@/lib/circuit-breaker'
import { verifyBearerToken } from '@/lib/auth'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'

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
  // [P219 review] Optional target chain. Absent → fetchMetaQuote defaults to
  // mainnet, so existing (chainId-less) callers are unaffected.
  const chainIdParam = searchParams.get('chainId')

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

  // [diag] Admin-gated read-only per-source diagnostic. When `debug=sources` is
  // ABSENT the normal quote path below runs byte-identically — this branch is the
  // only behavioural change. Gated behind DEBUG_QUOTE_TOKEN (verifyBearerToken
  // fails closed when the env var is unset). Never alters quote/swap behaviour.
  if (searchParams.get('debug') === 'sources') {
    if (!verifyBearerToken(req.headers.get('authorization'), process.env.DEBUG_QUOTE_TOKEN ?? '')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const diagChainId = chainIdParam ? Number(chainIdParam) : DEFAULT_CHAIN_ID
    const diag = await diagnoseQuoteSources(src, dst, amount, srcDecimals, dstDecimals, diagChainId)
    // Time the REAL fetchMetaQuote on the same chain so a pipeline-level
    // failure/timeout is distinguishable from the per-source results above.
    const pipelineStart = Date.now()
    let pipeline: {
      totalMs: number
      status: 'ok' | 'error'
      quoteCount?: number
      bestSource?: string
      error?: string
    }
    try {
      const r = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, undefined, diagChainId)
      pipeline = { totalMs: Date.now() - pipelineStart, status: 'ok', quoteCount: r.all.length, bestSource: r.best.source }
    } catch (e) {
      pipeline = {
        totalMs: Date.now() - pipelineStart,
        status: 'error',
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      }
    }
    return NextResponse.json({ ...diag, pipeline }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  }

  try {
    const excludeSources = excludeParam ? excludeParam.split(',').map(s => s.trim()) : undefined
    const chainId = chainIdParam ? Number(chainIdParam) : undefined
    const result = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, excludeSources, chainId)

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
    const { src, dst, amount, srcDecimals = 18, dstDecimals = 18, chainId } = body

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

    const result = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, undefined, chainId)

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
