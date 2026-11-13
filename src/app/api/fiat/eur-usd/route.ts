import { NextResponse, type NextRequest } from 'next/server'
import { checkRateLimitWithin } from '@/lib/kv-rate-limiter'
import { clientIpKey } from '@/lib/client-ip-key'
import { resolveProxyChainId } from '@/lib/rpc-proxy-chain'
import { withTimeout } from '@/lib/adapters/shared'
import { getPublicClientForChain } from '@/lib/chains/clients'
import { chainlinkAggregatorAbi, validateRoundData } from '@/lib/chainlink'
import { isEurRateFresh, resolveEurUsdFeed, type EurRatePayload } from '@/lib/eur-usd-feed'

/**
 * GET /api/fiat/eur-usd[?chainId=<n>]
 *
 * The Chainlink EUR / USD rate for the euro display (DISPLAY ONLY). One feed read per server instance per hour:
 * 3 eth_calls (description, decimals, latestRoundData, bounded to 6 s) on the feed's own chain, the active chain's feed when the table has one,
 * otherwise mainnet's (src/lib/eur-usd-feed.ts). The identity (description + decimals) and the round (answer > 0, answeredInRound,
 * startedAt, staleness by market hours) are checked fail-closed: anything wrong answers 503 and the browser shows dollars.
 *
 * Response: { rate, updatedAt, maxStaleness }. Edge-cached for an hour; the browser re-checks the age at the moment of use.
 */

const LIMIT = { limit: 30, windowMs: 60_000 } as const
const SERVER_TTL_MS = 3_600_000
/** The three feed reads must answer within this; a hung upstream must not hold the function open (src/app/api/CLAUDE.md: every wait has a deadline). */
const CHAIN_READ_TIMEOUT_MS = 6_000

let cached: { chainId: number; at: number; value: EurRatePayload } | null = null

/** Test-only reset of the per-instance cache. */
export function _resetEurRateCache(): void {
  cached = null
}

const unavailable = () => NextResponse.json({ error: 'EUR rate unavailable' }, { status: 503, headers: { 'Cache-Control': 'public, s-maxage=60' } })

export async function GET(req: NextRequest) {
  const rl = await checkRateLimitWithin(`fiat-eur-usd:${clientIpKey(req)}`, LIMIT.limit, LIMIT.windowMs)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again in a minute.' }, { status: 429, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(rl.resetAt) } })
  }

  // Validated against the chain registry like /api/rpc: an unknown chain is a 400, never a silent mainnet answer. The message is fixed
  // (it does not echo the caller's value).
  const resolved = resolveProxyChainId(req.nextUrl.searchParams.get('chainId'))
  if ('error' in resolved) return NextResponse.json({ error: 'Invalid chainId' }, { status: 400 })
  const wanted = resolved.chainId

  const feed = resolveEurUsdFeed(wanted)
  if (!feed) return unavailable()

  const headers = { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300', 'X-RateLimit-Remaining': String(rl.remaining) }
  if (cached && cached.chainId === feed.chainId && Date.now() - cached.at < SERVER_TTL_MS) return NextResponse.json(cached.value, { headers })

  try {
    const client = getPublicClientForChain(feed.chainId)
    const [description, decimals, round] = await withTimeout(
      Promise.all([
        client.readContract({ address: feed.feed, abi: chainlinkAggregatorAbi, functionName: 'description' }),
        client.readContract({ address: feed.feed, abi: chainlinkAggregatorAbi, functionName: 'decimals' }),
        client.readContract({ address: feed.feed, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData' }),
      ]),
      CHAIN_READ_TIMEOUT_MS,
    )
    if (description !== feed.description || Number(decimals) !== feed.decimals) return unavailable() // not the feed the table says it is
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = round
    // Integrity here; staleness by market hours below (isEurRateFresh: 25 h on weekdays, the last pre-close round while the FX market is closed).
    if (!validateRoundData(roundId, answer, startedAt, updatedAt, answeredInRound)) return unavailable()

    const value: EurRatePayload = { rate: Number(answer) / 10 ** feed.decimals, updatedAt: Number(updatedAt), maxStaleness: feed.maxStaleness }
    if (!Number.isFinite(value.rate) || value.rate <= 0 || !isEurRateFresh(value, Date.now())) return unavailable()
    cached = { chainId: feed.chainId, at: Date.now(), value }
    return NextResponse.json(value, { headers })
  } catch {
    return unavailable() // fixed message: never an upstream URL or error text
  }
}
