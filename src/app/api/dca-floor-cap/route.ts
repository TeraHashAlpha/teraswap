/**
 * GET /api/dca-floor-cap?chainId=N — the effective per-buy USD cap for a no-price DCA fill.
 * min(keeper_runtime_config.no_price_fill_cap_usd for that chain, DCA_NO_PRICE_FILL_CAP_MAX_USD);
 * the ceiling when there is no row or the read fails. Read-only: the web app never writes the table.
 *
 * [fix/dca-consent-copy-and-tier-check] Also `registeredFeedCount`: how many tokens in the chain's
 * suggested set the chain's OrderExecutorV3 has a feed registered for (`tokenUsdFeeds`), via the same
 * registry helper the tier classifier uses. Cached 60s per chain; null when the registry cannot be
 * read (never cached, never a guess) — the consent copy then shows no number.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { clientIp } from '@/lib/body-limit'
import { getChainTokenList } from '@/lib/chains/tokens'
import { countRegisteredFeeds, DCA_NO_PRICE_FILL_CAP_MAX_USD, effectiveNoPriceCapUsd } from '@/lib/order-engine/dca-floor-tier'

const CACHE = { 'Cache-Control': 'public, max-age=60' }

const FEED_COUNT_TTL_MS = 60_000
const feedCountCache = new Map<number, { n: number; expiresAt: number }>()

async function registeredFeedCount(chainId: number): Promise<number | null> {
  const hit = feedCountCache.get(chainId)
  if (hit && Date.now() < hit.expiresAt) return hit.n
  const n = await countRegisteredFeeds({ chainId, tokens: getChainTokenList(chainId).map(t => t.address) })
  if (n !== null) feedCountCache.set(chainId, { n, expiresAt: Date.now() + FEED_COUNT_TTL_MS })
  return n
}

export async function GET(req: NextRequest) {
  const rate = await checkRateLimit(`dca-floor-cap:${clientIp(req)}`, QUOTE_RATE_LIMIT.limit, QUOTE_RATE_LIMIT.windowMs)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in 60 seconds.' },
      { status: 429, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(rate.resetAt) } },
    )
  }
  const chainId = Number(req.nextUrl.searchParams.get('chainId'))
  const ceiling = { maxUsd: DCA_NO_PRICE_FILL_CAP_MAX_USD }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: 'Invalid chainId' }, { status: 400 })
  }
  // Read in parallel with the cap; a count failure never affects the cap answer.
  const count = registeredFeedCount(chainId).catch(() => null)
  const respond = async (effectiveUsd: number) =>
    NextResponse.json({ ...ceiling, effectiveUsd, registeredFeedCount: await count }, { headers: CACHE })
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return respond(ceiling.maxUsd)
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } })
    const { data } = await supabase
      .from('keeper_runtime_config')
      .select('no_price_fill_cap_usd')
      .eq('chain_id', chainId)
      .maybeSingle()
    return respond(effectiveNoPriceCapUsd(data?.no_price_fill_cap_usd))
  } catch {
    return respond(ceiling.maxUsd)
  }
}
