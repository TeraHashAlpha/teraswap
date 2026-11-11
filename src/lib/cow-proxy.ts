/**
 * [fix/user-ip-privacy A76 S-1] Server side of the same-origin CoW Protocol relay: /api/cow/{quote,orders,
 * order-status,trades}.
 *
 * WHY. Quotes and swap builds already ran on our server (/api/quote, /api/swap), but three CoW calls were made BY
 * THE BROWSER: after the visitor signed a CoW order, `submitCowOrder` POSTed it to api.cow.fi and
 * `pollCowOrderStatus` polled its status and trades there; the limit-order panel read its market price from
 * api.cow.fi too. CoW saw the visitor's IP on every one of them — and with the CSP's `connect-src` cut to 'self'
 * they failed outright ("Failed to fetch"). The browser now calls these routes and only our server talks to CoW.
 *
 * WHAT IS FORWARDED. Never the visitor's request as such: each route rebuilds the upstream request from an
 * allow-list — the pair params of a price quote, the fields of a signed order, an order uid — after checking the
 * shape of every field. Anything else in the body is dropped. The upstream request carries no header of the
 * visitor's (no Cookie, Origin, Referer, User-Agent, X-Forwarded-For / CF-Connecting-IP): only Accept and, with a
 * body, Content-Type.
 *
 * BOUNDS. 10 s per upstream call (AbortSignal.timeout — it also covers reading the body), 1 MB response cap (read
 * incrementally, read-body-capped.ts), redirects refused, per-route rate limits (kv-rate-limiter.ts
 * COW_PROXY_RATE_LIMITS, keyed by the HMAC of the client IP, bounded at 1 s).
 *
 * ERRORS. Never an upstream URL, never a fetch/abort message: a network failure or timeout is a fixed sentence; a
 * CoW 4xx keeps its status and only CoW's own `errorType` / `description` strings (≤ 300 chars, any URL in them
 * replaced), which is what the client turns into the user-facing message; a CoW 5xx becomes 502.
 *
 * Server-only: imported by the /api/cow route handlers, never by client code (the browser side is
 * cow-proxy-paths.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getCowApiBase, hasCowApi } from '@/lib/constants'
import { getSupportedChainIds } from '@/lib/chains/registry'
import { readJsonCapped } from '@/lib/read-body-capped'
import { checkRateLimitWithin, COW_PROXY_RATE_LIMITS } from '@/lib/kv-rate-limiter'
import { clientIpKey } from '@/lib/client-ip-key'

/** Per upstream call, connection to last byte. */
export const COW_PROXY_TIMEOUT_MS = 10_000
/** Largest upstream answer relayed. A CoW order or trade list is a few KB. */
export const COW_PROXY_MAX_RESPONSE_BYTES = 1_048_576
/** Largest request body accepted from the browser (a signed order with its appData JSON is ~1–2 KB). */
export const COW_PROXY_MAX_BODY_BYTES = 16_384

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const UINT_RE = /^\d{1,78}$/
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/
/** A CoW order uid: 32-byte order digest + 20-byte owner + 4-byte validTo. */
export const ORDER_UID_RE = /^0x[0-9a-fA-F]{112}$/
/** An ECDSA signature (r, s, v): the only scheme the app signs with (EIP-712). */
const ECDSA_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/
const MAX_APP_DATA_CHARS = 8_192
const MAX_ERROR_TEXT_CHARS = 300
const NO_STORE = { 'Cache-Control': 'no-store' } as const

export type CowProxyRoute = keyof typeof COW_PROXY_RATE_LIMITS

type Picked<T> = { ok: true; value: T } | { ok: false; error: string }

