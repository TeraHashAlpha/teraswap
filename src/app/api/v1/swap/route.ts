/**
 * [LP-10] POST /api/v1/swap — public, versioned swap-data endpoint.
 *
 * Companion to /api/v1/quote (P79/LP-09). After the caller picks a
 * route from a v1/quote response, they POST here to receive UNSIGNED
 * transaction data (`to`, `data`, `value`, `gasEstimate`) that they
 * sign and broadcast themselves. We never sign or broadcast on the
 * caller's behalf — this endpoint is a builder, not an executor.
 *
 * Routing model — every successful response targets FeeCollector V2:
 *   - We fetch swap data from the chosen adapter at the NET amount
 *     (amount − 0.1% fee), then wrap the adapter's tx.data inside a
 *     swapETHWithFee / swapTokenWithFee call to FEE_COLLECTOR_ADDRESS.
 *   - The on-chain InsufficientOutput revert added in H-04 fires when
 *     the user's actual balance delta is below `minimumOutput`, which
 *     we derive from the quoted output and the caller's slippage.
 *   - Adapters in FEE_INCOMPATIBLE_SOURCES (0x, CoW) cannot route via
 *     FeeCollector. The spec mandates fee collection on every API swap,
 *     so we reject those two sources with a clear 400; auto-source
 *     selection skips them in the meta-quote pick.
 *
 * The frontend's /api/swap stays unchanged — it has IP-rate-limited
 * no-auth shape for in-app use. v1 is per-key authenticated, CORS-open
 * for third-party consumers, and rate-limited on the tier the API key
 * was issued at.
 *
 * @internal — Next.js route handler. Public surface starts at the request boundary.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { encodeFunctionData } from 'viem'
import {
  fetchMetaQuote,
  fetchSwapFromSource,
  usesFeeCollector,
  validateRouterAddress,
  type NormalizedQuote,
} from '@/lib/api'
import { verifyApiKey } from '@/lib/api-auth'
import { isSystemHalted } from '@/lib/circuit-breaker'
import { isValidAddress } from '@/lib/validation'
import { safeBigInt } from '@/lib/utils'
import {
  AGGREGATOR_META,
  CHAIN_ID,
  FEE_COLLECTOR_ADDRESS,
  FEE_COLLECTOR_ABI,
  FEE_BPS,
  FEE_INCOMPATIBLE_SOURCES,
  NATIVE_ETH,
  type AggregatorName,
} from '@/lib/constants'

export const dynamic = 'force-dynamic'

// ── CORS ──────────────────────────────────────────────────
//
// v1 is a public API: browser-origin callers (dashboards, bots, the
// upcoming Telegram bot in S14) must be able to POST here from any
// origin. Mirrors the CORS posture of /api/v1/quote.

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'X-API-Key, Content-Type',
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
  return NextResponse.json({ error: message }, { status, headers: withCors(extraHeaders) })
}

// ── OPTIONS preflight ────────────────────────────────────

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: withCors() })
}

// ── Helpers ───────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

function isNativeEthAddress(addr: string): boolean {
  return addr.toLowerCase() === NATIVE_ETH.toLowerCase()
}

/**
 * Known adapter names. Built from AGGREGATOR_META at module load so we
 * don't fall out of sync if a new adapter is registered.
 */
const KNOWN_SOURCES = new Set<string>(Object.keys(AGGREGATOR_META))

function isKnownSource(s: string): s is AggregatorName {
  return KNOWN_SOURCES.has(s)
}

/**
 * Compute the slippage-adjusted minimum output (raw wei).
 *
 * Matches the formula used by the frontend's useSwap.ts so a swap data
 * blob built here is byte-for-byte equivalent to one built in-app:
 *   minimumOutput = quotedOutput × (10000 − slippageBps) / 10000
 *
 * Returns 0n when slippage >= 100% (which disables the on-chain check),
 * preserving the "0 = disabled" backward-compat semantics from H-04.
 */
function computeMinimumOutput(quotedOutputWei: bigint, slippagePercent: number): bigint {
  const slippageBps = BigInt(Math.max(0, Math.round(slippagePercent * 100)))
  if (slippageBps >= 10_000n) return 0n
  return (quotedOutputWei * (10_000n - slippageBps)) / 10_000n
}

// ── Body shape ────────────────────────────────────────────

interface SwapRequestBody {
  tokenIn?: unknown
  tokenOut?: unknown
  amount?: unknown
  slippage?: unknown
  sender?: unknown
  source?: unknown
}

