import { NextResponse, type NextRequest } from 'next/server'
import { fetchApproveSpender } from '@/lib/api'
import { getChainStatus } from '@/lib/chains/activation'
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

  // [SPRINT-9G G4 / L06] Don't hand out an approval spender for a chain that is
  // unsupported or not yet live (FeeCollector unset) — mirror the /api/swap gate.
  // Absent chainId → mainnet default → unchecked.
  if (chainIdParam != null) {
    const status = getChainStatus(Number(chainIdParam))
    if (status === 'unsupported') {
      return NextResponse.json(
        { error: `Chain ${chainIdParam} is not supported`, code: 'CHAIN_UNSUPPORTED' },
        { status: 400 },
      )
    }
    if (status === 'coming-soon') {
      return NextResponse.json(
        { error: `Chain ${chainIdParam} is not yet available`, code: 'CHAIN_COMING_SOON' },
        { status: 409 },
      )
    }
  }

  try {
    const spender = await fetchApproveSpender(source, chainIdParam ? Number(chainIdParam) : undefined)
    return NextResponse.json({ spender })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
