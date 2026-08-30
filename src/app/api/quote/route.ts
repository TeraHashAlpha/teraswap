import { NextResponse, type NextRequest } from 'next/server'
import { bodySizeGuard } from '@/lib/body-limit'
import { fetchMetaQuote, diagnoseQuoteSources, type MetaQuoteResult } from '@/lib/api'
import { isValidAddress } from '@/lib/validation'
import { SequencerDownError } from '@/lib/chains/sequencer-check'
import { checkRateLimit, QUOTE_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { isSystemHalted } from '@/lib/circuit-breaker'
import { verifyBearerToken } from '@/lib/auth'
import { DEFAULT_CHAIN_ID, getChainStatus } from '@/lib/chains'
import { withTimeout } from '@/lib/adapters/shared'
import { trustedClientIp } from '@/lib/trusted-ip'
import { kv } from '@/lib/kv'

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
 * [feat/quote-before-wallet] Server-side quote cache, shared across every visitor via Upstash
 * (not per-instance memory — Fluid Compute reuses instances, but a shared KV is what actually
 * guarantees "N visitors, 1 upstream call" regardless of which instance serves which request).
 *
 * TTL chosen just under QUOTE_REFRESH_MS (15s, src/lib/constants.ts) — the client's own poll
 * cadence — so a cache hit is never staler than what an already-open tab would show anyway on
 * its own next tick. Keyed on the full request signature (chain + pair + amount + decimals +
 * excludes), so it transparently collapses whichever query is currently hottest — in practice
 * the landing page's fixed 0.5 ETH -> USDC default pair (by far the highest-traffic identical
 * query, hit by every anonymous visitor), while distinct real-trade amounts mostly miss and fall
 * through to a live fetch exactly as before. Fails open on any Redis error/timeout (same
 * pattern as the halt/rate-limit gates above) — a cache outage degrades to "no caching", never
 * to a broken quote.
 */
const QUOTE_CACHE_TTL_SECONDS = 12

function quoteCacheKey(
  src: string,
  dst: string,
  amount: string,
  srcDecimals: number,
  dstDecimals: number,
  excludeSources: string[] | undefined,
  chainId: number | undefined,
): string {
  const chain = chainId ?? DEFAULT_CHAIN_ID
  const exclude = excludeSources && excludeSources.length > 0 ? [...excludeSources].sort().join(',') : ''
  return `quote:cache:v1:${chain}:${src.toLowerCase()}:${dst.toLowerCase()}:${amount}:${srcDecimals}:${dstDecimals}:${exclude}`
}

async function getCachedQuote(key: string): Promise<MetaQuoteResult | null> {
  try {
    return await withTimeout(kv.get<MetaQuoteResult>(key), KV_GATE_TIMEOUT_MS)
  } catch {
    return null
  }
}

async function setCachedQuote(key: string, value: MetaQuoteResult): Promise<void> {
  try {
    await withTimeout(kv.set(key, value, { ex: QUOTE_CACHE_TTL_SECONDS }), KV_GATE_TIMEOUT_MS)
  } catch {
    // Best-effort — a cache-write failure must never fail the request.
  }
}

/**
 * [feat/quote-before-wallet — second-level dampener] COST DAMPENING, not a security cap and NOT a
 * rate limit. Both the KV rate limit above and the KV quote cache share one dependency (Upstash):
 * a single Redis outage removes both brakes at once, and every visitor's request now goes straight
 * upstream (this route no longer requires a connected wallet, and the landing widget quotes on
 * every page load). This is what's left standing when that happens — process-local, in-memory,
 * with NONE of Upstash's guarantees:
 *
 *   - Per-INSTANCE only. Fluid Compute reuses instances, so a warm instance dampens its own
 *     repeat traffic, but there is no coordination across instances the way KV coordinates across
 *     every visitor. N instances still means up to N upstream calls for the same query.
 *   - Resets on cold start / restart. No persistence, no guarantee of any kind.
 *   - It must never be read as "the rate limit" — QUOTE_RATE_LIMIT (kv-rate-limiter.ts, 30/60s per
 *     IP) is the only per-identity abuse control and is completely untouched by this. This dampens
 *     REDUNDANT upstream fan-out for the same query shape, from any IP, only while Upstash is down.
 *
 * Two mechanisms, in order, exactly as the task frames it — collapsing concurrent duplicates is
 * worth more than any counter:
 *
 *   1. In-flight coalescing (the primary mechanism): N concurrent requests for the identical
 *      cache key that arrive while one is already fetching share that ONE upstream call instead of
 *      firing N. This is what catches the landing page's fixed default-pair quote being hit by a
 *      burst of simultaneous anonymous visitors during a KV outage.
 *   2. A short local result cache, for requests that are sequential rather than concurrent.
 *      DAMPENER_TTL_MS (5s) is deliberately LESS than QUOTE_CACHE_TTL_SECONDS (12s) so this can
 *      never be the reason a visitor sees a quote staler than the KV cache would have already
 *      allowed — it only narrows the window, never widens it. 5s is also well under
 *      QUOTE_REFRESH_MS (15s, the client's own poll cadence in src/lib/constants.ts), so any
 *      staleness this introduces during an outage is smaller than what a single open tab already
 *      tolerates between its own ticks.
 *
 * Both structures are only ever consulted AFTER a KV cache miss/error (see handleQuoteGet below),
 * so when Upstash is healthy this never runs — the KV cache stays the one and only primary path,
 * unchanged.
 */
