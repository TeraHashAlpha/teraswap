import { NextResponse, type NextRequest } from 'next/server'
import { fetchMetaQuote, diagnoseQuoteSources } from '@/lib/api'
import { isValidAddress } from '@/lib/validation'
import { SequencerDownError } from '@/lib/chains/sequencer-check'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { isSystemHalted } from '@/lib/circuit-breaker'
import { verifyBearerToken } from '@/lib/auth'
import { DEFAULT_CHAIN_ID, getChainStatus } from '@/lib/chains'
import { withTimeout } from '@/lib/adapters/shared'

/**
 * [SPRINT-9X X2] Give the quote function the SAME 60s ceiling as /api/swap (9J/J2). Previously this
 * route exported NO maxDuration → it ran under the low Vercel plan default (10–15s). The parallel
 * source fan-out is bounded to QUOTE_TIMEOUT_MS (10s, slow sources are excluded — see fetchMetaQuote),
 * but with three pre-fan-out Upstash KV awaits the op could brush past that default ceiling, so the
 * PLATFORM killed the function and returned an HTML 504 — which the browser's res.json() can't parse
 * ("Unexpected token '<', \"<!DOCTYPE\"..."). 60s leaves the bounded ~10–13s op huge headroom so the
 * function always completes and returns JSON.
 */
export const maxDuration = 60

/**
 * [SPRINT-9X X2] Bound the pre-fan-out KV gates (halt check + rate-limit). They already fail OPEN on a
 * KV *error*, but had no timeout — a hung Upstash connection added unbounded wall-clock before any
 * source was contacted. Fail open on timeout too (quotes are read-only price info), so a slow KV can
 * never push the function past maxDuration.
 */
const KV_GATE_TIMEOUT_MS = 3_000

/**
 * Fail OPEN only when a KV gate TIMED OUT (a hung Upstash connection). A REAL thrown error is
 * re-thrown so the GET/POST try/catch still converts it to a JSON 500 — preserving the
 * INC-2026-05-31-001 "never escapes to HTML" contract (which the route integration tests pin).
 */
function onKvTimeout<T>(fallback: T) {
  return (e: unknown): T => {
    if (e instanceof Error && e.message === 'Timeout') return fallback
    throw e
  }
}

/**
 * Shared 503 response for when the circuit breaker has halted routing.
 * Returns Retry-After: 300 (5 min) so clients back off without hammering.
 */
function haltResponse(): NextResponse {
  return NextResponse.json(
    { error: 'System temporarily paused for safety. Please try again later.', halted: true },
    {
      status: 503,
      headers: { 'Retry-After': '300' },
    },
  )
}

/**
 * [INC-2026-05-31-001] Last-resort error envelope. ANY uncaught throw in a
 * handler — the halt check, rate-limit (Upstash), request parsing, or the
 * debug branch, all of which run OUTSIDE the inner fetchMetaQuote try/catch —
 * is converted to a JSON 500. /api/quote must NEVER return an HTML 502 again
 * (the browser can't JSON-parse it → "Unexpected token '<'").
 */
function jsonServerError(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : 'Unknown error'
  return NextResponse.json({ error: message }, { status: 500 })
}

