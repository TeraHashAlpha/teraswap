/**
 * [feat/ui-v2-fiat-value] `useFiatValue(amount, token, chainId)`: the approximate fiat value of an amount of a token, as the text to show
 * under it. DISPLAY ONLY (see `approx-prices.ts` for the boundary this must never cross).
 *
 *   const { text } = useFiatValue('1.5', ethToken, 1)   // text: '≈ $2 105.40', or null
 *
 * `text` is null whenever there is nothing honest to show: no amount, no token, no price, an unpriced token, a zero or malformed amount.
 * The caller renders nothing for null (never `$0`, never a dash).
 */
import type { Token } from '@/lib/tokens'
import { convertUsd, fmtFiat, type FiatCurrency } from './fiat-format'
import { useFiatPreference } from './fiat-preference'
import { useEurRate } from './eur-rate'
import { useApproxUsdPrice } from './approx-prices'

export interface FiatDisplay {
  /** The currency actually used: the stored choice, except EUR falls back to USD while the rate is unavailable. */
  currency: FiatCurrency
  /** USD per 1 EUR; non-null only when `currency` is EUR. */
  usdPerEur: number | null
  /** The visitor's stored choice (what the switch shows). */
  preference: FiatCurrency
  /** The euro option can be used right now. */
  eurAvailable: boolean
}

/** The visitor's currency and, for euros, the rate: one place that decides what every fiat line shows. */
export function useFiatDisplay(chainId: number, opts: { probeEur?: boolean } = {}): FiatDisplay {
  const preference = useFiatPreference()
  const eur = useEurRate(chainId, preference === 'EUR' || opts.probeEur === true)
  if (preference === 'EUR' && eur.status === 'ok') return { currency: 'EUR', usdPerEur: eur.usdPerEur, preference, eurAvailable: true }
  return { currency: 'USD', usdPerEur: null, preference, eurAvailable: eur.status === 'ok' }
}

/** Pure: an amount × a USD price in the chosen currency, as `fmtFiat` text. */
export function fiatText(amount: string | number | null | undefined, usdPrice: number | null, display: Pick<FiatDisplay, 'currency' | 'usdPerEur'>, approx = true): string | null {
  const n = typeof amount === 'string' ? Number(amount.replace(/[\s ,]/g, '')) : amount
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || usdPrice === null) return null
  return fmtFiat(convertUsd(n * usdPrice, display.currency, display.usdPerEur), display.currency, { approx })
}

/** Text only, on purpose: no number leaves this hook for anything to compute with. */
export function useFiatValue(amount: string | number | null | undefined, token: Token | null | undefined, chainId: number): { text: string | null } {
  const price = useApproxUsdPrice(chainId, token?.address)
  const display = useFiatDisplay(chainId)
  return { text: fiatText(amount, price, display) }
}
