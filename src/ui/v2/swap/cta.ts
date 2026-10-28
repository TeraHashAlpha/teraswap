/**
 * [ADR-025] The ONE cream CTA's label and state (round7 20 / 21a / 21b). Pure. Order = v1's SwapButton `getConfig`
 * (not connected → amount → balance → quoting → no quote → ready), with v1's "Swap" → "Review swap" (the B4 review
 * sheet is what the click opens). The click path is B5: this module decides what the button SAYS, never what it does.
 */
export type CtaKind = 'connect' | 'enter-amount' | 'finding-route' | 'no-quotes' | 'review'

export interface CtaInput {
  isConnected: boolean
  hasAmount: boolean
  quoteLoading: boolean
  hasQuote: boolean
}

export interface CtaState {
  kind: CtaKind
  label: string
  disabled: boolean
}

export function ctaFor(i: CtaInput): CtaState {
  if (!i.isConnected) return { kind: 'connect', label: 'Connect wallet', disabled: false }
  if (!i.hasAmount) return { kind: 'enter-amount', label: 'Enter amount', disabled: true }
  if (i.quoteLoading) return { kind: 'finding-route', label: 'Finding best route...', disabled: true }
  if (!i.hasQuote) return { kind: 'no-quotes', label: 'No quotes available', disabled: true }
  return { kind: 'review', label: 'Review swap', disabled: false }
}
