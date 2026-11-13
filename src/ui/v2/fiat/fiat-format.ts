/**
 * [feat/ui-v2-fiat-value] `fmtFiat`: a fiat amount in the visitor's chosen currency, DISPLAY ONLY.
 *
 * Built on `@/lib/format` (`fmtUsd` for dollars, `fmtFixed` for the euro body) so the grouping, the 2 decimals and the
 * "below one cent" rule are the ones every other money figure uses. It lives here and not in `src/lib/format.ts` because that file is
 * shared with v1 and this change is v2-only (0 v1 source changes, ADR-025 Decision 1); moving it there later is a one-line change.
 *
 * Returns `null` for a value that cannot be displayed (not a finite number, or negative): the caller then renders nothing. It never
 * returns `$0`, a dash or a placeholder.
 */
import { fmtFixed, fmtUsd } from '@/lib/format'

export type FiatCurrency = 'USD' | 'EUR'

export const FIAT_SYMBOL: Record<FiatCurrency, string> = { USD: '$', EUR: '€' }

export interface FmtFiatOpts {
  /** `≈ ` prefix: the amount lines under Sell and Receive are approximate by nature. */
  approx?: boolean
}

export function fmtFiat(value: number | null | undefined, currency: FiatCurrency, opts: FmtFiatOpts = {}): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const body = currency === 'USD' ? fmtUsd(value) : value > 0 && value < 0.01 ? '<€0.01' : `€${fmtFixed(value, 2)}`
  return opts.approx ? `≈ ${body}` : body
}

/** USD → the chosen currency. `usdPerEur` (USD per 1 EUR) is only read for EUR; a EUR request without a rate returns `null` (never a dollar figure labelled €). */
export function convertUsd(usd: number | null | undefined, currency: FiatCurrency, usdPerEur: number | null): number | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null
  if (currency === 'USD') return usd
  if (usdPerEur === null || !Number.isFinite(usdPerEur) || usdPerEur <= 0) return null
  return usd / usdPerEur
}
