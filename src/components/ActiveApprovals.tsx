'use client'

import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { erc20Abi } from 'viem'
import { useActiveApprovals, type ApprovalRecord } from '@/hooks/useActiveApprovals'
import { ETHERSCAN_TX } from '@/lib/constants'

function timeSince(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function RevokeRow({ record, onRevoked }: { record: ApprovalRecord; onRevoked: (id: string) => void }) {
  const [revoking, setRevoking] = useState(false)

  const {
    writeContract,
    data: revokeHash,
    error: revokeError,
    reset: resetRevoke,
  } = useWriteContract()

  const { isSuccess: revokeConfirmed, isLoading: revokeWaiting } = useWaitForTransactionReceipt({
    hash: revokeHash,
  })

  // Mark revoked after on-chain confirmation
  if (revokeConfirmed && revoking) {
    onRevoked(record.id)
    setRevoking(false)
  }

  const handleRevoke = () => {
    setRevoking(true)
    resetRevoke()
    writeContract({
      address: record.tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [record.spenderAddress, 0n],
    })
  }

  const isPending = revoking && !revokeConfirmed && !revokeError

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-secondary/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-cream-80">
          <span>{record.tokenSymbol}</span>
          <span className="text-cream-35">&rarr;</span>
          <span className="text-cream-65">{record.spenderLabel}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-cream-35">
          <span>{record.method === 'infinite' ? 'Infinite allowance' : record.method === 'exact' ? 'Exact allowance' : 'Permit2'}</span>
          <span>&middot;</span>
          <span>{timeSince(record.timestamp)}</span>
        </div>
      </div>

      {revokeConfirmed ? (
        <span className="flex items-center gap-1 text-[10px] font-semibold text-success">
          &#10003; Revoked
          {revokeHash && (
            <a href={`${ETHERSCAN_TX}${revokeHash}`} target="_blank" rel="noopener noreferrer" className="text-cream-35 hover:text-cream transition">&#8599;</a>
          )}
        </span>
      ) : revokeError ? (
        <button onClick={handleRevoke} className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1 text-[10px] font-semibold text-danger transition hover:bg-danger/20">
          Retry
        </button>
      ) : (
        <button
          onClick={handleRevoke}
          disabled={isPending}
          className="rounded-lg border border-cream-15 bg-surface-tertiary px-2.5 py-1 text-[10px] font-semibold text-cream-65 transition hover:border-cream-50 hover:text-cream disabled:opacity-50"
        >
          {isPending
            ? revokeWaiting ? 'Confirming…' : 'Revoking…'
            : 'Revoke'
          }
        </button>
      )}
    </div>
  )
}

export default function ActiveApprovals() {
  const { address } = useAccount()
  const { approvals, markRevoked, getActionable } = useActiveApprovals()
  const actionable = getActionable()

  // Don't render at all if no actionable approvals
  if (actionable.length === 0) return null

  return (
    <div className="mt-4 rounded-2xl border border-cream-08 bg-surface-secondary/85 p-4 shadow-xl shadow-black/20 backdrop-blur-lg">
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-warning/15 text-warning text-[10px]">&#9888;</span>
        <span className="text-xs font-semibold text-cream-80">Active Approvals</span>
        <span className="ml-auto rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] font-bold text-warning">{actionable.length}</span>
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-cream-35">
        These token approvals were made during your swaps and leave a residual allowance.
        Revoking sets the allowance to zero, preventing the spender from accessing your tokens in the future.
      </p>

      <div className="space-y-1.5">
        {actionable.map((record) => (
          <RevokeRow key={record.id} record={record} onRevoked={markRevoked} />
        ))}
      </div>

      {/* Revoke.cash link for approvals outside TeraSwap */}
      {address && (
        <div className="mt-3 border-t border-cream-08 pt-3">
          <p className="text-[10px] leading-relaxed text-cream-30">
            TeraSwap only shows approvals granted to our contracts. To see Permit2 allowances and approvals granted to other dApps, check{' '}
            <a
              href={`https://revoke.cash/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-cream-gold underline underline-offset-2 transition hover:text-cream"
            >
              Revoke.cash →
            </a>
          </p>
        </div>
      )}
    </div>
  )
}
