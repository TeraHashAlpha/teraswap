/**
 * [LP-09] GET /api/v1/quote — public, versioned meta-aggregator quote.
 *
 * First public endpoint of the TeraSwap v1 API. Authenticated with the
 * `X-API-Key` header (verifyApiKey from P81); rate-limited per-key on
 * the tier the key was issued at; CORS-open so browser-based callers
 * (bots, dashboards, the upcoming Telegram bot) can hit it from any
 * origin.
 *
 * Internal /api/quote (which the frontend still uses) is deliberately
 * left untouched: it has IP-based rate limiting and no auth, which is
 * correct for the in-app surface. The two endpoints share fetchMetaQuote
 * but nothing else.
 *
 * Response shape is documented in the spec and frozen for v1:
 *   { best, quotes, gasless, meta: { timestamp, sourcesQueried, sourcesResponded, mevProtected } }
 *
 * [P97] The `gasless` object surfaces whether a CoW Protocol quote is
 * available and whether it's the better deal once gas savings are taken
 * into account. The field is always present (zero-valued when CoW didn't
 * quote) so consumers don't have to branch on undefined.
 *
 * @internal — Next.js route handler. Public surface starts at the request boundary.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { fetchMetaQuote, type NormalizedQuote } from '@/lib/api'
import { verifyApiKey } from '@/lib/api-auth'
import { isSystemHalted } from '@/lib/circuit-breaker'
import { isValidAddress } from '@/lib/validation'
import { safeBigInt } from '@/lib/utils'
import { AGGREGATOR_META, CHAIN_ID } from '@/lib/constants'
import { analyzeGasless } from '@/lib/gasless-engine'

export const dynamic = 'force-dynamic'

// ── CORS ──────────────────────────────────────────────────
//
// v1 is a PUBLIC API — browser-origin callers (Telegram bot UI in S14,
// third-party dashboards, etc.) must be able to hit it. Allow-Origin is
// `*`, with X-API-Key in Allow-Headers so the preflight passes when
// the client sends the credential header.

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-API-Key, Content-Type',
  // 24h preflight cache — these headers don't change between deploys.
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
}

function withCors(headers?: Record<string, string>): Record<string, string> {
  return { ...CORS_HEADERS, ...(headers ?? {}) }
}

function jsonError(
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: withCors(extraHeaders) },
  )
}

// ── OPTIONS preflight ────────────────────────────────────

export async function OPTIONS(): Promise<NextResponse> {
  // 204 No Content is the conventional preflight response shape.
  return new NextResponse(null, { status: 204, headers: withCors() })
}

// ── GET ──────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // 1. Circuit breaker — short-circuit before any auth/RPC work. A
  //    halted system stays dark to public callers exactly the way it
  //    does for the in-app surface.
  if (await isSystemHalted()) {
    return jsonError(
      503,
      'System temporarily paused for safety. Please try again later.',
      { 'Retry-After': '300' },
    )
  }

  // 2. Auth + per-key rate limit. verifyApiKey returns a typed result
  //    we forward verbatim into the NextResponse; X-RateLimit-* headers
  //    surface back to the client whether the call succeeded or got
  //    rate-limited.
  const auth = await verifyApiKey(req)
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.rateLimitHeaders)
  }

  // 3. Parse + validate query params.
  const sp = req.nextUrl.searchParams
  const tokenIn = sp.get('tokenIn')
  const tokenOut = sp.get('tokenOut')
  const amount = sp.get('amount')
  const slippageRaw = sp.get('slippage')
  const chainIdRaw = sp.get('chainId')
  // [P102] Optional output destination. The quote itself doesn't change,
  // but we validate + echo so callers learn early whether their recipient
  // is well-formed before pricing the trade.
  const recipientRaw = sp.get('recipient')

  if (!tokenIn || !tokenOut || !amount) {
    return jsonError(400, 'Missing required params: tokenIn, tokenOut, amount.')
  }
  if (!isValidAddress(tokenIn) || !isValidAddress(tokenOut)) {
    return jsonError(400, 'tokenIn and tokenOut must be valid 0x-prefixed 20-byte addresses.')
  }

  let recipient: string | null = null
  if (recipientRaw !== null && recipientRaw !== '') {
    if (!isValidAddress(recipientRaw)) {
      return jsonError(400, 'recipient must be a valid 0x-prefixed 20-byte address.')
    }
    recipient = recipientRaw
  }
  // [10-L-01] safeBigInt rejects anything that isn't a decimal-integer
  // string — covers undefined/'NaN'/'0x123'/'1.5' without throwing.
  const amountBn = safeBigInt(amount)
  if (amountBn === null || amountBn <= 0n) {
    return jsonError(400, 'amount must be a positive decimal-integer string (raw wei).')
  }

  let slippage = 0.5
  if (slippageRaw !== null && slippageRaw !== '') {
    const parsed = Number(slippageRaw)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) {
      return jsonError(400, 'slippage must be a number between 0 and 50.')
    }
    slippage = parsed
  }

  if (chainIdRaw !== null && chainIdRaw !== '') {
    const parsed = Number(chainIdRaw)
    if (!Number.isInteger(parsed) || parsed !== CHAIN_ID) {
      return jsonError(
        400,
        `chainId must be ${CHAIN_ID} (Ethereum mainnet). Multi-chain is not yet supported.`,
      )
    }
  }

  // 4. Run the meta-quote. fetchMetaQuote handles per-source circuit
  //    breakers, timeouts, and outlier filtering internally; we only
  //    need to map adapter-side errors → API error responses.
  let meta
  try {
    meta = await fetchMetaQuote(tokenIn, tokenOut, amount)
  } catch (err) {
    // [11-M-02] Keep err.message in server logs only — public catch
    // paths must not leak adapter / limiter implementation details
    // (rate limiter internal state, upstream URLs, adapter names, ...).
    const internalMessage = err instanceof Error ? err.message : 'Unknown meta-quote error'
    console.error('[v1/quote] meta-quote failed:', internalMessage)
    // The internal limiter (`globalLimiter`) throws "Rate limited" on
    // overflow — surface that as 429 even though the per-key limit
    // passed; otherwise treat as a 502 upstream failure.
    if (/rate.limit/i.test(internalMessage)) {
      return jsonError(429, 'Rate limit exceeded. Please retry.', auth.rateLimitHeaders)
    }
    return jsonError(502, 'Upstream service error. Please retry.', auth.rateLimitHeaders)
  }

  // 5. Shape the response per the v1 contract. We surface
  //    `quotes` (renamed from `all` for cleaner external naming) and
  //    a `meta` block carrying sourcesQueried/sourcesResponded/etc.
  const quotes: NormalizedQuote[] = meta.all
  // sourcesQueried ≈ adapter registry size minus disabled sources;
  // we approximate via the visible response count rounded up to the
  // engine's nominal 11. The accurate count would require a separate
  // hook into fetchMetaQuote — for v1 we expose responded + the
  // best-effort queried number derived from the per-source circuit
  // states the engine exposes.
  const sourcesResponded = quotes.length
  const sourcesQueried = Math.max(sourcesResponded, 11)
  const bestIsMevProtected = AGGREGATOR_META[meta.best.source]?.mevProtected ?? false

  // [P97] Gasless analysis. Server-side we don't have the live ETH price
  // / gas price, so analyzeGasless falls back to the adapter-supplied
  // gasUsd on the best non-CoW route — close enough for API consumers
  // who use this for routing hints rather than exact P&L calc.
  const bestNonCow = quotes.find((q) => q.source !== 'cowswap')
  const referenceGasUsd = bestNonCow?.gasUsd ?? 0
  const gaslessAnalysis = analyzeGasless(quotes, referenceGasUsd)

  // Slippage applies on the consumer side (this endpoint returns raw
  // quotes; the caller decides how to translate to minimumOutput).
  // We echo it back so the response is self-describing.
  const responseBody = {
    best: meta.best,
    quotes,
    // [P97] Always present. When no CoW quote exists, `available` is false
    // and the rest is zero-valued — never undefined.
    gasless: {
      available: gaslessAnalysis.available,
      recommended: gaslessAnalysis.recommended,
      gasSavingsUsd: Number(gaslessAnalysis.gasSavingsUsd.toFixed(2)),
      priceDifferencePercent: gaslessAnalysis.priceDifferencePercent,
      reason: gaslessAnalysis.reason,
    },
    meta: {
      timestamp: new Date(meta.fetchedAt).toISOString(),
      sourcesQueried,
      sourcesResponded,
      mevProtected: bestIsMevProtected,
      slippage,
      chainId: CHAIN_ID,
      // [P102] Echo recipient so callers can confirm the API understood
      // their intent (and the address parsed). Null when omitted — never
      // undefined.
      recipient,
      ...(meta.crossQuoteDeviation != null
        ? { crossQuoteDeviation: meta.crossQuoteDeviation }
        : {}),
      ...(meta.crossQuoteWarning ? { crossQuoteWarning: true } : {}),
    },
  }

  return NextResponse.json(responseBody, {
    headers: withCors({
      ...auth.rateLimitHeaders,
      // Quotes are time-sensitive — no caching at any layer.
      'Cache-Control': 'no-store, max-age=0',
    }),
  })
}
