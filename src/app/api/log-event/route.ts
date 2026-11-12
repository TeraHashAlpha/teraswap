import { NextResponse } from 'next/server'
import { getAllowedOrigin } from '@/lib/cors'
import { checkRateLimitWithin, LOG_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { bodySizeGuard, clientIp } from '@/lib/body-limit'

// CORS — restricted to teraswap.app, Vercel previews, and localhost (EXT-L-01).
function corsHeaders(request: Request) {
  const origin = getAllowedOrigin(request) || 'https://teraswap.app'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

export function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * POST /api/log-event
 *
 * RETIRED. TeraSwap no longer records how visitors use the site (no page
 * views, clicks, session ids, referrers, screen widths or user agents).
 * The endpoint stays only because bundles cached in browsers from before the
 * removal still post here: it answers 204, never reads the body and never
 * writes anything. The per-IP rate limit (shared `log:<ip>` budget) and the
 * header-only body-size guard are kept, so the route stays a cheap no-op.
 *
 * The legacy `usage_events` table is untouched; its retention is the owner's call.
 */
export async function POST(req: Request) {
  const headers = corsHeaders(req)

  // [AUDIT-W6 / W6-L-01] Oversized body → 413 (header-only, the body is never read).
  const tooLarge = bodySizeGuard(req, undefined, headers)
  if (tooLarge) return tooLarge

  // [AUDIT-W6 / W6-M-02] Per-IP budget shared by all log-* routes. [A78 S-7] A bounded wait (1 s), then the in-memory
  // limiter at half rate, like /api/quote: a hung Redis used to hold every 204 for ~4.5 s of Upstash retries, and
  // this route answers a no-op that old cached bundles post on every page.
  const rate = await checkRateLimitWithin(`log:${clientIp(req)}`, LOG_RATE_LIMIT.limit, LOG_RATE_LIMIT.windowMs)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { ...headers, 'X-RateLimit-Reset': String(rate.resetAt) } },
    )
  }

  return new NextResponse(null, { status: 204, headers })
}
