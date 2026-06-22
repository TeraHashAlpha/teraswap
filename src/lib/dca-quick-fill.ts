/**
 * [CHORE-DCA-UX-POLISH] Pure BigInt math for the DCA spend-step quick-fill
 * (25/50/100%) and the per-chunk MIN_ORDER_AMOUNT re-validation.
 *
 * Smallest-unit (wei) arithmetic only — never via JS floats — so 100% always
 * selects the exact full balance to the wei and partial presets never drift.
 */

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
