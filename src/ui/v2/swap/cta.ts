/**
 * [ADR-025] The ONE cream CTA's label and state (round7 20 / 21a / 21b / 29). Pure. Order = v1's SwapButton `getConfig`
 * (not connected → wrong network → amount → balance → quoting → no quote → ready), with v1's "Swap" → "Review swap" (the B4
 * review sheet is what the click opens). The click path is B5: this module decides what the button SAYS, never what it does.
 *
 * Price-gate blocks (oracle / price impact / depeg), approval and in-flight swap labels are v1 states that need the wallet
 * lifecycle; they arrive with B5 and are deliberately not here.
 */
export type CtaKind = 'connect' | 'wrong-network' | 'enter-amount' | 'insufficient-balance' | 'finding-route' | 'no-quotes' | 'review'

export interface CtaInput {
  isConnected: boolean
  /** The wallet is on a supported AND active chain (v1: `!!chain && isChainActive(chain.id)`); only meaningful once connected. */
  isCorrectChain: boolean
  /** The chain the switch button names (v1: the default chain, Ethereum). */
  targetChainName: string
  hasAmount: boolean
  hasSufficientBalance: boolean
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
  if (!i.isCorrectChain) return { kind: 'wrong-network', label: `Switch to ${i.targetChainName}`, disabled: false }
  if (!i.hasAmount) return { kind: 'enter-amount', label: 'Enter amount', disabled: true }
  if (!i.hasSufficientBalance) return { kind: 'insufficient-balance', label: 'Insufficient balance', disabled: true }
  if (i.quoteLoading) return { kind: 'finding-route', label: 'Finding best route...', disabled: true }
  if (!i.hasQuote) return { kind: 'no-quotes', label: 'No quotes available', disabled: true }
  return { kind: 'review', label: 'Review swap', disabled: false }
}
