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

export type MinAmountOutSource = 'chainlink' | 'defillama' | 'approx' | 'fallback'

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
  /** Last-resort approximate price table lookups (e.g. lib/order-engine/usd.ts APPROX_PRICES),
   *  keyed the same way as the caller's table — pass null when the symbol isn't covered. */
  approxPriceIn: number | null
  approxPriceOut: number | null
}

export interface DeriveSigningMinResult {
  minAmountOut: bigint
  /** false ⇒ neither Chainlink nor DefiLlama priced BOTH legs — the fixed 'fallback' floor was
   *  used (or 'approx' partially bridged it). The caller MUST show the ADR-013 decay warning
   *  whenever source !== 'chainlink' — a stale fixed min loses meaning over a long DCA. */
  hasFeed: boolean
  source: MinAmountOutSource
}

/** First non-null price across (chainlink, defillama, approx), plus which tier it came from. */
function pickPrice(
  chainlink: number | null,
  defillama: number | null,
  approx: number | null,
): { price: number | null; source: MinAmountOutSource } {
  if (chainlink != null) return { price: chainlink, source: 'chainlink' }
  if (defillama != null) return { price: defillama, source: 'defillama' }
  if (approx != null) return { price: approx, source: 'approx' }
  return { price: null, source: 'fallback' }
}

/**
 * Full signing-time derivation: try Chainlink for both legs, else DefiLlama, else the
 * approximate price table. If EITHER leg still has no price, fall back to a small, deliberately
 * non-price, non-zero absolute minimum (never 1 wei) scaled to tokenOut's decimals — a real
 * on-chain floor, but one the ADR-013 decay warning must accompany (fixed forever, never
 * re-derived: price appreciation strands the order below reachable slippage, depreciation makes
 * the floor economically weak).
 */
export function deriveSigningMinAmountOut(p: DeriveSigningMinParams): DeriveSigningMinResult {
  const inPick = pickPrice(p.chainlinkPriceIn, p.defiLlamaPriceIn, p.approxPriceIn)
  const outPick = pickPrice(p.chainlinkPriceOut, p.defiLlamaPriceOut, p.approxPriceOut)

  if (inPick.price !== null && outPick.price !== null) {
    const derived = deriveAbsoluteMinAmountOut({
      amountIn: p.amountIn,
      srcDecimals: p.srcDecimals,
      dstDecimals: p.dstDecimals,
      priceInUsd: inPick.price,
      priceOutUsd: outPick.price,
      maxSlippageBps: p.maxSlippageBps,
    })
    if (derived !== null) {
      // 'chainlink' only when BOTH legs used Chainlink; a mixed chainlink+defillama/approx pair
      // is still priced (real derivation, not the fixed fallback) but isn't the strongest tier.
      const source: MinAmountOutSource =
        inPick.source === 'chainlink' && outPick.source === 'chainlink' ? 'chainlink' : outPick.source
      return { minAmountOut: derived, hasFeed: true, source }
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