/** `?chainId=` → a chain that is in the registry AND has its own CoW orderbook; null otherwise. */
export function resolveCowChainId(raw: string | null): number | null {
  if (raw === null || !/^\d{1,10}$/.test(raw)) return null
  const chainId = Number(raw)
  return getSupportedChainIds().includes(chainId) && hasCowApi(chainId) ? chainId : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── Allow-lists ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface CowPriceQuoteParams {
  sellToken: string
  buyToken: string
  sellAmountBeforeFee: string
}

/** /api/cow/quote: the pair and the amount. Nothing else from the browser reaches CoW. */
export function pickPriceQuoteParams(body: unknown): Picked<CowPriceQuoteParams> {
  if (!isRecord(body)) return { ok: false, error: 'body' }
  const { sellToken, buyToken, sellAmountBeforeFee } = body
  if (typeof sellToken !== 'string' || !ADDRESS_RE.test(sellToken)) return { ok: false, error: 'sellToken' }
  if (typeof buyToken !== 'string' || !ADDRESS_RE.test(buyToken)) return { ok: false, error: 'buyToken' }
  if (typeof sellAmountBeforeFee !== 'string' || !UINT_RE.test(sellAmountBeforeFee) || /^0+$/.test(sellAmountBeforeFee)) {
    return { ok: false, error: 'sellAmountBeforeFee' }
  }
  return { ok: true, value: { sellToken, buyToken, sellAmountBeforeFee } }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * The /quote body for a PRICE read — byte-for-byte what limit-order-api.ts `fetchCurrentPrice` used to send from
 * the browser: a sell quote from the zero address with an empty TeraSwap appData. It is built here, so the only
 * caller-chosen values are the three picked above.
 */
export function buildPriceQuoteBody(p: CowPriceQuoteParams): Record<string, unknown> {
  return {
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    sellAmountBeforeFee: p.sellAmountBeforeFee,
    kind: 'sell',
    from: ZERO_ADDRESS,
    receiver: ZERO_ADDRESS,
    appData: JSON.stringify({ appCode: 'TeraSwap', metadata: {} }),
    appDataHash: ZERO_HASH,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    signingScheme: 'eip712',
  }
}

/**
 * /api/cow/orders POST: the fields of a signed GPv2 order, in the order adapters/cow.ts `submitCowOrder` sends
 * them. Every field is type- and shape-checked; an unknown field is dropped, a missing or malformed one is a 400.
 * `appDataHash` and `quoteId` are optional (a limit order has no quote id).
 */
export function pickSignedOrder(body: unknown): Picked<Record<string, unknown>> {
  if (!isRecord(body)) return { ok: false, error: 'body' }
  const b = body
  const out: Record<string, unknown> = {}
  const address = (k: string) => typeof b[k] === 'string' && ADDRESS_RE.test(b[k] as string)
  const uint = (k: string) => typeof b[k] === 'string' && UINT_RE.test(b[k] as string)

  for (const k of ['sellToken', 'buyToken']) {
    if (!address(k)) return { ok: false, error: k }
    out[k] = b[k]
  }
  for (const k of ['sellAmount', 'buyAmount']) {
    if (!uint(k)) return { ok: false, error: k }
    out[k] = b[k]
  }
  if (typeof b.validTo !== 'number' || !Number.isInteger(b.validTo) || b.validTo <= 0 || b.validTo > 0xffffffff) {
    return { ok: false, error: 'validTo' }
  }
  out.validTo = b.validTo
  if (typeof b.appData !== 'string' || b.appData.length === 0 || b.appData.length > MAX_APP_DATA_CHARS) {
    return { ok: false, error: 'appData' }
  }
  out.appData = b.appData
  if (b.appDataHash !== undefined) {
    if (typeof b.appDataHash !== 'string' || !HEX32_RE.test(b.appDataHash)) return { ok: false, error: 'appDataHash' }
    out.appDataHash = b.appDataHash
  }
  if (!uint('feeAmount')) return { ok: false, error: 'feeAmount' }
  out.feeAmount = b.feeAmount
  if (b.kind !== 'sell' && b.kind !== 'buy') return { ok: false, error: 'kind' }
  out.kind = b.kind
  if (typeof b.partiallyFillable !== 'boolean') return { ok: false, error: 'partiallyFillable' }
  out.partiallyFillable = b.partiallyFillable
  if (!address('receiver')) return { ok: false, error: 'receiver' }
  out.receiver = b.receiver
  if (b.sellTokenBalance !== 'erc20' && b.sellTokenBalance !== 'external' && b.sellTokenBalance !== 'internal') {
    return { ok: false, error: 'sellTokenBalance' }
  }
  out.sellTokenBalance = b.sellTokenBalance
  if (b.buyTokenBalance !== 'erc20' && b.buyTokenBalance !== 'internal') return { ok: false, error: 'buyTokenBalance' }
  out.buyTokenBalance = b.buyTokenBalance
  if (b.signingScheme !== 'eip712') return { ok: false, error: 'signingScheme' }
  out.signingScheme = b.signingScheme
  if (typeof b.signature !== 'string' || !ECDSA_SIGNATURE_RE.test(b.signature)) return { ok: false, error: 'signature' }
  out.signature = b.signature
  if (!address('from')) return { ok: false, error: 'from' }
  out.from = b.from
  if (b.quoteId !== undefined && b.quoteId !== null) {
    if (typeof b.quoteId !== 'number' || !Number.isSafeInteger(b.quoteId) || b.quoteId < 0) return { ok: false, error: 'quoteId' }
    out.quoteId = b.quoteId
  }
  return { ok: true, value: out }
}

/**
 * /api/cow/orders DELETE (limit-order-api.ts `cancelLimitOrder`): the signed cancellation of ONE order, forwarded
 * as the body that function always sent — `{ signature, signingScheme, orderUids: [uid] }` — and nothing else.
 */
export function pickCancellation(uid: string | null, body: unknown): Picked<{ uid: string; body: Record<string, unknown> }> {
  if (uid === null || !ORDER_UID_RE.test(uid)) return { ok: false, error: 'uid' }
  if (!isRecord(body)) return { ok: false, error: 'body' }
  if (typeof body.signature !== 'string' || !ECDSA_SIGNATURE_RE.test(body.signature)) return { ok: false, error: 'signature' }
  if (body.signingScheme !== 'eip712') return { ok: false, error: 'signingScheme' }
  const uids = body.orderUids
  if (uids !== undefined && !(Array.isArray(uids) && uids.length === 1 && uids[0] === uid)) return { ok: false, error: 'orderUids' }
  return { ok: true, value: { uid, body: { signature: body.signature, signingScheme: 'eip712', orderUids: [uid] } } }
}

// ── Upstream call ────────────────────────────────────────────────────────────────────────────────────────────────

export interface CowRelayResult {
  status: number
  json: unknown
}

/** CoW's own error strings, each capped and with any URL replaced. Nothing else of an error body is relayed. */
export function sanitizeCowError(raw: unknown): { errorType?: string; description?: string } {
  const clean = (v: unknown) =>
    typeof v === 'string' ? v.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, MAX_ERROR_TEXT_CHARS) : undefined
  if (!isRecord(raw)) return {}
  const out: { errorType?: string; description?: string } = {}
  const errorType = clean(raw.errorType)
  const description = clean(raw.description)
  if (errorType !== undefined) out.errorType = errorType
  if (description !== undefined) out.description = description
  return out
}

const UNAVAILABLE = { errorType: 'UpstreamUnavailable', description: 'CoW Protocol could not be reached' }
const TIMED_OUT = { errorType: 'UpstreamTimeout', description: 'CoW Protocol did not answer in time' }
const TOO_LARGE = { errorType: 'UpstreamResponseTooLarge', description: 'CoW Protocol answered with more data than this relay accepts' }
const INVALID = { errorType: 'UpstreamInvalidResponse', description: 'CoW Protocol answered with something that is not JSON' }

function isTimeout(e: unknown): boolean {
  return typeof e === 'object' && e !== null && ((e as { name?: unknown }).name === 'TimeoutError' || (e as { name?: unknown }).name === 'AbortError')
}

/**
 * One call to CoW's orderbook for `chainId`. `path` is built by the route from validated values only (a fixed
 * segment plus, at most, a checked order uid). Never throws.
 */
export async function relayToCow(req: {
  chainId: number
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}): Promise<CowRelayResult> {
  const url = `${getCowApiBase(req.chainId)}${req.path}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (req.body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(url, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(COW_PROXY_TIMEOUT_MS),
      redirect: 'error',
      cache: 'no-store',
    })
    const read = await readJsonCapped(res, COW_PROXY_MAX_RESPONSE_BYTES)
    if (!read.ok && read.reason === 'too_large') return { status: 502, json: TOO_LARGE }
    if (res.ok) return read.ok ? { status: res.status, json: read.json } : { status: 502, json: INVALID }
    const status = res.status >= 500 ? 502 : res.status
    return { status, json: read.ok ? sanitizeCowError(read.json) : {} }
  } catch (e) {
    return isTimeout(e) ? { status: 504, json: TIMED_OUT } : { status: 502, json: UNAVAILABLE }
  }
}

// ── Route plumbing ───────────────────────────────────────────────────────────────────────────────────────────────

/** A relay result as the route's answer (no upstream header is copied). */
export function cowJson(result: CowRelayResult): NextResponse {
  return NextResponse.json(result.json, { status: result.status, headers: NO_STORE })
}

/** 400 naming the field that failed — a name from the allow-list, never caller input. */
export function cowBadRequest(field: string): NextResponse {
  return NextResponse.json({ errorType: 'InvalidRequest', description: `Invalid ${field}` }, { status: 400, headers: NO_STORE })
}

/** 500 for anything unexpected in a handler: a fixed sentence (the INC-2026-05-31-001 "always JSON" contract). */
export function cowInternalError(): NextResponse {
  return NextResponse.json({ errorType: 'InternalError', description: 'CoW relay error' }, { status: 500, headers: NO_STORE })
}

/** Per-route, per-client limit (HMAC of the trusted client IP). Returns the 429 to send, or null to proceed. */
export async function cowRateLimitGate(req: NextRequest, route: CowProxyRoute): Promise<NextResponse | null> {
  const { limit, windowMs } = COW_PROXY_RATE_LIMITS[route]
  const check = await checkRateLimitWithin(`cow-${route}:${clientIpKey(req)}`, limit, windowMs)
  if (check.allowed) return null
  return NextResponse.json(
    { errorType: 'RateLimited', description: 'Too many requests. Try again in a minute.' },
    { status: 429, headers: { ...NO_STORE, 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(check.resetAt) } },
  )
}

/** The request body as JSON, or undefined when it does not parse. */
export async function readRequestJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}
