import { NextResponse, type NextRequest } from 'next/server'
import { fetchApproveSpender } from '@/lib/api'
import type { AggregatorName } from '@/lib/constants'

/**
 * Server-side proxy for fetching approve spender address.
 * Avoids CORS issues with 1inch, 0x, Velora spender endpoints.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const source = searchParams.get('source') as AggregatorName | null
  // [P226] Optional chain — absent → mainnet (fetchApproveSpender default).
  const chainIdParam = searchParams.get('chainId')

  if (!source) {
    return NextResponse.json(
      { error: 'Missing required param: source' },
      { status: 400 },
    )
  }

  try {
    const spender = await fetchApproveSpender(source, chainIdParam ? Number(chainIdParam) : undefined)
    return NextResponse.json({ spender })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
