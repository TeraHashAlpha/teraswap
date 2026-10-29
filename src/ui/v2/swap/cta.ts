/**
 * [ADR-025] The ONE cream CTA's label and state (round7 20 / 21a / 21b / 29). Pure. Order = v1's SwapButton `getConfig`
 * (not connected → wrong network → amount → balance → quoting → no quote → ready), with v1's "Swap" → "Review swap" (the B4
 * review sheet is what the click opens). The click path is B5: this module decides what the button SAYS, never what it does.
 *
 * B5 adds the rest of SwapButton's states, optional so the B3 matrix is unchanged: a price-gate block (v1's `blockReason` copy), the
 * approval / in-flight / complete / retry labels, and — for a split route, which has no single-route review — v1's own
 * `Approve & Swap` / `Swap`.
 */
import type { ApprovalStatus } from '@/hooks/useApproval'
import type { SwapStatus } from '@/hooks/useSwap'
import { blockCopy, type BlockReason } from './lifecycle/gates'

export type CtaKind =
  | 'connect'
  | 'wrong-network'
  | 'enter-amount'
  | 'insufficient-balance'
  | 'finding-route'
  | 'no-quotes'
  | 'review'
  | 'blocked'
  | 'in-flight'
  | 'complete'
  | 'retry'
  | 'split-swap'

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
  /** B5 — price-gate block (SwapBox's `anyBlocked` + `blockReason`). */
  blockReason?: BlockReason
  approvalStatus?: ApprovalStatus
  approvalReady?: boolean
  /** The unified status (single, or the split hook mapped through v1's `splitStatusMap`). */
  swapStatus?: SwapStatus
  /** The best route is a split the user switched on: there is no review sheet, the click is v1's Swap. */
  splitActive?: boolean
}

export interface CtaState {
  kind: CtaKind
  label: string
  disabled: boolean
  /** Only on `blocked`: v1 paints the consent-recoverable blocks amber and the hard ones red. */
  recoverable?: boolean
}

export function ctaFor(i: CtaInput): CtaState {
  if (!i.isConnected) return { kind: 'connect', label: 'Connect wallet', disabled: false }
  if (!i.isCorrectChain) return { kind: 'wrong-network', label: `Switch to ${i.targetChainName}`, disabled: false }
  if (!i.hasAmount) return { kind: 'enter-amount', label: 'Enter amount', disabled: true }
  if (!i.hasSufficientBalance) return { kind: 'insufficient-balance', label: 'Insufficient balance', disabled: true }
  if (i.quoteLoading) return { kind: 'finding-route', label: 'Finding best route...', disabled: true }
  if (!i.hasQuote) return { kind: 'no-quotes', label: 'No quotes available', disabled: true }
  if (i.blockReason) {
    const b = blockCopy(i.blockReason)
    return { kind: 'blocked', label: b.text, disabled: true, recoverable: b.recoverable }
  }
  const inFlight = (label: string): CtaState => ({ kind: 'in-flight', label, disabled: true })
  if (i.approvalStatus === 'approving_permit2') return inFlight('Approving...')
  if (i.approvalStatus === 'signing') return inFlight('Signing...')
  if (i.approvalStatus === 'error') return { kind: 'retry', label: 'Approval error — retry', disabled: false }
  if (i.approvalReady === false) return i.splitActive ? { kind: 'split-swap', label: 'Approve & Swap', disabled: false } : { kind: 'review', label: 'Review swap', disabled: false }
  switch (i.swapStatus) {
    case 'fetching_swap': return inFlight('Preparing swap...')
    case 'simulating': return inFlight('Simulating transaction...')
    case 'confirming': return inFlight('Review transaction...')
    case 'cow_signing': return inFlight('Sign order in wallet...')
    case 'cow_pending': return inFlight('Waiting for solver...')
    case 'swapping': return inFlight('Executing swap...')
    case 'success': return { kind: 'complete', label: 'Swap complete', disabled: true }
    case 'error': return { kind: 'retry', label: 'Error — retry', disabled: false }
  }
  return i.splitActive ? { kind: 'split-swap', label: 'Swap', disabled: false } : { kind: 'review', label: 'Review swap', disabled: false }
}
