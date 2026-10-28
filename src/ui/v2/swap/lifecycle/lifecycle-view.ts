/**
 * [ADR-025 / B5] Pure view helpers for the swap lifecycle. Everything here is a lookup over v1's own states and v1's own copy:
 * SwapButton's `getConfig` labels, SwapBox's `splitStatusMap` and its success-toast arithmetic. No amount, minimum output or
 * calldata is computed here — those are the hooks'.
 */
import { formatUnits } from 'viem'
import type { MetaQuoteResult } from '@/lib/adapters/types'
import { fmtToken, fmtUsd } from '@/lib/format'
import type { Token } from '@/lib/tokens'
import { safeBigInt } from '@/lib/utils'
import type { ApprovalStatus } from '@/hooks/useApproval'
import type { SwapStatus } from '@/hooks/useSwap'
import type { SplitSwapStatus } from '@/hooks/useSplitSwap'

/** SwapBox's `splitStatusMap`: how the split hook's status reads in the unified single-swap vocabulary. */
export const SPLIT_STATUS_MAP: Record<SplitSwapStatus, SwapStatus> = {
  idle: 'idle',
  executing: 'swapping',
  success: 'success',
  error: 'error',
  partial: 'error',
  planning: 'swapping',
  'awaiting-review': 'confirming',
}

export function effectiveSwapStatus(i: { isSplitActive: boolean; swapStatus: SwapStatus; splitStatus: SplitSwapStatus }): SwapStatus {
  return i.isSplitActive ? (SPLIT_STATUS_MAP[i.splitStatus] ?? 'idle') : i.swapStatus
}

/** Statuses in which the swap is between "Confirm pressed" and "settled" and no review sheet is the thing to look at. */
export const SIGNING_STATUSES: ReadonlySet<SwapStatus> = new Set(['swapping', 'cow_signing', 'cow_pending'])
/** Statuses where the hook is working towards a frozen review (build / simulate). */
export const PREPARING_STATUSES: ReadonlySet<SwapStatus> = new Set(['fetching_swap', 'simulating'])
/** Every status the timeline can sit on while a swap is running (the frozen CoW review included). */
export const TRACKED_STATUSES: ReadonlySet<SwapStatus> = new Set(['fetching_swap', 'simulating', 'confirming', 'swapping', 'cow_awaiting_review', 'cow_signing', 'cow_pending'])
/** Everything that is "in flight" for v1's `isSpinning`. */
export const IN_FLIGHT_STATUSES: ReadonlySet<SwapStatus> = new Set(['fetching_swap', 'simulating', 'confirming', 'swapping', 'cow_signing', 'cow_pending'])

export interface ConfirmButtonState {
  label: string
  disabled: boolean
  /** v1's SwapButton variant, for the one place the colour differs (error → red text). */
  tone: 'primary' | 'loading' | 'error'
  /** What a press does: begin the approval, or (re)run the swap. */
  action: 'approve' | 'swap'
}

/**
 * The review sheet's primary button, in SwapButton's order and with SwapButton's words (approval states first, then the swap
 * states). `Confirm & Sign` is B4's label for "nothing in flight, the approval is done" — v1's button says `Swap` there, and the
 * sheet's own title already says what the click does. A frozen review (`confirming`) is signed by the same label.
 */
export function confirmButtonState(i: { approvalStatus: ApprovalStatus; approvalReady: boolean; swapStatus: SwapStatus }): ConfirmButtonState {
  const busy = (label: string): ConfirmButtonState => ({ label, disabled: true, tone: 'loading', action: 'swap' })
  if (i.approvalStatus === 'approving_permit2') return { ...busy('Approving...'), action: 'approve' }
  if (i.approvalStatus === 'signing') return { ...busy('Signing...'), action: 'approve' }
  if (i.approvalStatus === 'error') return { label: 'Approval error — retry', disabled: false, tone: 'error', action: 'approve' }
  if (!i.approvalReady) return { label: 'Approve & Swap', disabled: false, tone: 'primary', action: 'approve' }
  if (i.swapStatus === 'fetching_swap') return busy('Preparing swap...')
  if (i.swapStatus === 'simulating') return busy('Simulating transaction...')
  if (i.swapStatus === 'cow_signing') return busy('Sign order in wallet...')
  if (i.swapStatus === 'cow_pending') return busy('Waiting for solver...')
  if (i.swapStatus === 'swapping') return busy('Executing swap...')
  if (i.swapStatus === 'error') return { label: 'Error — retry', disabled: false, tone: 'error', action: 'swap' }
  return { label: 'Confirm & Sign', disabled: false, tone: 'primary', action: 'swap' }
}

