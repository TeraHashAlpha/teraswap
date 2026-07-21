/**
 * [SPRINT-P1B] Client-side mirror of the server's v3 USD dust floor, run BEFORE approve.
 *
 * `/api/orders` rejects any v3 order whose signed `minAmountOut` is worth less than
 * `getDcaMinChunkUsd()` (default $5) — `src/app/api/orders/route.ts:296-376`. That check is
 * authoritative and stays authoritative; this helper exists only so the user learns about the
 * problem BEFORE spending an approve transaction and a signature on an order the server will 400.
 *
 * Ordering matters and is the lesson from BUG-DCA-APPROVE-SPENDER-V3: the approve button only
 * exists inside the review modal that `useOrderEngine.createOrder` mounts by freezing
 * `pendingOrder`. So "before approve" means "before createOrder is called at all" — i.e. inside
 * the panel's submit handler, which is where this runs.
 *
 * Fail-OPEN when the output token cannot be priced client-side, matching
 * `applyDcaMinChunkGuard`'s convention: the server still enforces the floor (and fails CLOSED with
 * a 422 when it cannot price), so a client that merely lacks a price must not block a legitimate
 * order. This helper narrows the failure window; it is not a security control.
 */

import { getDcaMinChunkUsd } from './dca-custom'

export interface MinOutFloorParams {
  /** The signed `minAmountOut`, in tokenOut base units. */
  minAmountOut: bigint
  /** tokenOut decimals (client-side value; the server re-reads them on-chain). */
  tokenOutDecimals: number
  /** USD price of ONE whole tokenOut, or null when unknown (⇒ fail open). */
  tokenOutUsdPrice: number | null
  /** Override the floor; defaults to the same env-driven value the server uses. */
  minUsd?: number
}

export interface MinOutFloorResult {
  /** True when the order must not proceed to approve/sign. */
  blocked: boolean
  /** The computed USD value of minAmountOut, or null when it could not be priced. */
  minOutUsd: number | null
  /** The floor applied. */
  floorUsd: number
  /** User-facing reason when blocked, else null. */
  reason: string | null
}

/**
 * Value the signed floor in USD and decide whether to block before approve.
 */
export function checkMinOutEconomicFloor(p: MinOutFloorParams): MinOutFloorResult {
  const floorUsd = p.minUsd ?? getDcaMinChunkUsd()

  if (
    p.tokenOutUsdPrice == null ||
    !Number.isFinite(p.tokenOutUsdPrice) ||
    p.tokenOutUsdPrice <= 0 ||
    !Number.isFinite(p.tokenOutDecimals) ||
    p.tokenOutDecimals < 0
  ) {
    // Unpriceable client-side ⇒ fail open; the server remains the authoritative gate.
    return { blocked: false, minOutUsd: null, floorUsd, reason: null }
  }

  // Base units → whole tokens as a Number. minAmountOut is a floor (not a balance), so the
  // precision loss of Number here is immaterial relative to a $5 threshold.
  const whole = Number(p.minAmountOut) / 10 ** p.tokenOutDecimals
  if (!Number.isFinite(whole)) {
    return { blocked: false, minOutUsd: null, floorUsd, reason: null }
  }

  const minOutUsd = whole * p.tokenOutUsdPrice
  if (minOutUsd < floorUsd) {
    return {
      blocked: true,
      minOutUsd,
      floorUsd,
      reason:
        `Order too small: the guaranteed minimum output is about $${minOutUsd.toFixed(2)}, ` +
        `below the $${floorUsd} minimum. Increase the amount — a floor this small is dust and ` +
        `would not be economically meaningful protection.`,
    }
  }

  return { blocked: false, minOutUsd, floorUsd, reason: null }
}
