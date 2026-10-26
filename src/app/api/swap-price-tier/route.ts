/**
 * GET /api/swap-price-tier?chainId=<registry chain>&tokenIn=<0x..40hex>&tokenOut=<0x..40hex>
 *
 * [feat/swap-price-tiers] The SERVER's price tier for a swap pair (owner D1, 2026-10-26: the server is the
 * authority; the client never applies a stricter rule). Each leg runs the shared ADR-024 quorum
 * (src/lib/price-quorum.ts, D4): Chainlink (the chain's feed registry via fetchChainlinkPriceRaw) ->
 * DefiLlama -> CoinGecko; >= 2 sources within 300 bps = `priced`, exactly 1 = `single-source`, 0 or
 * disagreeing = `unpriced`. The pair takes the BEST leg (one priced leg sizes the whole trade).
 *
 *   -> 200 { tier, legs: { in: { tier, sources, usd? }, out: { … } }, agreementBps? }
 *   -> 400 a chainId the registry does not know, or a malformed / missing token
 *   -> 429 past the per-IP limit (the same limiter, limit and shape as GET /api/quote)
 *
 * Native ETH is classified as the chain's wrapped native (the address the oracle registry and the keeper
 * know). 30 s cache per (chainId, tokenIn, tokenOut), lowercased; `Cache-Control: public, max-age=30`.
 * Never 5xx: any exception answers `unpriced` (the consent tier, D3) and is NOT cached.
 *
 * @internal — server-only route. Reads only; no auth, no fund flow, no state write. The browser never calls
 * a price source itself (no-browser-third-party.test.ts); it asks here.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { trustedClientIp } from '@/lib/trusted-ip'
import { getChainConfig, getSupportedChainIds } from '@/lib/chains/registry'
import { normalizeAddress } from '@/lib/order-engine/normalize-address'
import { classifyLegPrice } from '@/lib/price-quorum'
import { fetchChainlinkPriceRaw } from '@/lib/chainlink'
import { combinePairTier, UNPRICED_PAIR, type SwapPriceTierResponse } from '@/lib/swap-price-tier'
import { NATIVE_ETH } from '@/lib/constants'

const TIER_CACHE_CONTROL = 'public, max-age=30, s-maxage=30'
const PAIR_TTL_MS = 30_000
const PAIR_CACHE_MAX = 500
const pairCache = new Map<string, { body: SwapPriceTierResponse; expiresAt: number }>()

/** Digits-only first (no `__proto__`-style input reaches a lookup), then the chain registry. */
function resolveChainId(raw: string | null): number | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null
  const chainId = Number(raw)
  return getSupportedChainIds().includes(chainId) ? chainId : null
}

export async function GET(req: NextRequest) {
  const rateCheck = await checkRateLimit(
    `swap-price-tier:${trustedClientIp(req)}`,
    QUOTE_RATE_LIMIT.limit,
    QUOTE_RATE_LIMIT.windowMs,
  )
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a minute.' },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }

  const chainId = resolveChainId(req.nextUrl.searchParams.get('chainId'))
  const rawIn = normalizeAddress(req.nextUrl.searchParams.get('tokenIn'))
  const rawOut = normalizeAddress(req.nextUrl.searchParams.get('tokenOut'))
  if (chainId === null || !rawIn || !rawOut) {
    return NextResponse.json({ error: 'Invalid chainId or tokenIn/tokenOut' }, { status: 400 })
  }

  const cfg = getChainConfig(chainId)
  const wrapped = cfg.nativeCurrency.wrappedAddress.toLowerCase()
  const sign = (a: string) => (a === NATIVE_ETH.toLowerCase() ? wrapped : a)
  const tokenIn = sign(rawIn)
  const tokenOut = sign(rawOut)

  const key = `${chainId}:${tokenIn}:${tokenOut}`
  const now = Date.now()
  const hit = pairCache.get(key)
  if (hit && now < hit.expiresAt) {
    return NextResponse.json(hit.body, { headers: { 'Cache-Control': TIER_CACHE_CONTROL } })
  }

  let body: SwapPriceTierResponse
  try {
    const leg = (addr: string) =>
      classifyLegPrice(addr, cfg.slug, { chainlink: () => fetchChainlinkPriceRaw(addr, chainId) })
    const [legIn, legOut] = await Promise.all([leg(tokenIn), leg(tokenOut)])
    body = combinePairTier(legIn, legOut)
    if (pairCache.size >= PAIR_CACHE_MAX) {
      for (const [k, v] of pairCache) if (v.expiresAt <= now) pairCache.delete(k)
      if (pairCache.size >= PAIR_CACHE_MAX) pairCache.clear()
    }
    pairCache.set(key, { body, expiresAt: now + PAIR_TTL_MS })
  } catch {
    body = UNPRICED_PAIR // not cached: the next call retries
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': TIER_CACHE_CONTROL } })
}
