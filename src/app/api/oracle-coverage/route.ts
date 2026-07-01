import { NextResponse, type NextRequest } from 'next/server'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { DEFAULT_CHAIN_ID, getChainStatus } from '@/lib/chains'
import { getChainConfig } from '@/lib/chains/registry'
import { getChainlinkFeed, getComposedFeed } from '@/lib/chains/chainlink-feeds'
import { probeDefiLlamaCoverage } from '@/lib/defillama'
import { resolveOracleCoverage } from '@/lib/order-engine/oracle-coverage'
import { withTimeout } from '@/lib/adapters/shared'

/**
 * [chore/oracle-less-advisory] Read-only oracle-coverage probe for the DCA/order
 * create form's NEUTRAL "no price oracle" note. Given a token + chain, reports
 * whether the token has an INDEPENDENT price oracle:
 *   - a Chainlink feed (direct or composed) in the per-chain registry, OR
 *   - a DefiLlama price on that chain.
 * Purely informational — the caller uses it to render a factual heads-up and
 * NEVER to block order creation. Fails OPEN (hasOracle:true) on any error so a
 * transient outage never surfaces a false note.
 *
 * Not a fund-flow / execution path: no calldata, no swap, no order write.
 */
const KV_GATE_TIMEOUT_MS = 3_000

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Light rate limit (shares the quote budget shape). KV timeout → fail-open allow.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const rate = await withTimeout(
      checkRateLimit(`oracle:${ip}`, QUOTE_RATE_LIMIT.limit, QUOTE_RATE_LIMIT.windowMs),
      KV_GATE_TIMEOUT_MS,
    ).catch(() => ({ allowed: true, remaining: QUOTE_RATE_LIMIT.limit, resetAt: Date.now() + QUOTE_RATE_LIMIT.windowMs }))
    if (!rate.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Try again in a minute.' },
        { status: 429, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(rate.resetAt) } },
      )
    }

    const { searchParams } = req.nextUrl
    const token = searchParams.get('token')
    const chainIdParam = searchParams.get('chainId')

    if (!token) {
      return NextResponse.json({ error: 'Missing required param: token' }, { status: 400 })
    }
    if (!isValidAddress(token)) {
      return NextResponse.json({ error: 'Invalid token address format' }, { status: 400 })
    }
    const chainId = chainIdParam != null ? Number(chainIdParam) : DEFAULT_CHAIN_ID
    if (!Number.isFinite(chainId) || chainId <= 0) {
      return NextResponse.json({ error: `Invalid chainId: ${String(chainIdParam)}` }, { status: 400 })
    }
    if (getChainStatus(chainId) === 'unsupported') {
      return NextResponse.json(
        { error: `Chain ${chainId} is not supported`, code: 'CHAIN_UNSUPPORTED' },
        { status: 400 },
      )
    }

    // 1. Chainlink coverage — synchronous per-chain registry lookup (direct or
    //    composed feed). No network. Native-ETH is normalised to wrapped inside
    //    getChainlinkFeed.
    const hasChainlink = !!(getChainlinkFeed(token, chainId) || getComposedFeed(token, chainId))

    // 2. DefiLlama coverage — only probed when there is NO Chainlink feed (saves
    //    a network call for the common curated-token case). Tri-state so a failed
    //    probe ('unknown') fails open rather than asserting "no coverage".
    let defillama: 'covered' | 'none' | 'unknown' = 'unknown'
    if (!hasChainlink) {
      const slug = (() => {
        try { return getChainConfig(chainId).slug } catch { return 'ethereum' }
      })()
      defillama = await probeDefiLlamaCoverage(token, slug)
    }

    const result = resolveOracleCoverage(hasChainlink, defillama)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch {
    // Fail OPEN — on any unexpected error report has-oracle so the UI shows NO note.
    return NextResponse.json({ hasOracle: true, hasChainlink: false, defillama: 'unknown' }, { status: 200 })
  }
}
