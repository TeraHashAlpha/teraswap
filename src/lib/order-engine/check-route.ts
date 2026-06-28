/**
 * [CHORE-DCA-UX-FIXES] checkRoute — order-create routability pre-check via /api/quote.
 *
 * Bug 3a: a DCA order for an unroutable pair (e.g. ETHFI → ETH on Base — a thin/imported token with
 * no aggregator route) was signable, then the keeper reverted executeOrder and the order failed.
 * This asks the meta-quote pipeline whether ANY route exists on the target chain BEFORE the user
 * approves/signs, so the order panel can warn + BLOCK up front (used especially for imported tokens).
 *
 * Fail-OPEN policy: only a DEFINITIVE "no route" blocks —
 *   - HTTP 502 (the quote route returns this when every aggregator source fails → "No valid quotes"),
 *   - or a 200 with an empty quote set.
 * Everything else (network error, 429 rate-limit, 503 sequencer-down/halt, 4xx/5xx) fails OPEN so a
 * transient quote outage never blocks a legitimate order — the executor still protects each fill via
 * the on-chain minAmountOut.
 */

export interface RouteCheckParams {
  /** Sell-token address (the order's tokenIn). */
  src: string
  /** Buy-token address (the order's tokenOut; native ETH sentinel is accepted). */
  dst: string
  /** Per-execution amount in smallest units (for DCA, the per-chunk amount). */
  amount: string
  srcDecimals: number
  dstDecimals: number
  /** Target chain the order will execute on. */
  chainId: number
}

export interface RouteCheckResult {
  routable: boolean
  /** User-facing reason when not routable. */
  reason?: string
}

export const NO_ROUTE_REASON =
  'No swap route found for this pair on this network. This token may have too little liquidity to trade — pick a different token, amount, or network before placing the order.'

export async function checkRoute(p: RouteCheckParams): Promise<RouteCheckResult> {
  const qs = new URLSearchParams({
    src: p.src,
    dst: p.dst,
    amount: p.amount,
    srcDecimals: String(p.srcDecimals),
    dstDecimals: String(p.dstDecimals),
    chainId: String(p.chainId),
  })

  try {
    const res = await fetch(`/api/quote?${qs.toString()}`)

    if (res.ok) {
      const json = await res.json().catch(() => null)
      const hasRoute =
        !!json && Array.isArray(json.all) && json.all.length > 0 && !!json.best
      return hasRoute ? { routable: true } : { routable: false, reason: NO_ROUTE_REASON }
    }

    // 502 = the meta-quote pipeline found no valid quotes from any source → no route on this chain.
    if (res.status === 502) return { routable: false, reason: NO_ROUTE_REASON }

    // 429 / 503 / 500 / other → transient or ambiguous: fail OPEN (don't block on infra/ops issues).
    return { routable: true }
  } catch {
    // Network error / fetch unavailable → fail OPEN.
    return { routable: true }
  }
}
