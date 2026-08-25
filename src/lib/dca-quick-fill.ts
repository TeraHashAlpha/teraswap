/**
 * [CHORE-DCA-UX-POLISH] Pure BigInt math for the DCA spend-step quick-fill
 * (25/50/100%) and the per-chunk MIN_ORDER_AMOUNT re-validation.
 *
 * Smallest-unit (wei) arithmetic only — never via JS floats — so 100% always
 * selects the exact full balance to the wei and partial presets never drift.
 */

import { formatUnits } from 'viem'

/**
 * Take `pct` percent of a raw (smallest-unit) balance using integer math.
 *
 * - `pct` ≤ 0 or `balanceRaw` ≤ 0 → `0n`
 * - `pct` ≥ 100 → the full balance, unchanged (100% = full balance, exact)
 * - otherwise `floor((balanceRaw * pct) / 100)`
 */
export function quickFillRaw(balanceRaw: bigint, pct: number): bigint {
  if (balanceRaw <= 0n || pct <= 0) return 0n
  if (pct >= 100) return balanceRaw
  return (balanceRaw * BigInt(Math.trunc(pct))) / 100n
}

/**
 * Per-buy (per-chunk) raw amount = `floor(totalRaw / parts)`. Mirrors the split
 * the contract and `useOrderEngine` apply (`BigInt(amountIn) / BigInt(dcaTotal)`),
 * so the client-side floor check matches the on-chain MIN_ORDER_AMOUNT gate.
 *
 * - `parts` ≤ 0 or `totalRaw` ≤ 0 → `0n`
 */
export function perChunkRaw(totalRaw: bigint, parts: number): bigint {
  if (parts <= 0 || totalRaw <= 0n) return 0n
  return totalRaw / BigInt(parts)
}

// [fix/dca-min-buy-copy] "$14 for cbBTC at 8 dec" — sub-cent USD amounts round to "$0.00" with a
// flat 2dp format, which reads as broken, not small. 4dp only below a cent; ordinary amounts stay
// at the familiar 2dp.
function formatApproxUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)
}

/**
 * Human-readable form of the on-chain per-buy floor: the amount in the token's OWN units (e.g.
 * "0.0001 cbBTC" for a 10,000-base-unit floor at 8 decimals) plus its approximate USD value when
 * a price is known. `priceUsd` is the caller-supplied USD price of one WHOLE token — null when
 * unpriced, which drops the "(~$…)" suffix rather than fabricating a USD figure.
 *
 * [FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE] That price is now the LIVE Chainlink → DefiLlama price
 * (DCAPanel's `livePriceIn`, threaded to useOrderEngine via CreateOrderConfig.priceInUsd), NOT
 * `APPROX_PRICES`. The table read ~83% high on ETH; see the scope policy in
 * lib/order-engine/usd.ts. This module stays price-source agnostic — it only formats what it is
 * given — but the "~" prefix is load-bearing either way and must not be dropped.
 */
export function formatMinBuyUnit(
  minBuyRaw: bigint,
  decimals: number,
  symbol: string,
  priceUsd: number | null,
): string {
  const human = formatUnits(minBuyRaw, decimals)
  if (priceUsd == null) return `${human} ${symbol}`
  return `${human} ${symbol} (~$${formatApproxUsd(Number(human) * priceUsd)})`
}

export interface MinBuyMessageParams {
  /** The on-chain per-buy floor, in tokenIn base units (MIN_ORDER_AMOUNT). */
  minBuyRaw: bigint
  decimals: number
  symbol: string
  /** Current total spend, in tokenIn base units. */
  totalRaw: bigint
  /** Current requested buy count (DCA total executions). */
  requestedBuys: number
  /** USD price of one whole tokenIn, or null when unpriced (same source the form already uses). */
  priceUsd: number | null
}

export interface MinBuyMessage {
  /** Full human-readable, actionable copy — used for both the inline warning and the toast. */
  text: string
  /** floor(totalRaw / minBuyRaw) — the most buys the CURRENT total supports at the floor. */
  maxBuys: number
  /** minBuyRaw * requestedBuys — the smallest total that clears the floor at the requested buy count. */
  minTotalRaw: bigint
}

/**
 * [fix/dca-min-buy-copy] Rewrites the developer-speak "N base units" per-buy floor error into a
 * message a user can act on without knowing what a base unit is: the floor in the token's own
 * units + approx USD, and a concrete fix computed from the user's OWN inputs (lower the buy count
 * to what the current total supports, or raise the total to what the requested buy count needs).
 * Does NOT change MIN_ORDER_AMOUNT or any validation — copy/presentation only.
 */
export function formatMinBuyMessage(params: MinBuyMessageParams): MinBuyMessage {
  const { minBuyRaw, decimals, symbol, totalRaw, requestedBuys, priceUsd } = params

  const maxBuys = minBuyRaw > 0n ? Number(totalRaw / minBuyRaw) : 0
  const buys = requestedBuys > 0 ? requestedBuys : 1
  const minTotalRaw = minBuyRaw * BigInt(buys)
  const minTotalHuman = formatUnits(minTotalRaw, decimals)
  const minTotalUsd = priceUsd != null ? Number(minTotalHuman) * priceUsd : null

  const fixText = minTotalUsd != null
    ? (maxBuys >= 1
        ? `Lower to ${maxBuys} buy${maxBuys === 1 ? '' : 's'}, or raise your total to ~$${formatApproxUsd(minTotalUsd)}.`
        : `Raise your total to at least ~$${formatApproxUsd(minTotalUsd)}.`)
    : (maxBuys >= 1
        ? `Lower to ${maxBuys} buy${maxBuys === 1 ? '' : 's'}, or raise your total to ${minTotalHuman} ${symbol}.`
        : `Raise your total to at least ${minTotalHuman} ${symbol}.`)

  const text = `Each buy is too small. With ${symbol}, each buy must be at least `
    + `${formatMinBuyUnit(minBuyRaw, decimals, symbol, priceUsd)} — the on-chain minimum. ${fixText}`

  return { text, maxBuys, minTotalRaw }
}
