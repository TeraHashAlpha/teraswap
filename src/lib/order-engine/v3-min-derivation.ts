/**
 * [SPRINT-V3-P2 / ADR-013 §1] Pure signing-side absolute-minAmountOut derivation.
 *
 * DCA (and any conditional order signed against v3) must never sign `minAmountOut = 1` again
 * (the P1a footgun the v3 contract's revert-on-scaled-zero closes on-chain). This module derives
 * a REAL absolute minimum from a reference USD price at signing time, mirroring the keeper's
 * `computeReferenceExpectedOut` (contracts/order-engine/executor/order-floor.js) — same formula,
 * same precision approach (integer 8-dp USD prices, BigInt throughout, no float-mantissa loss on
 * 18-decimal magnitudes) — so the signed floor and the keeper's independent oracle-floor check
 * agree on what "fair value" means.
 *
 * Pure + never-throwing: no I/O, no Date.now, no provider — the caller (DCAPanel) supplies the
 * fetched prices (Chainlink first, else DefiLlama — same plumbing useChainlinkPrice/checkOracleCoverage
 * already use). null in ⇒ null out (no-feed pair): the caller then falls back to a fixed, still-real
 * (never 1-wei) signed minimum and surfaces the decay warning (ADR-013 owner decision).
 *
 * ── PRICE-INTEGRITY POLICY [FIX-SIGNING-MIN-PRICE-INTEGRITY / INC-2026-08-07-001] ────────────
 * A signed `minAmountOut` is an on-chain commitment the user cannot revise: the contract enforces
 * it on every fill until expiry. It may therefore rest ONLY on a live price source — Chainlink, or
 * DefiLlama as the documented fallback. A hardcoded approximation table must never reach it.
 *
 * Order ef85438b proved why. cbETH had neither a Chainlink nor a DefiLlama price, so the signing
 * path fell through to `APPROX_PRICES.CBETH = 3600` while the WETH leg priced live at
 * $1942.46585493. cbETH was really ~$2204 that day, so the table overstated the pair ratio by
 * ~63%; after the contract's per-chunk scaling the floor sat ~1.59x above market and no fill could
 * ever clear it — 516 reverts, all in simulation. The table's ETH entry ($3500 against a live
 * $1911.90) shows the staleness is systemic, not a one-token slip.
 *
 * Consequently `approxPrice*` is NOT part of this module's signing inputs. The omission is
 * deliberate and compiler-enforced: there is no parameter through which a table price can enter.
 * APPROX_PRICES remains correct and in use for DISPLAY and ANALYTICS (src/lib/order-engine/usd.ts),
 * where a stale estimate costs a wrong label, not an unfillable order.
 */

function toPositiveBigInt(v: bigint | number | string): bigint | null {
  try {
    if (typeof v === 'bigint') return v > 0n ? v : null
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v <= 0) return null
      return BigInt(Math.trunc(v))
    }
    if (typeof v === 'string') {
      const s = v.trim()
      if (s === '' || !/^\d+$/.test(s)) return null
      const b = BigInt(s)
      return b > 0n ? b : null
    }
    return null
  } catch {
    return null
  }
}