const DAMPENER_TTL_MS = 5_000

const inFlightQuotes = new Map<string, Promise<MetaQuoteResult>>()
const localQuoteDampenerCache = new Map<string, { value: MetaQuoteResult; expiresAt: number }>()

async function getOrFetchDampened(
  key: string,
  fetcher: () => Promise<MetaQuoteResult>,
): Promise<{ result: MetaQuoteResult; source: 'local-cache' | 'coalesced' | 'fresh' }> {
  const local = localQuoteDampenerCache.get(key)
  if (local && local.expiresAt > Date.now()) {
    return { result: local.value, source: 'local-cache' }
  }

  const existing = inFlightQuotes.get(key)
  if (existing) {
    return { result: await existing, source: 'coalesced' }
  }

  // Synchronous check-then-set above, no `await` in between — this is the single-threaded JS
  // event loop, so no other call to this function can interleave and race the leader role here.
  const promise = fetcher()
  inFlightQuotes.set(key, promise)
  try {
    const result = await promise
    localQuoteDampenerCache.set(key, { value: result, expiresAt: Date.now() + DAMPENER_TTL_MS })
    return { result, source: 'fresh' }
  } finally {
    inFlightQuotes.delete(key)
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

  // [CHORE-API-HARDENING-2 / P3a] Trusted IP — the left-most x-forwarded-for
  // token is attacker-controlled on Vercel and defeats this limit; see trusted-ip.ts.
  const ip = trustedClientIp(req)
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

    // [feat/quote-before-wallet] Shared server-side cache — see QUOTE_CACHE_TTL_SECONDS above.
    const cacheKey = quoteCacheKey(src, dst, amount, srcDecimals, dstDecimals, excludeSources, chainId)
    const cached = await getCachedQuote(cacheKey)

    let result: MetaQuoteResult
    let cacheHeader: string
    if (cached) {
      result = cached
      cacheHeader = 'hit'
    } else {
      // [feat/quote-before-wallet] KV cache missed (or Upstash is down) — fall through to the
      // process-local dampener (coalescing + short local cache) before hitting upstream.
      const dampened = await getOrFetchDampened(
        cacheKey,
        () => fetchMetaQuote(src, dst, amount, srcDecimals, dstDecimals, excludeSources, chainId),
      )
      result = dampened.result
      cacheHeader = dampened.source === 'fresh' ? 'miss' : `miss-dampened-${dampened.source}`
      // Only the leader of a fresh fetch writes through to KV — a coalesced/local-cache hit
      // already holds a value that either came from (or was just written to) KV moments ago.
      if (dampened.source === 'fresh') await setCachedQuote(cacheKey, result)
    }

    // Serialize BigInt-safe (toAmount is already a string in NormalizedQuote)
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-Quote-Cache': cacheHeader,
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
    // [AUDIT-W6 / W6-L-01] Oversized body -> 413 before any other work.
    const tooLarge = bodySizeGuard(req)
    if (tooLarge) return tooLarge
    return await handleQuotePost(req)
  } catch (err) {
    return jsonServerError(err)
  }
}

async function handleQuotePost(req: NextRequest): Promise<NextResponse> {
  // [H-03] Circuit breaker halt — short-circuit before rate limiting
  if (await withTimeout(isSystemHalted(), KV_GATE_TIMEOUT_MS).catch(onKvTimeout(false))) return haltResponse()

  const postIp = trustedClientIp(req)
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
