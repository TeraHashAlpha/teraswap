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
import {
  classifyDcaFloorDetailed,
  countRegisteredFeeds,
  DCA_NO_PRICE_FILL_CAP_MAX_USD,
  effectiveNoPriceCapUsd,
  type DcaFloorClassification,
} from '@/lib/order-engine/dca-floor-tier'

/**
 * [feat/dca-tier-server-side] With `tokenIn` + `tokenOut` the response also carries the pair's floor
 * tier, from the SAME classifier api/orders calls to decide its 409 (classifyDcaFloor wraps
 * classifyDcaFloorDetailed), so the browser stops classifying and just asks. Never throws to the
 * client: a classifier failure answers `tier: "unpriced"` with unknown legs, HTTP 200 (fail closed).
 * Cached 30s per (chainId, tokenIn, tokenOut).
 */
const CACHE = { 'Cache-Control': 'public, max-age=60' }

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const PAIR_TTL_MS = 30_000
const PAIR_CACHE_MAX = 500
const pairCache = new Map<string, { c: DcaFloorClassification; expiresAt: number }>()
const UNKNOWN: DcaFloorClassification = {
  tier: 'unpriced',
  affected: [],
  legs: { in: { registered: null, priced: null }, out: { registered: null, priced: null } },
}

async function classifyPair(chainId: number, tokenIn: string, tokenOut: string): Promise<DcaFloorClassification> {
  const key = `${chainId}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
  const now = Date.now()
  const hit = pairCache.get(key)
  if (hit && now < hit.expiresAt) return hit.c
  let c: DcaFloorClassification
  try {
    c = await classifyDcaFloorDetailed({ chainId, tokenIn, tokenOut })
  } catch {
    return UNKNOWN // not cached: the next call retries
  }
  if (pairCache.size >= PAIR_CACHE_MAX) {
    for (const [k, v] of pairCache) if (v.expiresAt <= now) pairCache.delete(k)
    if (pairCache.size >= PAIR_CACHE_MAX) pairCache.clear()
  }
  pairCache.set(key, { c, expiresAt: now + PAIR_TTL_MS })
  return c
}

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
  const tokenIn = req.nextUrl.searchParams.get('tokenIn')
  const tokenOut = req.nextUrl.searchParams.get('tokenOut')
  const wantsPair = tokenIn !== null || tokenOut !== null
  if (wantsPair && !(tokenIn && tokenOut && ADDRESS_RE.test(tokenIn) && ADDRESS_RE.test(tokenOut))) {
    return NextResponse.json({ error: 'Invalid tokenIn/tokenOut' }, { status: 400 })
  }
  // Read in parallel with the cap; a count failure never affects the cap answer.
  const count = registeredFeedCount(chainId).catch(() => null)
  const pair = wantsPair ? classifyPair(chainId, tokenIn!, tokenOut!) : null
  const respond = async (effectiveUsd: number) => {
    const base = { ...ceiling, effectiveUsd, registeredFeedCount: await count }
    if (!pair) return NextResponse.json(base, { headers: CACHE })
    const { tier, legs } = await pair
    return NextResponse.json({ tier, legs, ...base, effectiveCap: effectiveUsd, max: ceiling.maxUsd }, { headers: CACHE })
  }
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
