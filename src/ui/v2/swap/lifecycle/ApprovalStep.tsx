'use client'

import type { ApprovalStatus } from '@/hooks/useApproval'
import type { SwapStatus } from '@/hooks/useSwap'
import { IN_FLIGHT_STATUSES } from './lifecycle-view'

/**
 * [B5] SwapButton's stepper and approval note, verbatim and under the same conditions: "1. Approve → 2. Swap" while anything is in
 * flight (the approve step bold while approving/signing, green once done, the swap step bold while swapping), the CoW variant
 * "1. Sign → 2. Solver fills", and the exact-approval reassurance whenever an approval is still needed.
 */
export function ApprovalStep({ approvalStatus, approvalReady, swapStatus, showNote }: { approvalStatus: ApprovalStatus; approvalReady: boolean; swapStatus: SwapStatus; showNote: boolean }) {
  const approveActive = approvalStatus === 'approving_permit2' || approvalStatus === 'signing'
  const swapActive = IN_FLIGHT_STATUSES.has(swapStatus)
  const isCow = swapStatus === 'cow_signing' || swapStatus === 'cow_pending'
  const approveDone = approvalReady && (swapActive || swapStatus === 'success')
  const spinning = approveActive || swapActive
  return (
    <div className="mt-4 text-center text-[12px] text-v2-muted" data-testid="approval-step">
      {spinning && !isCow && (
        <div className="flex items-center justify-center gap-2" data-testid="stepper">
          <span className={approveActive ? 'font-bold text-v2-text' : approveDone ? 'text-v2-green' : ''}>1. Approve</span>
          <span aria-hidden="true">→</span>
          <span className={swapActive ? 'font-bold text-v2-text' : ''}>2. Swap</span>
        </div>
      )}
      {isCow && (
        <div className="flex items-center justify-center gap-2" data-testid="cow-stepper">
          <span className={swapStatus === 'cow_signing' ? 'font-bold text-v2-cream' : 'text-v2-green'}>1. Sign</span>
          <span aria-hidden="true">→</span>
          <span className={swapStatus === 'cow_pending' ? 'font-bold text-v2-cream' : ''}>2. Solver fills</span>
        </div>
      )}
      {swapStatus === 'cow_pending' && <p className="mt-1.5 text-[11px]">Your order is MEV-protected. Solvers are competing to fill it at the best price.</p>}
      {showNote && !approvalReady && <p className="mt-2 text-[11px]">Exact approval only — we never request unlimited access to your tokens.</p>}
    </div>
  )
}
