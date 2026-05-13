/**
 * [P98] GET /api/analytics/personal — per-wallet swap analytics.
 *
 * Returns a PersonalAnalytics aggregate for the wallet in `?wallet=0x…`.
 * Aggregation runs server-side via Supabase (filtered by wallet, scan
 * capped at 10k rows); a 5-minute Upstash KV cache absorbs repeated
 * dashboard refreshes from the same browser. Rate-limited at 10 req/min
 * per wallet to keep the endpoint cheap.
 *
 * The Supabase RLS on `swaps` is the authority — anon callers only ever
 * see their own wallet's rows. The address validation here is
 * defence-in-depth + a clean 400 for malformed input.
 */

import { NextResponse, type NextRequest } from 'next/server'
import {
  fetchPersonalAnalytics,
  type PersonalAnalytics,
} from '@/lib/personal-analytics'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit } from '@/lib/kv-rate-limiter'
import { kv } from '@/lib/kv'

export const dynamic = 'force-dynamic'

const CACHE_TTL_SECONDS = 300 // 5 minutes
const RATE_LIMIT = { limit: 10, windowMs: 60_000 }

function cacheKey(wallet: string): string {
  return `analytics:personal:${wallet.toLowerCase()}`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const wallet = req.nextUrl.searchParams.get('wallet')
  if (!wallet) {
    return NextResponse.json(
      { error: 'Missing required query param: wallet' },
      { status: 400 },
    )
  }
  if (!isValidAddress(wallet)) {
    return NextResponse.json(
      { error: 'wallet must be a valid 0x-prefixed 20-byte address.' },
      { status: 400 },
    )
  }

  // Rate limit keyed by the (lowercased) wallet so a busy dashboard
  // doesn't burn through a shared per-IP quota.
  const walletLc = wallet.toLowerCase()
  const rate = await checkRateLimit(
    `analytics-personal:${walletLc}`,
    RATE_LIMIT.limit,
    RATE_LIMIT.windowMs,
  )
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please retry in a minute.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(RATE_LIMIT.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(rate.resetAt / 1000)),
          'Retry-After': String(
            Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000)),
          ),
        },
      },
    )
  }

  // Cache lookup — opportunistic. Any KV error falls through to a fresh
  // aggregation rather than returning a 5xx for the user.
  const key = cacheKey(walletLc)
  try {
    const cached = await kv.get<PersonalAnalytics>(key)
    if (cached && cached.wallet === walletLc) {
      return NextResponse.json(cached, {
        headers: {
          'X-Cache': 'HIT',
          'Cache-Control': 'private, max-age=60',
        },
      })
    }
  } catch (err) {
    console.warn('[analytics/personal] cache read failed:', err)
  }

  const analytics = await fetchPersonalAnalytics(walletLc)

  // Cache write — best-effort. Stale-on-write semantics are fine here.
  kv.set(key, analytics, { ex: CACHE_TTL_SECONDS }).catch((err) => {
    console.warn('[analytics/personal] cache write failed:', err)
  })

  return NextResponse.json(analytics, {
    headers: {
      'X-Cache': 'MISS',
      'Cache-Control': 'private, max-age=60',
    },
  })
}