interface ParsedSwapRequest {
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  amount: bigint
  amountStr: string
  slippage: number
  sender: `0x${string}`
  /** Caller-pinned source, or null when we should auto-select via meta-quote. */
  source: AggregatorName | null
}

/**
 * Parse + validate the POST body. Returns a typed request on success or
 * a NextResponse with a 400 explaining the first failure. We bail at
 * the first error rather than aggregating — clients fix one field at a
 * time anyway, and a single message is easier to surface.
 */
function parseBody(raw: SwapRequestBody): ParsedSwapRequest | NextResponse {
  const { tokenIn, tokenOut, amount, slippage, sender, source } = raw

  if (typeof tokenIn !== 'string' || typeof tokenOut !== 'string' || typeof amount !== 'string' || typeof sender !== 'string') {
    return jsonError(400, 'Missing required fields: tokenIn, tokenOut, amount, sender.')
  }
  if (!isValidAddress(tokenIn) || !isValidAddress(tokenOut) || !isValidAddress(sender)) {
    return jsonError(400, 'tokenIn, tokenOut, and sender must be valid 0x-prefixed 20-byte addresses.')
  }
  // [10-L-01] safeBigInt rejects undefined/''/'NaN'/'0x123'/'1.5'/etc.
  // without throwing — defends against the BigInt SyntaxError class.
  const amountBn = safeBigInt(amount)
  if (amountBn === null || amountBn <= 0n) {
    return jsonError(400, 'amount must be a positive decimal-integer string (raw wei).')
  }

  let slippagePct = 0.5
  if (slippage !== undefined && slippage !== null) {
    const parsed = typeof slippage === 'number' ? slippage : Number(slippage)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) {
      return jsonError(400, 'slippage must be a number between 0 and 50.')
    }
    slippagePct = parsed
  }

  let pinned: AggregatorName | null = null
  if (source !== undefined && source !== null && source !== '') {
    if (typeof source !== 'string' || !isKnownSource(source)) {
      return jsonError(400, `source must be one of: ${[...KNOWN_SOURCES].join(', ')}`)
    }
    // FEE_INCOMPATIBLE_SOURCES cannot route through FeeCollector V2, and
    // every v1 swap is required to collect the protocol fee. Surface the
    // reason explicitly rather than silently picking a different source.
    if (FEE_INCOMPATIBLE_SOURCES.includes(source)) {
      return jsonError(
        400,
        `source '${source}' is not supported on /v1/swap because it cannot route through FeeCollector. ` +
          `Use /v1/quote to discover a fee-collectable source.`,
      )
    }
    pinned = source
  }

  return {
    tokenIn: tokenIn as `0x${string}`,
    tokenOut: tokenOut as `0x${string}`,
    amount: amountBn,
    amountStr: amount,
    slippage: slippagePct,
    sender: sender as `0x${string}`,
    source: pinned,
  }
}

// ── Source selection ──────────────────────────────────────

/**
 * When the caller didn't pin a source, run the meta-quote engine and
 * pick the best fee-collectable result. FEE_INCOMPATIBLE sources (0x,
 * CoW) are filtered out — see header comment for the why.
 */
async function autoSelectSource(
  tokenIn: string,
  tokenOut: string,
  amountWei: string,
): Promise<{ source: AggregatorName; quotedOutput: bigint } | NextResponse> {
  let meta
  try {
    meta = await fetchMetaQuote(tokenIn, tokenOut, amountWei)
  } catch (err) {
    // [11-M-02] Internal message stays in server logs only — wire
    // surface is generic to avoid leaking limiter / adapter details.
    const internalMessage = err instanceof Error ? err.message : 'meta-quote failed'
    console.error('[v1/swap] autoSelectSource meta-quote failed:', internalMessage)
    if (/rate.limit/i.test(internalMessage)) return jsonError(429, 'Rate limit exceeded. Please retry.')
    return jsonError(502, 'Upstream service error. Please retry.')
  }

  const candidate = meta.all.find(q => !FEE_INCOMPATIBLE_SOURCES.includes(q.source))
  if (!candidate) {
    // [11-M-02] Hardcoded message referenced fee-collectable routing,
    // which leaks internal architecture. The generic 502 mirrors the
    // adapter-error fall-through so a caller can't distinguish "no
    // source quoted" from "an adapter threw".
    console.error('[v1/swap] autoSelectSource: no fee-collectable source in meta-quote response')
    return jsonError(502, 'Upstream service error. Please retry.')
  }
  const quotedOutput = safeBigInt(candidate.toAmount)
  if (quotedOutput === null) {
    console.error('[v1/swap] autoSelectSource: candidate returned non-numeric toAmount')
    return jsonError(502, 'Upstream service error. Please retry.')
  }
  return { source: candidate.source, quotedOutput }
}

