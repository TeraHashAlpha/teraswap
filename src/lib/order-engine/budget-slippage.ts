/**
 * [CHORE-DCA-BUDGET-UX] Pure $ ↔ bps mapping for the DCA "max execution cost" UX.
 *
 * The owner's adopted design (SPRINT-KEEPER-FILL-ECONOMICS.md): the user sets a MAX TOTAL
 * EXECUTION COST in $ for the whole DCA; we translate that into the ALREADY-SIGNED
 * `maxSlippageBps` value the panel derives/signs today (PR #299 path) — no new signed field,
 * no signing change. The on-chain oracle floor then enforces the $ budget trustlessly.
 *
 * Display/derivation only — this module does not touch order-engine/config.ts or any signed
 * struct; it is a standalone conversion pure function.
 */

/** Floor below which a slippage budget is too tight to be meaningful (matches the panel's
 *  lowest preset, 100 bps = 1%). Never derive a bps value below this from a $ input. */
export const MIN_FLOOR_BPS = 100

/** Ceiling — mirrors the immutable on-chain cap (types.ts MAX_ORDER_SLIPPAGE_BPS). Duplicated
 *  here as a literal (not imported) so this module has zero dependency on existing exports,
 *  per the chore's "no edits to existing config exports" scope — callers should pass the real
 *  MAX_ORDER_SLIPPAGE_BPS constant as `maxBps` when precision matters (defaults to 500 here). */
export const DEFAULT_MAX_BPS = 500

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * Convert a whole-DCA dollar budget into the per-fill `maxSlippageBps` the panel already
 * signs. `totalNotionalUsd` is the total $ value of the whole DCA (not per-chunk) — the budget
 * is a total-execution-cost concept, but slippage bps is scale-invariant, so
 * `budget / notional` is the correct ratio regardless of chunk count.
 *
 * Non-finite / non-positive `totalNotionalUsd` (unpriced token, empty input) returns null —
 * callers must fall back to the existing bps default in that case, never sign against a
 * fabricated ratio.
 */
export function budgetUsdToBps(
  totalNotionalUsd: number,
  budgetUsd: number,
  opts?: { minFloorBps?: number; maxBps?: number },
): number | null {
  if (!Number.isFinite(totalNotionalUsd) || totalNotionalUsd <= 0) return null
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return null
  const minFloorBps = opts?.minFloorBps ?? MIN_FLOOR_BPS
  const maxBps = opts?.maxBps ?? DEFAULT_MAX_BPS
  const raw = Math.round((budgetUsd / totalNotionalUsd) * 10_000)
  return clamp(raw, minFloorBps, maxBps)
}

/**
 * Inverse — the whole-DCA $ figure a given bps value implies, for display ("up to $B total").
 * Returns null under the same unpriced/invalid conditions as budgetUsdToBps.
 */
export function bpsToBudgetUsd(totalNotionalUsd: number, bps: number): number | null {
  if (!Number.isFinite(totalNotionalUsd) || totalNotionalUsd <= 0) return null
  if (!Number.isFinite(bps) || bps < 0) return null
  return (bps / 10_000) * totalNotionalUsd
}
