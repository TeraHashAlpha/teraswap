'use client'

import { useId } from 'react'
import { useQuoteChainId } from '@/hooks/useChainId'
import { EUR_RATE_UNAVAILABLE_TITLE } from './eur-rate'
import { setFiatCurrency } from './fiat-preference'
import type { FiatCurrency } from './fiat-format'
import { useFiatDisplay } from './use-fiat-value'

/**
 * [feat/ui-v2-fiat-value] The $ / € switch: a labelled group of two text choices (no box: the chosen one carries the hairline underline, as the
 * other text actions do). One preference, one storage key (localStorage `teraswap:v2:fiat-currency`), dollars by default; it applies to every
 * approximate fiat figure on the Swap tab. DISPLAY ONLY.
 *
 * It lives in two places that share everything: the account menu (`variant="menu"`, a row of the popover) and the swap card itself
 * (`variant="card"`, compact, beside the chain name), so a visitor WITHOUT a connected wallet can switch too.
 *
 * Mounting it probes the euro rate once (an hour-cached read of our own route), so the € choice can be disabled up front with the title
 * "EUR rate unavailable" instead of failing after the click. While the rate is unavailable the dollars are what is shown, whatever was stored.
 */
const OPTIONS: { value: FiatCurrency; symbol: string; name: string }[] = [
  { value: 'USD', symbol: '$', name: 'USD' },
  { value: 'EUR', symbol: '€', name: 'EUR' },
]

export function CurrencySwitch({ variant = 'menu' }: { variant?: 'menu' | 'card' }) {
  const chainId = useQuoteChainId()
  const { currency, eurAvailable, eurStatus } = useFiatDisplay(chainId, { probeEur: true })
  const labelId = useId()
  const card = variant === 'card'
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-currency-switch={variant}
      className={card ? 'flex items-center gap-1 font-v2-mono' : 'flex items-center justify-between py-2 text-xs'}
    >
      <span id={labelId} className={card ? 'text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted' : 'text-v2-dim'}>
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
              aria-label={`${o.symbol} ${o.name}`}
              disabled={unavailable}
              title={unavailable && eurStatus === 'unavailable' ? EUR_RATE_UNAVAILABLE_TITLE : undefined}
              data-currency={o.value}
              onClick={() => setFiatCurrency(o.value)}
              className={`${selected ? 'ts-v2-underline text-v2-cream' : 'text-v2-muted hover:text-v2-text'} ${
                card ? 'min-h-[44px] min-w-[32px] px-1.5 text-[13px]' : 'min-h-[44px] px-2 text-[11px] uppercase tracking-[1.5px]'
              } bg-transparent font-v2-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal disabled:cursor-not-allowed disabled:text-v2-dim`}
            >
              {card ? o.symbol : `${o.symbol} ${o.name}`}
            </button>
          )
        })}
      </span>
    </div>
  )
}
