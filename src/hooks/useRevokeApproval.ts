'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi } from 'viem'
import type { ApprovalRecord } from './useActiveApprovals'
import { getChainName } from '@/lib/chains/registry'
import { explorerTxUrl } from '@/lib/chains/tokens'

/**
 * [fix/revoke-chain C2] Revoke is bound to the RECORD's chain, not to whatever chain the wallet is on at click time.
 *
 * Before: both revoke rows (v1 `ActiveApprovals`, v2 `ApprovalsPanel`) sent `approve(spender, 0)` through wagmi with no
 * chain, so the wallet's current chain received it, and the receipt link used `useActiveChainId()` — a Base approval
 * revoked while on Ethereum sent a no-op tx to Ethereum and the row still said "✓ Revoked".
 *
 * Now (one hook, both rows only render what it returns):
 *   - wallet on another chain → the action is v1's switch-network button ("Switch to {chain}", `switchChain({ chainId })`);
 *     the revoke can only be pressed once the wallet reports the record's chain;
 *   - the write carries `chainId: record.chainId` — wagmi passes it to viem as `chain: { id }`, and viem's sendTransaction
 *     asserts the wallet's live chain against it at send time (ChainMismatchError, no tx) — so a chain change between the
 *     press and the signature cannot send it elsewhere; the press handler also refuses when the wallet chain differs;
 *   - the receipt is awaited on the record's chain and its explorer link is the record's chain;
 *   - a record whose chain is unknown (`chainId: undefined`) has no action at all — it is never revoked blind.
 */

export const REVOKE_COPY = {
  revoke: 'Revoke',
  revoking: 'Revoking…',
  confirming: 'Confirming…',
  revoked: '✓ Revoked',
  retry: 'Retry',
  switchTo: (chainName: string) => `Switch to ${chainName}`, // v1 SwapButton's wrong-network label
  /** The one owner-approved addition to v1's copy (content-map delta): a record whose chain is unknown. */
  unknownChain: 'Network unknown: reconnect on the chain where you approved',
} as const

export type RevokeAction =
  /** The record's chain is unknown: no button, the neutral line, never a tx. */
  | { kind: 'unknown' }
  /** The wallet is on another chain: v1's switch-network action for the RECORD's chain. */
  | { kind: 'switch'; chainId: number; chainName: string; pending: boolean; onClick: () => void }
  /** On the record's chain: Revoke (pending = pressed and not yet settled; waiting = tx sent, receipt pending). */
  | { kind: 'revoke'; pending: boolean; waiting: boolean; onClick: () => void }
  /** The write errored (rejected, chain mismatch, or reverted on-chain): v1's Retry; the record stays open. */
  | { kind: 'retry'; onClick: () => void }
  /** Receipt with status success on the record's chain. */
  | { kind: 'revoked'; hash: `0x${string}`; explorerUrl: string }

export interface RevokeApproval {
  action: RevokeAction
  /** Display name of the record's chain (registry name, or "Chain N" for an id the registry does not know); undefined = unknown. */
  chainName: string | undefined
}

export function useRevokeApproval(record: ApprovalRecord, onRevoked: (id: string) => void): RevokeApproval {
  const recordChainId = record.chainId
  const { chain } = useAccount()
  const walletChainId = chain?.id
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContract, data: hash, error: writeError, reset } = useWriteContract()
  const { data: receipt, isLoading: waiting, error: receiptError } = useWaitForTransactionReceipt({
    hash,
    chainId: recordChainId, // the receipt is read on the RECORD's chain, whatever the wallet shows now
    query: { enabled: hash !== undefined && recordChainId !== undefined },
  })
  const [pressed, setPressed] = useState(false)

  // [C3] "revoked" means revoked: only a receipt with status success on the record's chain. The query's own success flag is
  // "a receipt was fetched", which a reverted tx also satisfies — so it is never the condition. wagmi's watcher throws on a
  // reverted receipt (error, no data); a receipt that still reports `reverted` is treated the same: the record stays open.
  const revoked = hash !== undefined && receipt?.status === 'success'
  const failed = Boolean(writeError) || Boolean(receiptError) || receipt?.status === 'reverted'

  // Report the confirmation once per press.
  const reported = useRef(false)
  useEffect(() => {
    if (revoked && pressed && !reported.current) {
      reported.current = true
      onRevoked(record.id)
    }
  }, [revoked, pressed, onRevoked, record.id])

  const onRevoke = useCallback(() => {
    // Never send blind: the record must name its chain and the wallet must be on it.
    if (recordChainId === undefined || walletChainId !== recordChainId) return
    reported.current = false
    setPressed(true)
    reset()
    writeContract({
      chainId: recordChainId, // → viem `chain: { id }`: asserted against the wallet's live chain at send time
      address: record.tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [record.spenderAddress, 0n],
    })
  }, [recordChainId, walletChainId, reset, writeContract, record.tokenAddress, record.spenderAddress])

  const onSwitch = useCallback(() => {
    if (recordChainId === undefined) return
    switchChain({ chainId: recordChainId })
  }, [recordChainId, switchChain])

  const chainName = recordChainId === undefined ? undefined : getChainName(recordChainId)

  let action: RevokeAction
  if (recordChainId === undefined) {
    action = { kind: 'unknown' }
  } else if (revoked && hash) {
    action = { kind: 'revoked', hash, explorerUrl: explorerTxUrl(hash, recordChainId) }
  } else if (pressed && !failed && !revoked) {
    // a press is in flight (wallet prompt or receipt): the tx, if sent, is already on the record's chain
    action = { kind: 'revoke', pending: true, waiting, onClick: onRevoke }
  } else if (walletChainId !== recordChainId) {
    action = { kind: 'switch', chainId: recordChainId, chainName: chainName as string, pending: switching, onClick: onSwitch }
  } else if (failed) {
    action = { kind: 'retry', onClick: onRevoke }
  } else {
    action = { kind: 'revoke', pending: false, waiting: false, onClick: onRevoke }
  }

  return { action, chainName }
}
