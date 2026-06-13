import { NextResponse, type NextRequest } from 'next/server'
import { fetchSwapFromSource, usesFeeCollector } from '@/lib/api'
import { AGGREGATOR_APIS, type AggregatorName } from '@/lib/constants'
import { validateSwapPrice, fetchDefiLlamaPrice, HIGH_VALUE_THRESHOLD_USD } from '@/lib/defillama'
import { isKnownSwapSelector, getSelector } from '@/lib/swap-selectors'
import { validateCallDataRecipient } from '@/lib/calldata-recipient'
import { checkRateLimit, SWAP_RATE_LIMIT } from '@/lib/kv-rate-limiter'
import { isSystemHalted } from '@/lib/circuit-breaker'
import { getChainConfig, DEFAULT_CHAIN_ID } from '@/lib/chains/registry'
import { getChainStatus } from '@/lib/chains/activation'
import { isSequencerUp, SequencerDownError } from '@/lib/chains/sequencer-check'
import { getPublicClientForChain } from '@/lib/chains/clients'
import { sanitizeUpstreamError } from '@/lib/sanitize-error'

// [SPRINT-9J J2] Give the function enough headroom that a slow swap-build never
// hits the platform's default ceiling (which serves an HTML 504 the route never
// produced → client "Unexpected token '<' … not valid JSON"). The build itself
// is bounded far lower by SWAP_BUILD_TIMEOUT_MS×attempts, so we fail fast as
// clean JSON well inside this window rather than ever using it all.
export const maxDuration = 60

// [P121] Source allow-list — built from the canonical AGGREGATOR_APIS map so
// adding/removing a source in constants.ts automatically updates this guard.
// Rejects unknown sources at the entry point before any upstream fetch,
// rate-limit deduction, or Supabase write.
const ALLOWED_SOURCES: Set<string> = new Set(Object.keys(AGGREGATOR_APIS))

/**
 * Server-side proxy for swap calldata requests.
 *
 * Like the quote route, this avoids browser CORS restrictions
 * when fetching swap calldata from external DEX APIs.
 */

// ── [Audit] Max request body size (prevent oversized payloads)
const MAX_BODY_SIZE = 10_000 // 10KB

