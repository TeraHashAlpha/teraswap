/**
 * [CHORE-DCA-UX-FIXES] checkRoute — order-create routability pre-check via /api/quote.
 *
 * Bug 3a: a DCA order for an unroutable pair (e.g. ETHFI → ETH on Base — a thin/imported token with
 * no aggregator route) was signable, then the keeper reverted executeOrder and the order failed.
 * This asks the meta-quote pipeline whether ANY route exists on the target chain BEFORE the user
 * approves/signs, so the order panel can warn + BLOCK up front (used especially for imported tokens).
 *
 * Fail-OPEN policy: only a DEFINITIVE "no route" blocks —
 *   - HTTP 502 whose body is the genuine no-route error ("No valid quotes"), or
 *   - a 200 with an empty quote set.
 * Everything else fails OPEN so a transient quote outage never blocks a legitimate order — the
 * executor still protects each fill via the on-chain minAmountOut. NOTE: /api/quote also returns 502
 * for transient all-timeout / all-network blips ("All sources timed out", "Network error"), so we
 * must inspect the 502 body and NOT treat every 502 as a no-route (that would false-block a routable
 * imported token during a brief upstream blip). 429 / 503 (sequencer-down/halt) / 500 / network error
 * all fail OPEN too.
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

    // 502 is ambiguous on /api/quote: a genuine no-route ("No valid quotes") AND transient
    // all-timeout / all-network blips both surface as 502. Block ONLY on the genuine no-route message;
    // fail OPEN for transient/unknown 502 bodies so a blip never false-blocks a routable token.
    if (res.status === 502) {
      const body = await res.json().catch(() => null)
      const msg = body && typeof body.error === 'string' ? body.error : ''
      return /no valid quotes/i.test(msg)
        ? { routable: false, reason: NO_ROUTE_REASON }
        : { routable: true }
    }

    // 429 / 503 / 500 / other → transient or ambiguous: fail OPEN (don't block on infra/ops issues).
    return { routable: true }
  } catch {
    // Network error / fetch unavailable → fail OPEN.
    return { routable: true }
  }
}
