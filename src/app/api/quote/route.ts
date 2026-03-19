import { NextResponse, type NextRequest } from 'next/server'
import { fetchMetaQuote } from '@/lib/api'
import { isValidAddress } from '@/lib/validation'

/**
 * Server-side proxy for meta-quote requests.
 *
 * Running quotes server-side avoids browser CORS restrictions that
 * block direct calls to 1inch, Odos, 0x, Balancer and other DEX APIs.
 * KyberSwap and ParaSwap happen to allow browser CORS, but most do not.
 */
export async function GET(req: NextRequest) {
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
  try {
    const body = await req.json()
    const { src, dst, amount, srcDecimals = 18, dstDecimals = 18 } = body

    if (!src || !dst || !amount) {
      return NextResponse.json(
        { error: 'Missing required fields: src, dst, amount' },
        { status: 400 },
      )
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