/**
 * Server-side proxy for meta-quote requests.
 *
 * Running quotes server-side avoids browser CORS restrictions that
 * block direct calls to 1inch, Odos, 0x, Balancer and other DEX APIs.
 * KyberSwap and ParaSwap happen to allow browser CORS, but most do not.
 *
 * [INC-2026-05-31-001] GET/POST are thin wrappers that catch EVERYTHING so a
 * throw can never escape the handler; the real logic lives in the *Handler fns.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    return await handleQuoteGet(req)
  } catch (err) {
    return jsonServerError(err)
  }
}

async function handleQuoteGet(req: NextRequest): Promise<NextResponse> {
  // [H-03] Circuit breaker halt — short-circuit before rate limiting
  if (await withTimeout(isSystemHalted(), KV_GATE_TIMEOUT_MS).catch(onKvTimeout(false))) return haltResponse()

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rateCheck = await withTimeout(
    checkRateLimit(`quote:${ip}`, QUOTE_RATE_LIMIT.limit, QUOTE_RATE_LIMIT.windowMs),
    KV_GATE_TIMEOUT_MS,
  ).catch(onKvTimeout({ allowed: true, remaining: QUOTE_RATE_LIMIT.limit, resetAt: Date.now() + QUOTE_RATE_LIMIT.windowMs }))
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a minute.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }
  const { searchParams } = req.nextUrl
  const src = searchParams.get('src')
  const dst = searchParams.get('dst')
  const amount = searchParams.get('amount')
  const srcDecimals = Number(searchParams.get('srcDecimals') ?? '18')
  const dstDecimals = Number(searchParams.get('dstDecimals') ?? '18')
  const excludeParam = searchParams.get('exclude') // comma-separated source names to exclude
  // [P219 review] Optional target chain. Absent → fetchMetaQuote defaults to
  // mainnet, so existing (chainId-less) callers are unaffected.
  const chainIdParam = searchParams.get('chainId')

  if (!src || !dst || !amount) {
    return NextResponse.json(
      { error: 'Missing required params: src, dst, amount' },
      { status: 400 },
    )
  }

  // Q8: Validate address format
  if (!isValidAddress(src) || !isValidAddress(dst)) {
    return NextResponse.json({ error: 'Invalid token address format' }, { status: 400 })
  }

  // [SPRINT-9G G4] Quote stays multi-chain-OPEN (price info only — no executable
  // calldata or fee routing), so coming-soon chains may still be browsed. Reject
  // only a genuinely UNSUPPORTED chain so we never quote nonexistent-chain
  // liquidity. Absent chainId → mainnet default → unaffected.
  if (chainIdParam != null && getChainStatus(Number(chainIdParam)) === 'unsupported') {
    return NextResponse.json(
      { error: `Chain ${chainIdParam} is not supported`, code: 'CHAIN_UNSUPPORTED' },
      { status: 400 },
    )
  }

  // [diag] Admin-gated read-only per-source diagnostic. When `debug=sources` is
  // ABSENT the normal quote path below runs byte-identically — this branch is the
  // only behavioural change. Gated behind DEBUG_QUOTE_TOKEN (verifyBearerToken
  // fails closed when the env var is unset). Never alters quote/swap behaviour.
  if (searchParams.get('debug') === 'sources') {
    if (!verifyBearerToken(req.headers.get('authorization'), process.env.DEBUG_QUOTE_TOKEN ?? '')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const diagChainId = chainIdParam ? Number(chainIdParam) : DEFAULT_CHAIN_ID
    const diag = await diagnoseQuoteSources(src, dst, amount, srcDecimals, dstDecimals, diagChainId)
    // Time the REAL fetchMetaQuote on the same chain so a pipeline-level
    // failure/timeout is distinguishable from the per-source results above.
    const pipelineStart = Date.now()
    let pipeline: {
      totalMs: number
      status: 'ok' | 'error'
      quoteCount?: number
      bestSource?: string
      error?: string
    }
    try {
      const r = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, undefined, diagChainId)
      pipeline = { totalMs: Date.now() - pipelineStart, status: 'ok', quoteCount: r.all.length, bestSource: r.best.source }
    } catch (e) {
      pipeline = {
        totalMs: Date.now() - pipelineStart,
        status: 'error',
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      }
    }
    return NextResponse.json({ ...diag, pipeline }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  }

  try {
    const excludeSources = excludeParam ? excludeParam.split(',').map(s => s.trim()) : undefined
    const chainId = chainIdParam ? Number(chainIdParam) : undefined
    const result = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, excludeSources, chainId)

    // Serialize BigInt-safe (toAmount is already a string in NormalizedQuote)
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetAt),
      },
    })
  } catch (err) {
    // [E-2] L2 sequencer down/recovering — calm, typed 503 the client can
    // surface as "quotes paused" (vs a generic upstream failure).
    if (err instanceof SequencerDownError) {
      return NextResponse.json(
        { error: err.message, sequencerDown: true },
        { status: 503, headers: { 'Retry-After': '60' } },
      )
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

// Also support POST for larger payloads (future-proofing)
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handleQuotePost(req)
  } catch (err) {
    return jsonServerError(err)
  }
}

async function handleQuotePost(req: NextRequest): Promise<NextResponse> {
  // [H-03] Circuit breaker halt — short-circuit before rate limiting
  if (await withTimeout(isSystemHalted(), KV_GATE_TIMEOUT_MS).catch(onKvTimeout(false))) return haltResponse()

  const postIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const postRateCheck = await withTimeout(
    checkRateLimit(`quote:${postIp}`, QUOTE_RATE_LIMIT.limit, QUOTE_RATE_LIMIT.windowMs),
    KV_GATE_TIMEOUT_MS,
  ).catch(onKvTimeout({ allowed: true, remaining: QUOTE_RATE_LIMIT.limit, resetAt: Date.now() + QUOTE_RATE_LIMIT.windowMs }))
  if (!postRateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(postRateCheck.resetAt),
        },
      },
    )
  }
  try {
    const body = await req.json()
    const { src, dst, amount, srcDecimals = 18, dstDecimals = 18, chainId: chainIdRaw } = body
    // [E2-AUDIT L] Coerce ONCE at the boundary (mirrors GET): a STRING chainId
    // from the JSON body ("1"/"8453") would defeat fetchMetaQuote's strict
    // mainnet short-circuit ("1" !== 1) and leak a string into the adapters.
    const chainId = chainIdRaw != null && chainIdRaw !== '' ? Number(chainIdRaw) : undefined
    if (chainIdRaw != null && chainIdRaw !== '' && !Number.isInteger(chainId)) {
      return NextResponse.json({ error: `Invalid chainId: ${String(chainIdRaw)}` }, { status: 400 })
    }

    if (!src || !dst || !amount) {
      return NextResponse.json(
        { error: 'Missing required fields: src, dst, amount' },
        { status: 400 },
      )
    }

    // API-HIGH-05: Validate addresses in POST (was missing)
    if (!isValidAddress(src) || !isValidAddress(dst)) {
      return NextResponse.json({ error: 'Invalid token address format' }, { status: 400 })
    }

    // [SPRINT-9G G4] Reject an unsupported chain (parity with GET); supported
    // coming-soon chains stay open for browsing.
    if (chainId != null && getChainStatus(Number(chainId)) === 'unsupported') {
      return NextResponse.json(
        { error: `Chain ${chainId} is not supported`, code: 'CHAIN_UNSUPPORTED' },
        { status: 400 },
      )
    }

    const result = await fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, undefined, chainId)

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-RateLimit-Remaining': String(postRateCheck.remaining),
        'X-RateLimit-Reset': String(postRateCheck.resetAt),
      },
    })
  } catch (err) {
    // [E-2] L2 sequencer down/recovering — calm, typed 503 the client can
    // surface as "quotes paused" (vs a generic upstream failure).
    if (err instanceof SequencerDownError) {
      return NextResponse.json(
        { error: err.message, sequencerDown: true },
        { status: 503, headers: { 'Retry-After': '60' } },
      )
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
