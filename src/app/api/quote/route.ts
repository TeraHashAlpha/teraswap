import { NextResponse, type NextRequest } from 'next/server'
import { fetchMetaQuote } from '@/lib/api'
import { isValidAddress } from '@/lib/validation'

// API-HIGH-04: Rate limiting for quote endpoint (30 reqs/min per IP)
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 30
const rateLimitMap = new Map<string, number[]>()
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS
  for (const [ip, timestamps] of rateLimitMap) {
    const filtered = timestamps.filter(t => t > cutoff)
    if (filtered.length === 0) rateLimitMap.delete(ip)
    else rateLimitMap.set(ip, filtered)
  }
}, 60_000)
cleanupTimer.unref?.()

function checkQuoteRateLimit(req: NextRequest): boolean {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const timestamps = (rateLimitMap.get(ip) || []).filter(t => t > cutoff)
  timestamps.push(now)
  rateLimitMap.set(ip, timestamps)
  return timestamps.length <= RATE_LIMIT_MAX
}

/**
 * Server-side proxy for meta-quote requests.
 *
 * Running quotes server-side avoids browser CORS restrictions that
 * block direct calls to 1inch, Odos, 0x, Balancer and other DEX APIs.
 * KyberSwap and ParaSwap happen to allow browser CORS, but most do not.
 */
export async function GET(req: NextRequest) {
  if (!checkQuoteRateLimit(req)) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again in a minute.' }, { status: 429 })
  }
  const { searchParams } = req.nextUrl
  const src = searchParams.get('src')
  const dst = searchParams.get('dst')
  const amount = searchParams.get('amount')
  const srcDecimals = Number(searchParams.get('srcDecimals') ?? '18')
  const dstDecimals = Number(searchParams.get('dstDecimals') ?? '18')

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
    const result = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals)

    // Serialize BigInt-safe (toAmount is already a string in NormalizedQuote)
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

// Also support POST for larger payloads (future-proofing)
export async function POST(req: NextRequest) {
  if (!checkQuoteRateLimit(req)) {
    return NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429 })
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
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
