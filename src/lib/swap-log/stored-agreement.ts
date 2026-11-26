/**
 * [ADR-029 section 4 and 8.5] Does a row written BEFORE ADR-029 agree with what the chain says its transaction did?
 *
 * Such a row holds what its caller DECLARED (tokens, amounts, symbols, and main stored the caller's USD whenever the
 * server could not price a token). Marking it verified makes those stored values public once the flag is on, and only
 * the two verification columns (and, for a confirmation, the status) may be written on it. So it is marked only when
 * what it stores agrees with the receipt (owner's answer of 2026-11-25 for the stored-rows script; owner's answer of
 * 2026-11-26 applies the same rule to a confirmation that finds such a row, details R of goal 133c):
 *   - the stored status agrees: `confirmed` or `pending` with a confirmed transaction, `failed` with a reverted one;
 *   - both stored token addresses equal the receipt's;
 *   - the stored amount-in equals the receipt's;
 *   - the receipt's amount-out is between 50% and 200% of the stored one (old rows stored the QUOTE, so it is never equal).
 * A side the receipt cannot give counts as differing.
 *
 * The one rule for both callers: scripts/swaps/verify-stored-swaps-lib.ts and src/lib/swap-log/confirm.ts.
 */
import type { DerivedSwap } from '@/lib/swap-verify/verify-swap-on-chain'

/** The receipt's amount-out must be at least half and at most twice the stored (quoted) one. */
export const OUT_RATIO_MIN_NUM = 1n
export const OUT_RATIO_MIN_DEN = 2n
export const OUT_RATIO_MAX_NUM = 2n
export const OUT_RATIO_MAX_DEN = 1n

function text(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/** A stored amount as digits: an integer string, or a numeric with a zero fraction ("1000.00"). null: not an integer. */
function digits(v: unknown): string | null {
  const t = text(v)
  if (t === null) return null
  const whole = /^(\d{1,78})(?:\.0*)?$/.exec(t.trim())
  return whole ? BigInt(whole[1]).toString() : null
}

function ratio4(numerator: bigint, denominator: bigint): string {
  const scaled = (numerator * 10_000n) / denominator
  const whole = scaled / 10_000n
  return `${whole}.${(scaled % 10_000n).toString().padStart(4, '0')}`
}

/** The comparison of one stored row with its receipt. */
export function compareStored(
  row: Record<string, unknown>,
  outcome: 'confirmed' | 'failed',
  derived: DerivedSwap,
): { statusAgrees: boolean; differs: string[]; outRatio: string | null } {
  const status = text(row.status)
  const statusAgrees = outcome === 'confirmed' ? status === 'confirmed' || status === 'pending' : status === 'failed'

  const differs: string[] = []
  const storedIn = text(row.token_in)?.toLowerCase() ?? null
  const storedOut = text(row.token_out)?.toLowerCase() ?? null
  if (derived.tokenIn === null || storedIn !== derived.tokenIn) differs.push('token_in')
  if (derived.tokenOut === null || storedOut !== derived.tokenOut) differs.push('token_out')

  const storedAmountIn = digits(row.amount_in)
  if (derived.amountIn === null || storedAmountIn === null || BigInt(storedAmountIn) !== BigInt(derived.amountIn)) differs.push('amount_in')

  const storedAmountOut = digits(row.amount_out)
  let outRatio: string | null = null
  if (derived.amountOut === null || storedAmountOut === null || BigInt(storedAmountOut) === 0n) {
    differs.push('amount_out')
  } else {
    const got = BigInt(derived.amountOut)
    const quoted = BigInt(storedAmountOut)
    outRatio = ratio4(got, quoted)
    const atLeastHalf = got * OUT_RATIO_MIN_DEN >= quoted * OUT_RATIO_MIN_NUM
    const atMostTwice = got * OUT_RATIO_MAX_DEN <= quoted * OUT_RATIO_MAX_NUM
    if (!atLeastHalf || !atMostTwice) differs.push('amount_out')
  }
  return { statusAgrees, differs, outRatio }
}

/** The stored row agrees with the receipt on every count above. */
export function storedAgrees(row: Record<string, unknown>, outcome: 'confirmed' | 'failed', derived: DerivedSwap): boolean {
  const compared = compareStored(row, outcome, derived)
  return compared.statusAgrees && compared.differs.length === 0
}