// ── FeeCollector calldata wrapping ────────────────────────

/**
 * Wrap an adapter's swap-data in a FeeCollector V2 call.
 *
 * Returns the final tx to send AND the metadata the response surfaces
 * (router address, minimumOutput). The frontend's useSwap.ts builds the
 * exact same calldata; if you find a divergence between the two, the
 * frontend is the source of truth and this function is the bug.
 */
function buildFeeCollectorTx(args: {
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  amountTotal: bigint
  swapData: NormalizedQuote
  slippagePct: number
}): { to: `0x${string}`; data: `0x${string}`; value: string; minimumOutput: bigint; quotedOutput: bigint } {
  if (!args.swapData.tx) {
    throw new Error('Adapter did not return tx data (cannot wrap in FeeCollector call).')
  }

  const router = args.swapData.tx.to
  const routerData = args.swapData.tx.data
  // [N-05 / R1] Validate router is whitelisted. Same defense layer the
  // frontend applies pre-encode in useSwap.ts.
  const routerCheck = validateRouterAddress(router, args.swapData.source)
  if (!routerCheck.valid) {
    throw new Error(`Router not whitelisted: ${routerCheck.reason ?? 'unknown reason'}`)
  }

  // [11-M-04] Adapter-returned toAmount comes from external HTTP — defend
  // with safeBigInt so a malformed payload yields a 502 via the wrapping
  // try/catch instead of an uncaught BigInt SyntaxError.
  const quotedOutput = safeBigInt(args.swapData.toAmount)
  if (quotedOutput === null) {
    throw new Error('Adapter returned non-numeric toAmount.')
  }
  const minimumOutput = computeMinimumOutput(quotedOutput, args.slippagePct)

  const tokenOutForFc: `0x${string}` = isNativeEthAddress(args.tokenOut)
    ? ZERO_ADDRESS
    : args.tokenOut

  const isNativeIn = isNativeEthAddress(args.tokenIn)
  let data: `0x${string}`
  let value: string
  if (isNativeIn) {
    data = encodeFunctionData({
      abi: FEE_COLLECTOR_ABI,
      functionName: 'swapETHWithFee',
      args: [router, routerData, tokenOutForFc, minimumOutput],
    })
    // Caller sends the full pre-fee amount as msg.value; FeeCollector
    // deducts the 0.1% fee and forwards the net to the router.
    value = args.amountTotal.toString()
  } else {
    data = encodeFunctionData({
      abi: FEE_COLLECTOR_ABI,
      functionName: 'swapTokenWithFee',
      args: [
        args.tokenIn,
        args.amountTotal,
        router,
        routerData,
        tokenOutForFc,
        minimumOutput,
      ],
    })
    value = '0'
  }

  return {
    to: FEE_COLLECTOR_ADDRESS as `0x${string}`,
    data,
    value,
    minimumOutput,
    quotedOutput,
  }
}

