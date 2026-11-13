'use client'

import { useQuoteChainId } from '@/hooks/useChainId'
import { EUR_RATE_UNAVAILABLE_TITLE } from './eur-rate'
import { setFiatCurrency } from './fiat-preference'
import type { FiatCurrency } from './fiat-format'
import { useFiatDisplay } from './use-fiat-value'

/**
 * [feat/ui-v2-fiat-value] The $ / € switch of the account menu. A labelled group of two text choices (no box: the chosen one carries the
 * hairline underline, as the other text actions do). The choice is stored in localStorage and applies to every approximate fiat figure on
 * the Swap tab. DISPLAY ONLY.
 *
 * Opening the menu probes the euro rate once (an hour-cached read of our own route), so the € choice can be disabled up front with the title
 * "EUR rate unavailable" instead of failing after the click. While the rate is unavailable the dollars are what is shown, whatever was stored.
 */
const OPTIONS: { value: FiatCurrency; symbol: string; name: string }[] = [
  { value: 'USD', symbol: '$', name: 'USD' },
  { value: 'EUR', symbol: '€', name: 'EUR' },
]

export function CurrencySwitch() {
  const chainId = useQuoteChainId()
  const { currency, eurAvailable, eurStatus } = useFiatDisplay(chainId, { probeEur: true })
  return (
    <div role="group" aria-labelledby="v2-currency-label" className="flex items-center justify-between py-2 text-xs">
      <span id="v2-currency-label" className="text-v2-dim">
        Currency
      </span>
      <span className="flex items-center gap-1">
        {OPTIONS.map((o) => {
          const unavailable = o.value === 'EUR' && !eurAvailable
          const selected = currency === o.value
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={selected}
              disabled={unavailable}
              title={unavailable && eurStatus === 'unavailable' ? EUR_RATE_UNAVAILABLE_TITLE : undefined}
              data-currency={o.value}
              onClick={() => setFiatCurrency(o.value)}
              className={`${selected ? 'ts-v2-underline text-v2-cream' : 'text-v2-muted hover:text-v2-text'} min-h-[44px] bg-transparent px-2 font-v2-mono text-[11px] uppercase tracking-[1.5px] disabled:cursor-not-allowed disabled:text-v2-dim`}
            >
              {o.symbol} {o.name}
            </button>
          )
        })}
      </span>
    </div>
  )
}
