/**
 * /api/price/defillama — DefiLlama spot price for the browser, fetched SERVER-SIDE.
 *
 * [fix/functional-chain-ui C8] DCAPanel's price fallback used to call DefiLlama's price API
 * straight from the browser, exposing the visitor's IP to DefiLlama and keeping that host in CSP
 * connect-src. This route runs the SAME `fetchDefiLlamaPrice` (same response validation, same
 * low-confidence rejection, same 2-min in-memory cache); only the process boundary moved.
 *
 *   GET /api/price/defillama?chainId=<registry chain>&address=<0x..40hex>
 *     → 200 { price: DefiLlamaPrice | null }  — null = no usable price, exactly as before
 *     → 400 a chainId the chain registry does not know, or a malformed address
 *     → 429 past the per-IP limit
 *
 * @internal — server-only route. Reads only; no auth, no fund flow, no state write.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { isAddress } from 'viem'
import { fetchDefiLlamaPrice } from '@/lib/defillama'
import { checkRateLimit } from '@/lib/kv-rate-limiter'
import { getChainConfig, getSupportedChainIds } from '@/lib/chains/registry'

// The panel asks for at most two tokens per pair change; 30/min per IP is generous for that.
const DEFILLAMA_PRICE_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const

const PRICE_CACHE_CONTROL = 'public, max-age=30, s-maxage=30'

/** Digits-only first (no `__proto__`-style input reaches a lookup), then the chain registry. */
function resolveChainId(raw: string | null): number | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null
  const chainId = Number(raw)
  return getSupportedChainIds().includes(chainId) ? chainId : null
}

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rateCheck = await checkRateLimit(
    `defillama-price:${ip}`,
    DEFILLAMA_PRICE_RATE_LIMIT.limit,
    DEFILLAMA_PRICE_RATE_LIMIT.windowMs,
  )
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a minute.' },
      { status: 429, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(rateCheck.resetAt) } },
    )
  }

  const chainId = resolveChainId(req.nextUrl.searchParams.get('chainId'))
  const address = req.nextUrl.searchParams.get('address') ?? ''
  if (chainId === null || !isAddress(address, { strict: false })) {
    return NextResponse.json({ error: 'Invalid chainId or address' }, { status: 400 })
  }

  // fetchDefiLlamaPrice never throws (null on any upstream/parse failure).
  const price = await fetchDefiLlamaPrice(address, getChainConfig(chainId).slug)
  return NextResponse.json({ price }, { headers: { 'Cache-Control': PRICE_CACHE_CONTROL } })
}
