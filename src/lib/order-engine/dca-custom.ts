/**
 * [CHORE-DCA-CUSTOM-PERIODS] Pure helpers for the DCA "Custom" interval/buys mode.
 *
 * Bounds verified READ-ONLY against the current deployment before choosing these ranges
 * (documented in full in FEEDBACK.md):
 *  - Contract (TeraSwapOrderExecutor.sol): dcaTotal must be > 0 (InvalidDCATotal),
 *    dcaInterval must be > 0 (InvalidDCAInterval); per-chunk floor MIN_ORDER_AMOUNT =
 *    10_000 base units (the EXISTING client guard in useOrderEngine.createOrder already
 *    enforces this — untouched here). No on-chain UPPER bound on either dcaTotal or
 *    dcaInterval.
 *  - Keeper (contracts/order-engine/executor/executor.js): POLL_INTERVAL_MS = 30_000 (30s).
 *    The smallest allowed custom interval (1h = 3600s) is two orders of magnitude above
 *    that, so polling granularity never bites.
 *  - Order-creation API (src/app/api/orders/route.ts, mirrored in
 *    contracts/order-engine/api/orders.ts): HARD-rejects `expiry > now + MAX_EXPIRY_DAYS
 *    (90) * 86400` with a 400. THIS — not the contract, not the keeper — is the real
 *    binding ceiling for interval × buys, since 10 days × 100 buys = 1000 days.
 */

import { MAX_EXPIRY_DAYS } from './config'

export const DCA_CUSTOM_BUYS_MIN = 1
export const DCA_CUSTOM_BUYS_MAX = 100
export const DCA_CUSTOM_INTERVAL_NUMBER_MIN = 1
export const DCA_CUSTOM_INTERVAL_NUMBER_MAX = 10

export type DcaCustomIntervalUnit = 'hours' | 'days'

const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = 86_400

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Custom buy count, clamped to [1, 100]. Non-finite input falls back to the minimum. */
export function clampCustomBuys(n: number): number {
  return clampInt(n, DCA_CUSTOM_BUYS_MIN, DCA_CUSTOM_BUYS_MAX)
}

/** Custom interval magnitude, clamped to [1, 10]. Non-finite input falls back to the minimum. */
export function clampCustomIntervalNumber(n: number): number {
  return clampInt(n, DCA_CUSTOM_INTERVAL_NUMBER_MIN, DCA_CUSTOM_INTERVAL_NUMBER_MAX)
}

/**
 * Custom interval in seconds — always > 0 (mirrors the contract's InvalidDCAInterval guard),
 * since the magnitude is clamped to >= 1 before conversion.
 */
export function customIntervalSeconds(n: number, unit: DcaCustomIntervalUnit): number {
  const clamped = clampCustomIntervalNumber(n)
  return clamped * (unit === 'hours' ? SECONDS_PER_HOUR : SECONDS_PER_DAY)
}

/**
 * [req.2 expiry coherence] Auto-derive the Custom-mode expiry: interval*buys + a buffer
 * (max(1h, 10% of interval) — slack for keeper poll + execution jitter), HARD-CAPPED at
 * MAX_EXPIRY_DAYS (the order-creation API's real ceiling).
 *
 * When interval*buys alone already exceeds that cap, the returned value is LESS than the
 * schedule needs. That is intentional: the existing dcaScheduleFitsExpiry() gate (already
 * wired into DCAPanel for the preset path) reads this expiry and blocks submit with its
 * standard message — so Custom mode gets a correct hard-warn for free, with no new gate.
 */
export function deriveCustomExpirySeconds(opts: {
  intervalSeconds: number
  buys: number
  maxExpiryDays?: number
}): number {
  const { intervalSeconds, buys } = opts
  const maxExpiryDays = opts.maxExpiryDays ?? MAX_EXPIRY_DAYS
  const neededSeconds = intervalSeconds * buys
  const bufferSeconds = Math.max(SECONDS_PER_HOUR, Math.round(intervalSeconds * 0.1))
  const derived = neededSeconds + bufferSeconds
  const cap = maxExpiryDays * SECONDS_PER_DAY
  return Math.min(derived, cap)
}

/** Default USD floor per DCA buy when NEXT_PUBLIC_DCA_MIN_CHUNK_USD isn't set. */
export const DCA_MIN_CHUNK_USD_DEFAULT = 1

/** Reads the env override (inlined at build time by Next.js); falls back to the default. */
export function getDcaMinChunkUsd(): number {
  const raw = process.env.NEXT_PUBLIC_DCA_MIN_CHUNK_USD
  const parsed = raw != null ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DCA_MIN_CHUNK_USD_DEFAULT
}

export interface DcaMinChunkResult {
  /** Effective buys after capping — identical to requestedBuys when no cap was needed. */
  buys: number
  /** Non-null when buys were capped, or when the total itself is below the floor. */
  warning: string | null
  /** true only when even 1 buy would be dust — caller must block submit (buys is NOT resized). */
  blocked: boolean
}

/**
 * [req.2 min-chunk / SC-02 dust guard] Every buy must be >= minChunkUsd. `totalUsd` is null
 * when the spend token has no known USD price — fails OPEN in that case (same posture as
 * fillUsd elsewhere in this module): the pre-existing per-chunk MIN_ORDER_AMOUNT base-unit
 * floor (useOrderEngine.createOrder) remains the universal backstop regardless of pricing.
 */
export function applyDcaMinChunkGuard(opts: {
  totalUsd: number | null
  requestedBuys: number
  minChunkUsd: number
}): DcaMinChunkResult {
  const { totalUsd, requestedBuys, minChunkUsd } = opts
  if (totalUsd == null || totalUsd <= 0 || requestedBuys <= 0) {
    return { buys: requestedBuys, warning: null, blocked: false }
  }
  const perChunkUsd = totalUsd / requestedBuys
  if (perChunkUsd >= minChunkUsd) {
    return { buys: requestedBuys, warning: null, blocked: false }
  }
  const maxBuys = Math.floor(totalUsd / minChunkUsd)
  if (maxBuys < 1) {
    return {
      buys: requestedBuys,
      warning: `Total is below the $${minChunkUsd} minimum per buy — increase the amount.`,
      blocked: true,
    }
  }
  return {
    buys: maxBuys,
    warning: `${requestedBuys} buys at $${perChunkUsd.toFixed(2)} each is below the $${minChunkUsd} minimum — capped to ${maxBuys} buys.`,
    blocked: false,
  }
}

/** [req.2] Live, non-alarmist one-line summary for Custom mode. */
export function customDcaSummary(opts: {
  buys: number
  perBuyLabel: string
  intervalLabel: string
  expirySeconds: number
}): string {
  const { buys, perBuyLabel, intervalLabel, expirySeconds } = opts
  const expiryLabel = expirySeconds < SECONDS_PER_DAY
    ? `${Math.round(expirySeconds / SECONDS_PER_HOUR)}h`
    : `${(expirySeconds / SECONDS_PER_DAY).toFixed(1)}d`
  return `${buys} buys of ${perBuyLabel} every ${intervalLabel}, ends ~${expiryLabel}.`
}
