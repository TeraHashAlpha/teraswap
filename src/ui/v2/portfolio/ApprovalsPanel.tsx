'use client'

import { useEffect, useRef, useState } from 'react'
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi } from 'viem'
import type { ApprovalRecord } from '@/hooks/useActiveApprovals'
import { useActiveChainId } from '@/hooks/useChainId'
import { explorerTxUrl } from '@/lib/chains/tokens'
import { Button } from '../primitives'
import { methodLabel, revokeCashUrl, timeSince } from './portfolio-model'

const CAPS = 'font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px]'

/**
 * One approval as a hairline row (round7 44 / m06) — v1 `RevokeRow`: `TOKEN → spender`, the allowance kind · age, and the revoke control:
 * Revoke → Revoking… / Confirming… → ✓ Revoked ↗ (the revoke tx on the ACTIVE chain, as v1), or Retry after an error.
 *
 * The write is v1's: `approve(spender, 0)` on the token, sent through wagmi's `useWriteContract` ONLY when the user presses Revoke. v1 marks the
 * record revoked DURING render and the row vanishes at once; here the mark happens in an effect and the parent keeps the row listed, so the
 * "✓ Revoked ↗" v1 prints (and its explorer link) is actually readable.
 */
function RevokeRow({ record, onRevoked }: { record: ApprovalRecord; onRevoked: (id: string) => void }) {
  const [revoking, setRevoking] = useState(false)
  const chainId = useActiveChainId()
  const { writeContract, data: revokeHash, error: revokeError, reset: resetRevoke } = useWriteContract()
  const { isSuccess: revokeConfirmed, isLoading: revokeWaiting } = useWaitForTransactionReceipt({ hash: revokeHash })

  // Report the confirmation once per press (a ref, not state: `revoking` stays true and `isPending` below already reads the receipt).
  const reported = useRef(false)
  useEffect(() => {
    if (revokeConfirmed && revoking && !reported.current) {
      reported.current = true
      onRevoked(record.id)
    }
  }, [revokeConfirmed, revoking, onRevoked, record.id])

  const handleRevoke = () => {
    reported.current = false
    setRevoking(true)
    resetRevoke()
    writeContract({ address: record.tokenAddress, abi: erc20Abi, functionName: 'approve', args: [record.spenderAddress, 0n] })
  }
  const isPending = revoking && !revokeConfirmed && !revokeError

  return (
    <li className="ts-pf-approval" data-testid="approval-row" data-approval-id={record.id}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[15px] font-semibold text-v2-text">
          <span>{record.tokenSymbol}</span>
          <span className="text-v2-muted">&rarr;</span>
          <span>{record.spenderLabel}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[13px] text-v2-muted">
          <span>{methodLabel(record.method)}</span>
          <span>&middot;</span>
          <span>{timeSince(record.timestamp)}</span>
        </div>
      </div>

      {revokeConfirmed ? (
        <span className="flex items-center gap-1 text-[13px] font-semibold text-v2-green" data-testid="approval-revoked">
          &#10003; Revoked
          {revokeHash && (
            <a
              href={explorerTxUrl(revokeHash, chainId)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View revoke transaction"
              className="ts-pf-link inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-v2-muted hover:text-v2-text"
            >
              &#8599;
            </a>
          )}
        </span>
      ) : revokeError ? (
        <Button variant="text" tone="danger" onClick={handleRevoke} data-testid="approval-retry">Retry</Button>
      ) : (
        <Button variant="text" tone="danger" onClick={handleRevoke} disabled={isPending} data-pf-action="" data-testid="approval-revoke">
          {isPending ? (revokeWaiting ? 'Confirming…' : 'Revoking…') : 'Revoke'}
        </Button>
      )}
    </li>
  )
}

/**
 * [B8] v1 `ActiveApprovals` (v1 shows it under the Swap box; the round7 Portfolio frames 44 / m06 place it beside the holdings, owner-approved
 * 2026-11-03): the explainer, one row per actionable approval, and the Revoke.cash pointer for approvals outside TeraSwap. Every word is v1's.
 * `rows` is the parent's list (actionable + rows revoked this session); `count` is v1's badge (actionable only).
 */
export function ApprovalsPanel({ rows, count, address, onRevoked }: { rows: readonly ApprovalRecord[]; count: number; address: string | undefined; onRevoked: (id: string) => void }) {
  return (
    <section className="ts-pf-approvals" aria-labelledby="ts-pf-approvals-h" data-testid="approvals-panel">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-v2-amber">&#9888;</span>
        <h3 id="ts-pf-approvals-h" className="text-[16px] font-semibold text-v2-text">Active Approvals</h3>
        <span className={`${CAPS} ml-auto text-v2-amber`} data-testid="approvals-count">{count}</span>
      </div>

      <p className="mt-3 text-[13px] leading-relaxed text-v2-muted">
        These token approvals were made during your swaps and leave a residual allowance.
        Revoking sets the allowance to zero, preventing the spender from accessing your tokens in the future.
      </p>

      <ul className="mt-3" role="list">
        {rows.map((record) => (
          <RevokeRow key={record.id} record={record} onRevoked={onRevoked} />
        ))}
      </ul>

      {address && (
        <p className="ts-pf-approvals-foot text-[12px] leading-relaxed text-v2-dim">
          TeraSwap only shows approvals granted to our contracts. To see Permit2 allowances and approvals granted to other dApps, check{' '}
          <a href={revokeCashUrl(address)} target="_blank" rel="noopener noreferrer" className="ts-pf-link font-semibold text-v2-cream underline underline-offset-4">
            Revoke.cash →
          </a>
        </p>
      )}
    </section>
  )
}