// ── POST ──────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Halt — short-circuits before any auth/RPC work.
  if (await isSystemHalted()) {
    return jsonError(
      503,
      'System temporarily paused for safety. Please try again later.',
      { 'Retry-After': '300' },
    )
  }

  // 2. Auth + per-key rate limit.
  const auth = await verifyApiKey(req)
  if (!auth.ok) {
    return jsonError(auth.status, auth.error, auth.rateLimitHeaders)
  }

  // 3. Parse body.
  let rawBody: SwapRequestBody
  try {
    rawBody = (await req.json()) as SwapRequestBody
  } catch {
    return jsonError(400, 'Invalid JSON body.')
  }
  const parsed = parseBody(rawBody)
  if (parsed instanceof NextResponse) return parsed

  // 4. Resolve the source — caller-pinned wins; otherwise pick best
  //    fee-collectable from a meta-quote.
  let source: AggregatorName
  if (parsed.source) {
    source = parsed.source
  } else {
    const auto = await autoSelectSource(parsed.tokenIn, parsed.tokenOut, parsed.amountStr)
    if (auto instanceof NextResponse) return auto
    source = auto.source
  }

  // 5. Sanity check: the selected source MUST route through FeeCollector.
  //    parseBody / autoSelectSource already enforce this; the assertion
  //    here exists so a future code change can't silently produce a
  //    direct-routed v1/swap response.
  if (!usesFeeCollector(source)) {
    // [11-M-02] Original message identified the route and a code path
    // — recon material. Sanitised to the generic 500 envelope; the
    // diagnostic stays in the server log.
    console.error(
      `[v1/swap] guard tripped: source '${source}' resolved to a non-fee-collectable path`,
    )
    return jsonError(500, 'Internal error.')
  }

  // 6. Fetch swap data at the NET amount. FeeCollector deducts the 0.1%
  //    fee from the user's deposit before forwarding to the router, so
  //    the router must be quoted/built for the net amount it will see.
  const feeAmount = (parsed.amount * BigInt(FEE_BPS)) / 10_000n
  const netAmount = parsed.amount - feeAmount

  let swapData: NormalizedQuote
  try {
    swapData = await fetchSwapFromSource(
      source,
      parsed.tokenIn,
      parsed.tokenOut,
      netAmount.toString(),
      parsed.sender,
      parsed.slippage,
    )
  } catch (err) {
    // [11-M-02] err.message stays in the server log — never on the
    // wire. Status code logic is preserved (429 on upstream rate-
    // limited, 400 on disabled / not-whitelisted / unknown source
    // because those are caller-recoverable, 502 otherwise).
    const internalMessage = err instanceof Error ? err.message : 'fetchSwapFromSource failed'
    console.error(`[v1/swap] fetchSwapFromSource(${source}) failed:`, internalMessage)
    if (/rate.limit/i.test(internalMessage)) {
      return jsonError(429, 'Rate limit exceeded. Please retry.', auth.rateLimitHeaders)
    }
    if (/disabled|not whitelisted|unknown source/i.test(internalMessage)) {
      return jsonError(400, 'Selected source is currently unavailable.', auth.rateLimitHeaders)
    }
    return jsonError(502, 'Upstream service error. Please retry.', auth.rateLimitHeaders)
  }
  if (!swapData.tx) {
    // [11-M-02] Adapter name in the public message leaks architecture.
    console.error(`[v1/swap] adapter '${source}' did not return transaction data`)
    return jsonError(502, 'Upstream service error. Please retry.', auth.rateLimitHeaders)
  }

  // 7. Wrap in FeeCollector V2 calldata.
  let wrapped
  try {
    wrapped = buildFeeCollectorTx({
      tokenIn: parsed.tokenIn,
      tokenOut: parsed.tokenOut,
      amountTotal: parsed.amount,
      swapData,
      slippagePct: parsed.slippage,
    })
  } catch (err) {
    // [11-M-02] Wrapping errors include router-whitelist reasons and
    // adapter shape complaints — both internal. Keep on server log.
    const internalMessage = err instanceof Error ? err.message : 'fee-collector wrap failed'
    console.error('[v1/swap] buildFeeCollectorTx failed:', internalMessage)
    return jsonError(502, 'Upstream service error. Please retry.', auth.rateLimitHeaders)
  }

  // 8. Shape the v1 response. tx.gasEstimate is a string for parity with
  //    the other amount fields; callers parse it as a number client-side
  //    or pass it through to their wallet as-is.
  const gasEstimate = swapData.tx.gas > 0 ? String(swapData.tx.gas) : '0'
  const mevProtected = AGGREGATOR_META[source]?.mevProtected ?? false

  return NextResponse.json({
    tx: {
      to: wrapped.to,
      data: wrapped.data,
      value: wrapped.value,
      gasEstimate,
    },
    source,
    toAmount: wrapped.quotedOutput.toString(),
    minimumOutput: wrapped.minimumOutput.toString(),
    mevProtected,
    fee: {
      bps: FEE_BPS,
      amount: feeAmount.toString(),
      recipient: FEE_COLLECTOR_ADDRESS,
    },
    meta: {
      timestamp: new Date().toISOString(),
      chainId: CHAIN_ID,
      slippage: parsed.slippage,
      router: swapData.tx.to,
      routedVia: 'fee-collector-v2',
    },
  }, {
    headers: withCors({
      ...auth.rateLimitHeaders,
      // Swap data references a quoted output that's stale the moment it's
      // returned — never cache at any layer.
      'Cache-Control': 'no-store, max-age=0',
    }),
  })
}
