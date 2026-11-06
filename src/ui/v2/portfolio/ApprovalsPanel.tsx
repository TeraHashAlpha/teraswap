'use client'

import type { ApprovalRecord } from '@/hooks/useActiveApprovals'
import { REVOKE_COPY, useRevokeApproval } from '@/hooks/useRevokeApproval'
import { Button } from '../primitives'
import { methodLabel, revokeCashUrl, timeSince } from './portfolio-model'

const CAPS = 'font-v2-mono text-[10px] font-semibold uppercase tracking-[1.5px]'

/**
 * One approval as a hairline row (round7 44 / m06) — v1 `RevokeRow`: `TOKEN → spender`, the allowance kind · chain · age, and the
 * action `useRevokeApproval` (shared with v1) decides: Revoke → Revoking… / Confirming… → ✓ Revoked ↗ (the revoke tx on the
 * RECORD's chain), Retry after an error, v1's "Switch to {chain}" when the wallet is on another chain, or — the one addition to
 * v1's copy — the neutral "Network unknown" line for a record whose chain is unknown (no button: it is never revoked blind).
 *
 * The write is v1's: `approve(spender, 0)` on the token, sent through wagmi's `useWriteContract` ONLY when the user presses Revoke,
 * and only with `chainId` = the record's chain. v1 drops a revoked row at once; here the parent keeps it listed so "✓ Revoked ↗"
 * (and its explorer link) is actually readable.
 */
function RevokeRow({ record, onRevoked }: { record: ApprovalRecord; onRevoked: (id: string) => void }) {
  const { action, chainName } = useRevokeApproval(record, onRevoked)

  return (
    <li className="ts-pf-approval" data-testid="approval-row" data-approval-id={record.id} data-chain-id={record.chainId ?? 'unknown'}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[15px] font-semibold text-v2-text">
          <span>{record.tokenSymbol}</span>
          <span className="text-v2-muted">&rarr;</span>
          <span>{record.spenderLabel}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-v2-muted">
          <span>{methodLabel(record.method)}</span>
          {chainName && (
            <>
              <span>&middot;</span>
              <span data-testid="approval-chain">{chainName}</span>
            </>
          )}
          <span>&middot;</span>
          <span>{timeSince(record.timestamp)}</span>
        </div>
      </div>

      {action.kind === 'revoked' ? (
        <span className="flex items-center gap-1 text-[13px] font-semibold text-v2-green" data-testid="approval-revoked">
          {REVOKE_COPY.revoked}
          <a
            href={action.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View revoke transaction"
            className="ts-pf-link inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-v2-muted hover:text-v2-text"
          >
            &#8599;
          </a>
        </span>
      ) : action.kind === 'unknown' ? (
        <span className="max-w-[45%] text-right text-[12px] leading-snug text-v2-muted" data-testid="approval-chain-unknown">{REVOKE_COPY.unknownChain}</span>
      ) : action.kind === 'switch' ? (
        <Button variant="text" onClick={action.onClick} disabled={action.pending} className="!text-v2-amber" data-pf-action="" data-testid="approval-switch">
          {REVOKE_COPY.switchTo(action.chainName)}
        </Button>
      ) : action.kind === 'retry' ? (
        <Button variant="text" tone="danger" onClick={action.onClick} data-testid="approval-retry">{REVOKE_COPY.retry}</Button>
      ) : (
        <Button variant="text" tone="danger" onClick={action.onClick} disabled={action.pending} data-pf-action="" data-testid="approval-revoke">
          {action.pending ? (action.waiting ? REVOKE_COPY.confirming : REVOKE_COPY.revoking) : REVOKE_COPY.revoke}
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