export async function POST(req: NextRequest) {
  // [H-03] Circuit breaker halt — short-circuit before any other work
  if (await isSystemHalted()) {
    return NextResponse.json(
      { error: 'System temporarily paused for safety. Please try again later.', halted: true },
      {
        status: 503,
        headers: { 'Retry-After': '300' },
      },
    )
  }

  try {
    // [Audit] Request size check (header-only — cheap, no body read needed)
    const contentLength = parseInt(req.headers.get('content-length') || '0', 10)
    if (contentLength > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: 'Request body too large' },
        { status: 413 },
      )
    }

    const body = await req.json()
    const {
      source,
      src,
      dst,
      amount,
      from,
      slippage = 0.5,
      srcDecimals = 18,
      dstDecimals = 18,
      quoteMeta,
      chainId,
      /** Optional output destination — when present, calldata must direct
       *  tokens here instead of `from`. Required when `from` is the
       *  FeeCollector contract but the user wallet receives tokens. */
      recipient,
    } = body

    if (!source || !src || !dst || !amount || !from) {
      return NextResponse.json(
        { error: 'Missing required fields: source, src, dst, amount, from' },
        { status: 400 },
      )
    }

    // [P121] Source allow-list guard — reject unknown sources before any
    // rate-limit deduction, upstream call, or downstream side effect.
    if (typeof source !== 'string' || !ALLOWED_SOURCES.has(source)) {
      return NextResponse.json(
        { error: 'Unknown aggregator source', code: 'INVALID_SOURCE' },
        { status: 400 },
      )
    }

    // [SPRINT-9G G4 / M03+M05] Server-side chain-activation gate. The activation
    // guard must live at the trust boundary (the server), not only in the UI /
    // /v1 routes — otherwise a direct caller obtains executable, fee-free swap
    // calldata for a chain TeraSwap has not launched. Reject an unsupported chain
    // (400) and a not-yet-live "coming-soon" chain (409, FeeCollector unset).
    // Absent chainId → mainnet default → unchecked → byte-identical.
    if (chainId != null) {
      const chainStatus = getChainStatus(Number(chainId))
      if (chainStatus === 'unsupported') {
        return NextResponse.json(
          { error: `Chain ${chainId} is not supported`, code: 'CHAIN_UNSUPPORTED' },
          { status: 400 },
        )
      }
      if (chainStatus === 'coming-soon') {
        return NextResponse.json(
          { error: `Chain ${chainId} is not yet available for swaps`, code: 'CHAIN_COMING_SOON' },
          { status: 409 },
        )
      }
    }

    // [E2-I-01] L2 sequencer gate on the swap-BUILD path — belt-and-suspenders
    // to the E-2 quote gate (Audits/Sprint/SPRINT-E2-AUDIT.md). Single source of
    // truth: isSequencerUp (sequencer-check.ts) owns the feed address, the
    // recovery grace window, and the fail-safe direction (down / in-grace /
    // RPC error → false → refuse). Placed after the activation gate (chain is
    // known supported + active) and BEFORE the rate limiter and the upstream
    // fetch, so a sequencer-down request burns neither rate-limit budget nor an
    // upstream call. Mainnet is byte-identical: absent chainId or
    // DEFAULT_CHAIN_ID never consults the gate (no client construction either).
    if (chainId != null && Number(chainId) !== DEFAULT_CHAIN_ID) {
      const seqUp = await isSequencerUp(Number(chainId), getPublicClientForChain(Number(chainId)))
      if (!seqUp) {
        console.warn(`[E2-I-01] Swap build refused: chain ${Number(chainId)} sequencer down or in grace period`)
        // Reuse SequencerDownError for the message so the refusal wording stays
        // single-sourced with the quote gate (one "paused" UX client-side).
        const seqErr = new SequencerDownError(Number(chainId))
        return NextResponse.json(
          { error: seqErr.message, sequencerDown: true },
          { status: 503, headers: { 'Retry-After': '60' } },
        )
      }
    }

    // [Audit B-06] Rate limiting by IP — persistent via Vercel KV.
    // Runs AFTER the source guard so invalid requests don't burn budget.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || req.headers.get('x-real-ip')
      || 'unknown'
    const rateCheck = await checkRateLimit(`swap:${ip}`, SWAP_RATE_LIMIT.limit, SWAP_RATE_LIMIT.windowMs)

    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Try again in 60 seconds.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(rateCheck.resetAt),
          },
        },
      )
    }

    // [Audit] Validate address format
    const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
    if (!ADDRESS_RE.test(src) || !ADDRESS_RE.test(dst) || !ADDRESS_RE.test(from)) {
      return NextResponse.json(
        { error: 'Invalid address format' },
        { status: 400 },
      )
    }
    if (recipient != null && (typeof recipient !== 'string' || !ADDRESS_RE.test(recipient))) {
      return NextResponse.json(
        { error: 'Invalid recipient address format' },
        { status: 400 },
      )
    }

    // [Audit / L-01] Validate slippage range — max 15% for mainnet safety
    const slippageNum = Number(slippage)
    if (isNaN(slippageNum) || slippageNum < 0 || slippageNum > 15) {
      return NextResponse.json(
        { error: 'Slippage must be between 0 and 15%' },
        { status: 400 },
      )
    }

    const result = await fetchSwapFromSource(
      source as AggregatorName,
      src,
      dst,
      amount,
      from,
      slippageNum,
      srcDecimals,
      dstDecimals,
      quoteMeta,
      chainId ? Number(chainId) : undefined,
      recipient,
    )

    // [SC-04] Server-side defense-in-depth — mirrors frontend KNOWN_SWAP_SELECTORS
    if (result.tx?.data) {
      if (!isKnownSwapSelector(result.tx.data as string)) {
        const selector = getSelector(result.tx.data as string)
        console.warn('[SC-04] Rejected unknown swap selector:', selector, 'source:', source)
        return NextResponse.json(
          { error: 'Unknown swap function selector', selector },
          { status: 400 },
        )
      }

      // [R1] Validate recipient in calldata matches the expected destination.
      // When the request includes an explicit `recipient` (FeeCollector
      // routing: `from` = FeeCollector contract, `recipient` = user wallet)
      // the calldata must direct tokens to that recipient, not to `from`.
      const expectedRecipient = recipient || from
      if (expectedRecipient) {
        // [FULL-M-01] Only fee-routed sources may legitimately deliver output
        // to the FeeCollector. Direct sources (0x, CoW) must reject it.
        const routeViaFeeCollector = usesFeeCollector(source as AggregatorName, chainId ? Number(chainId) : undefined)
        const recipientCheck = validateCallDataRecipient(result.tx.data as string, expectedRecipient, routeViaFeeCollector, chainId ? Number(chainId) : undefined)
        if (!recipientCheck.valid) {
          console.error(
            `[R1] BLOCKED: Recipient mismatch in ${source} calldata.`,
            `Expected: ${expectedRecipient}, Got: ${recipientCheck.extracted}`,
            `Reason: ${recipientCheck.reason}`,
          )
          return NextResponse.json(
            { error: 'Swap calldata recipient does not match your wallet. Possible API compromise.' },
            { status: 400 },
          )
        }
        if (recipientCheck.extracted) {
          console.log(`[R1] Recipient validated: ${recipientCheck.extracted.slice(0, 10)}... (${source})`)
        } else if (!recipientCheck.implicitRecipient) {
          // codeql[js/log-injection] Server-side log only. `source` is checked against the AGGREGATOR_APIS allowlist earlier in this handler; an attacker can only pass one of the closed-set source ids, so newline injection is structurally impossible.
          console.warn(`[R1] Could not extract recipient for ${source} (selector unsupported)`)
        }
      }
    }

    // ── [Security] Server-side price validation via DefiLlama ──
    // Validates swap output against independent oracle to catch
    // price manipulation, extreme slippage, or rogue aggregator responses.
    // [INT-01] Blocking for high-value swaps (>$10k). Fail-open for small swaps.
    if (result.toAmount) {
      // [SPRINT-9G G2 / M11] DefiLlama chain slug for the swap's chain. Default
      // mainnet 'ethereum' keeps the guard byte-identical; an unknown chainId
      // falls back to 'ethereum' rather than throwing. A Base swap now validates
      // Base prices instead of always-blocking (>$10k) / silently failing open.
      const llamaChain = (() => {
        const cid = chainId != null ? Number(chainId) : DEFAULT_CHAIN_ID
        try { return getChainConfig(cid).slug } catch { return 'ethereum' }
      })()
      // [INT-01] Estimate swap value in USD for threshold-based blocking
      let estimatedValueUsd = 0
      try {
        const tokenInPrice = await fetchDefiLlamaPrice(src, llamaChain)
        if (tokenInPrice) {
          const amountFloat = Number(amount) / 10 ** srcDecimals
          estimatedValueUsd = amountFloat * tokenInPrice.price
        }
      } catch {
        // If price estimation fails, assume 0 → fail-open for threshold logic
      }

      try {
        const priceCheck = await validateSwapPrice({
          tokenIn: src,
          tokenOut: dst,
          amountIn: amount,
          amountOut: result.toAmount,
          decimalsIn: srcDecimals,
          decimalsOut: dstDecimals,
          estimatedValueUsd,
          chain: llamaChain,
        })

        if (priceCheck && !priceCheck.valid) {
          console.warn(
            `[PRICE-GUARD] Blocked swap ${source}: ${src} → ${dst}`,
            `deviation=${(priceCheck.deviation * 100).toFixed(1)}%`,
            `estimatedUsd=$${Math.round(priceCheck.estimatedValueUsd ?? 0)}`,
            `reason=${priceCheck.reason}`,
          )
          return NextResponse.json(
            {
              error: priceCheck.reason,
              priceGuard: true,
              deviation: priceCheck.deviation,
              blocked: priceCheck.blocked,
            },
            { status: 422 },
          )
        }

        // Attach oracle info for client-side display (non-blocking data)
        if (priceCheck) {
          const ext = result as unknown as Record<string, unknown>
          ext.oracleDeviation = priceCheck.deviation
          ext.oraclePriceIn = priceCheck.oraclePriceIn
          ext.oraclePriceOut = priceCheck.oraclePriceOut
        }
      } catch (oracleErr) {
        // [INT-01] For high-value swaps, oracle failures are blocking
        if (estimatedValueUsd > HIGH_VALUE_THRESHOLD_USD) {
          console.warn('[PRICE-GUARD] Oracle error on high-value swap, blocking:', oracleErr)
          return NextResponse.json(
            {
              error: 'Price validation unavailable for high-value swap. Please try again.',
              priceGuard: true,
              blocked: true,
            },
            { status: 422 },
          )
        }
        // Small swaps: fail-open (original behaviour)
        console.warn('[PRICE-GUARD] Oracle error (non-blocking):', oracleErr)
      }
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-RateLimit-Remaining': String(rateCheck.remaining),
        'X-RateLimit-Reset': String(rateCheck.resetAt),
      },
    })
  } catch (err) {
    // [SPRINT-9J J2] Always JSON (never let the platform serve HTML), and redact
    // any secret an upstream adapter error might have echoed (URL apiKey, Bearer).
    const message = sanitizeUpstreamError(err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