export interface SuccessSummary {
  /** `2 487.6842`, or `—` for a malformed amount (v1: `successOutDisplay`). */
  outDisplay: string
  /** v1's number for the history row, null when malformed. */
  outNumber: number | null
  /** v1's ` · You saved ~… vs public-mempool execution`, only for a CoW fill with a positive realised surplus; null otherwise. */
  savingsLine: string | null
  realisedSurplusWei: bigint | null
}

/**
 * SwapBox's success-effect arithmetic, unchanged: the received amount is the quote's `toAmount` (v1 shows the quote, not an
 * on-chain delta — no hook exposes the executed amount for a standard swap), and the "you saved" line appears ONLY for a CoW fill
 * whose realised surplus the hook measured (`mevSurplusActualWei`), exactly as the v1 toast does.
 */
export function buildSuccessSummary(i: { meta: MetaQuoteResult; tokenOut: Token; mevSurplusActualWei: bigint | null; tokenOutUsdPrice: number | null }): SuccessSummary {
  const isCowSuccess = i.meta.best.source === 'cowswap'
  const realisedSurplusWei = isCowSuccess && i.mevSurplusActualWei && i.mevSurplusActualWei > 0n ? i.mevSurplusActualWei : null
  let savingsLine: string | null = null
  if (realisedSurplusWei) {
    const surplusTok = Number(formatUnits(realisedSurplusWei, i.tokenOut.decimals))
    if (i.tokenOutUsdPrice != null && surplusTok * i.tokenOutUsdPrice >= 0.01) {
      savingsLine = `You saved ~${fmtUsd(surplusTok * i.tokenOutUsdPrice)} vs public-mempool execution`
    } else if (surplusTok > 0) {
      savingsLine = `You saved ~${fmtToken(surplusTok)} ${i.tokenOut.symbol} vs public-mempool execution`
    }
  }
  const outBig = safeBigInt(i.meta.best.toAmount)
  const outNumber = outBig !== null ? Number(formatUnits(outBig, i.tokenOut.decimals)) : null
  return { outDisplay: outNumber !== null ? fmtToken(outNumber) : '—', outNumber, savingsLine, realisedSurplusWei }
}

// ── The execution timeline (round7 28a / 28b / 28c) ──────────────────────────────────────────────────────────────────────────
// The steps are SwapButton's own labels, in the order the hooks walk them; nothing here is a new word.

export type StepState = 'done' | 'active' | 'todo' | 'failed'
export interface TimelineStep {
  label: string
  state: StepState
}
export type TimelineRoute = 'standard' | 'cow'

const STANDARD_STEPS = ['Preparing swap...', 'Simulating transaction...', 'Review transaction...', 'Executing swap...', 'Swap complete'] as const
const COW_STEPS = ['Preparing swap...', 'Sign order in wallet...', 'Waiting for solver...', 'Swap complete'] as const

/** Which step a hook status sits on. `-1` = not started. A status that belongs to the other route maps to its nearest step. */
function stepIndex(route: TimelineRoute, status: SwapStatus): number {
  if (route === 'cow') {
    return { fetching_swap: 0, simulating: 0, cow_awaiting_review: 0, confirming: 0, cow_signing: 1, cow_pending: 2, swapping: 2, success: 3 }[status as string] ?? -1
  }
  return { fetching_swap: 0, simulating: 1, confirming: 2, cow_awaiting_review: 2, swapping: 3, cow_signing: 3, cow_pending: 3, success: 4 }[status as string] ?? -1
}

/**
 * `lastActive` is the last in-flight status the hook was in before it failed (the card tracks it): a failure is drawn on the step
 * that was running — "Executing swap..." for a revert or a wallet rejection, "Simulating transaction..." for a simulated revert.
 */
export function buildTimeline(i: { route: TimelineRoute; status: SwapStatus; lastActive: SwapStatus }): TimelineStep[] {
  const labels = i.route === 'cow' ? COW_STEPS : STANDARD_STEPS
  const at = i.status === 'error' ? Math.max(0, stepIndex(i.route, i.lastActive)) : stepIndex(i.route, i.status)
  return labels.map((label, n) => {
    let state: StepState
    if (i.status === 'success') state = 'done'
    else if (i.status === 'error') state = n < at ? 'done' : n === at ? 'failed' : 'todo'
    else state = n < at ? 'done' : n === at ? 'active' : 'todo'
    return { label, state }
  })
}

/** SwapBox's `ETHERSCAN_TX` is mainnet-only; the order chain's own explorer, named as its host names itself (Etherscan / Basescan / Arbiscan). */
export function explorerName(blockExplorerUrl: string): string {
  try {
    const sld = new URL(blockExplorerUrl).hostname.split('.').slice(-2, -1)[0] ?? ''
    return sld ? sld[0].toUpperCase() + sld.slice(1) : 'explorer'
  } catch {
    return 'explorer'
  }
}