function toPositiveNumber(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Fair-value expected output (raw tokenOut units) for `amountIn` (raw tokenIn units) given both
 * legs' USD prices. Identical formula to the keeper's `computeReferenceExpectedOut` —
 * `expectedOut_raw = amountIn_raw × pIn × 10^dstDec / (pOut × 10^srcDec)`, with both USD prices
 * scaled to 8-dp integers (the 1e8 factors cancel) so the whole computation stays in BigInt.
 */
export function computeReferenceExpectedOutTs(p: {
  amountIn: bigint | number | string
  srcDecimals: number
  dstDecimals: number
  priceInUsd: number | null
  priceOutUsd: number | null
}): bigint | null {
  const amountIn = toPositiveBigInt(p.amountIn)
  const pInNum = toPositiveNumber(p.priceInUsd)
  const pOutNum = toPositiveNumber(p.priceOutUsd)
  if (amountIn === null || pInNum === null || pOutNum === null) return null
  if (
    !Number.isInteger(p.srcDecimals) || !Number.isInteger(p.dstDecimals) ||
    p.srcDecimals < 0 || p.dstDecimals < 0
  ) return null

  const pIn = BigInt(Math.round(pInNum * 1e8))
  const pOut = BigInt(Math.round(pOutNum * 1e8))
  if (pIn <= 0n || pOut <= 0n) return null

  const num = amountIn * pIn * 10n ** BigInt(p.dstDecimals)
  const den = pOut * 10n ** BigInt(p.srcDecimals)
  if (den === 0n) return null
  return num / den
}

export interface DeriveAbsoluteMinParams {
  /** Raw tokenIn amount for THIS chunk (per-DCA-execution amount, not the order total). */
  amountIn: bigint | number | string
  srcDecimals: number
  dstDecimals: number
  /** Chainlink-first, DefiLlama-fallback USD price. null ⇒ no-feed leg. */
  priceInUsd: number | null
  priceOutUsd: number | null
  /** uint16, already clamped to [0, MAX_ORDER_SLIPPAGE_BPS] by the caller. */
  maxSlippageBps: number
}

/**
 * Derive the absolute `minAmountOut` to sign for one chunk: reference fair value × (1 −
 * maxSlippageBps/10000), floored to an integer raw amount. Returns null when either leg is
 * unpriced (no-feed) — the caller must fall back to a fixed real minimum (never null/1) and show
 * the ADR-013 decay warning; this function never fabricates a price.
 */
export function deriveAbsoluteMinAmountOut(p: DeriveAbsoluteMinParams): bigint | null {
  if (!Number.isFinite(p.maxSlippageBps) || p.maxSlippageBps < 0 || p.maxSlippageBps > 10_000) return null
  const fairOut = computeReferenceExpectedOutTs({
    amountIn: p.amountIn,
    srcDecimals: p.srcDecimals,
    dstDecimals: p.dstDecimals,
    priceInUsd: p.priceInUsd,
    priceOutUsd: p.priceOutUsd,
  })
  if (fairOut === null) return null
  const bps = BigInt(Math.round(p.maxSlippageBps))
  const min = (fairOut * (10_000n - bps)) / 10_000n
  return min > 0n ? min : null
}

// ── Signing-time source selection (Chainlink first, else DefiLlama, else a fixed
// non-price fallback) — the "same plumbing as the keeper floor" the sprint spec calls for,
// plus the ADR-013 owner-approved no-feed UX (a real, non-1-wei fixed min + decay warning). ──

/**
 * Live price tiers a signed floor may rest on, STRONGEST FIRST — the array order IS the ranking
 * `weakestTier` reads. `'fallback'` is not a tier: it means no derivation happened at all.
 * `'approx'` is deliberately absent (see the price-integrity policy in the module header).
 */
const SIGNING_TIERS = ['chainlink', 'defillama'] as const
type SigningTier = (typeof SIGNING_TIERS)[number]

export type MinAmountOutSource = SigningTier | 'fallback'

export interface DeriveSigningMinParams {
  amountIn: bigint | number | string
  srcDecimals: number
  dstDecimals: number
  maxSlippageBps: number
  /** Chainlink price for each leg (from useChainlinkPrice), null if no feed. */
  chainlinkPriceIn: number | null
  chainlinkPriceOut: number | null
  /** DefiLlama price for each leg (fetched only when Chainlink is null), null if unpriced. */
  defiLlamaPriceIn: number | null
  defiLlamaPriceOut: number | null
  // NOTE: there is deliberately no `approxPrice*` here. A hardcoded table may not price a signed
  // on-chain minimum — module header, [FIX-SIGNING-MIN-PRICE-INTEGRITY]. Removing the parameters
  // rather than ignoring them makes the policy compiler-enforced: a caller that tries to
  // reintroduce the table fails to typecheck instead of silently signing a stale price.
}

export interface DeriveSigningMinResult {
  minAmountOut: bigint
  /**
   * true ⇒ BOTH legs were priced by a LIVE source, so `minAmountOut` is genuinely price-derived.
   * false ⇒ at least one leg had no live price, the fixed non-price ADR-013 floor was used, and
   * the caller MUST surface the decay warning (DCAPanel gates the warning on exactly this flag).
   *
   * [FIX-SIGNING-MIN-PRICE-INTEGRITY] A table price can no longer make this true. Before the fix,
   * an APPROX_PRICES leg reported hasFeed=true AND source='chainlink' — so BOTH the flag the UI
   * reads and the tier the docs referenced were wrong, and the warning stayed silent on the one
   * order shape that most needed it (INC-2026-08-07-001).
   */
  hasFeed: boolean
  /**
   * The WEAKEST tier across the two legs, never the stronger one — a floor is only as trustworthy
   * as its worse input, so a mixed chainlink/defillama pair reports 'defillama'.
   */
  source: MinAmountOutSource
}

/**
 * First live price for a leg (Chainlink, else DefiLlama), plus which tier it came from.
 * Returns null when the leg has no live price at all — the caller then takes the no-feed path.
 */
function pickPrice(
  chainlink: number | null,
  defillama: number | null,
): { price: number; tier: SigningTier } | null {
  if (chainlink != null) return { price: chainlink, tier: 'chainlink' }
  if (defillama != null) return { price: defillama, tier: 'defillama' }
  return null
}

/** The weaker (later-ranked) of two tiers. Ties return that same tier. */
function weakestTier(a: SigningTier, b: SigningTier): SigningTier {
  return SIGNING_TIERS.indexOf(a) >= SIGNING_TIERS.indexOf(b) ? a : b
}

/**
 * Full signing-time derivation: Chainlink for both legs, else DefiLlama for whichever leg
 * Chainlink missed. If EITHER leg still has no LIVE price, fall back to a small, deliberately
 * non-price, non-zero absolute minimum (never 1 wei) scaled to tokenOut's decimals — a real
 * on-chain floor, but one the ADR-013 decay warning must accompany (fixed forever, never
 * re-derived: price appreciation strands the order below reachable slippage, depreciation makes
 * the floor economically weak).
 *
 * There is no third pricing tier. A hardcoded table is not an acceptable basis for a signed
 * commitment — see the price-integrity policy in the module header. An unpriceable pair yields the
 * honest no-feed floor plus a visible warning, never a confident-looking number resting on a
 * constant that was last edited by hand.
 */
export function deriveSigningMinAmountOut(p: DeriveSigningMinParams): DeriveSigningMinResult {
  const inPick = pickPrice(p.chainlinkPriceIn, p.defiLlamaPriceIn)
  const outPick = pickPrice(p.chainlinkPriceOut, p.defiLlamaPriceOut)

  if (inPick !== null && outPick !== null) {
    const derived = deriveAbsoluteMinAmountOut({
      amountIn: p.amountIn,
      srcDecimals: p.srcDecimals,
      dstDecimals: p.dstDecimals,
      priceInUsd: inPick.price,
      priceOutUsd: outPick.price,
      maxSlippageBps: p.maxSlippageBps,
    })
    if (derived !== null) {
      // Report the WEAKEST leg's tier. The previous form —
      //   both-chainlink ? 'chainlink' : outPick.source
      // — read only the tokenOut leg whenever the pair was mixed, so an in=<weaker>/out=chainlink
      // pair was announced as 'chainlink'. That is what suppressed the decay warning on ef85438b.
      // A floor is only as trustworthy as its worse input, so the worse input is what we report.
      return { minAmountOut: derived, hasFeed: true, source: weakestTier(inPick.tier, outPick.tier) }
    }
  }

  // No-feed path (owner decision, ADR-013): a fixed, deliberately non-1-wei floor. Scaled to
  // ~0.0001 whole tokenOut units — small enough to virtually always be clearable, but strictly
  // positive so the v3 contract's InvalidMinOutput (scaled-to-zero) never fires on it, and it is
  // NOT a magic "1" — the decay warning documents that this floor is not economically meaningful.
  const decimalsFloor = Math.max(p.dstDecimals - 4, 0)
  const fallback = 10n ** BigInt(decimalsFloor)
  return { minAmountOut: fallback, hasFeed: false, source: 'fallback' }
}
