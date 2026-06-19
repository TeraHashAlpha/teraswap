'use client'

/**
 * [CHORE-DCA-APPROVAL-FLOW] useOrderApproval — one-time exact ERC-20 approval gate for the
 * TeraSwapOrderExecutor.
 *
 * The OrderExecutor pulls the input token via a DIRECT ERC-20 allowance to the executor contract
 * (TeraSwapOrderExecutor.sol: `IERC20(order.tokenIn).safeTransferFrom(order.owner, address(this),
 * executeAmount)` — `address(this)` IS the executor, NOT Permit2). Before the EIP-712 order
 * signature, the user must approve the executor for the FULL signed `order.amountIn` (the TOTAL):
 *   - Non-DCA (LIMIT / STOP_LOSS): the executor pulls `order.amountIn` in a single execution.
 *   - DCA: the per-chunk pulls telescope to exactly `order.amountIn` across all `dcaTotal`
 *     executions (cumulative tracking, [HIGH-003 fix]). canExecute only checks ONE chunk
 *     (`amountIn/dcaTotal`), so approving a single chunk would let only the first buy run and the
 *     rest revert InsufficientAllowance — the preflight MUST approve the FULL total.
 *
 * Why a dedicated hook (not useApproval): useApproval throws on a non-allowlisted spender via
 * isTrustedSpender(), and the OrderExecutor is intentionally NOT in TRUSTED_SPENDER_ADDRESSES
 * (the instant-swap trust surface). This hook validates the spender via getOrderExecutor(chainId)
 * instead — the executor IS the order-engine trust boundary — and always does an EXACT approve
 * (NO max-uint), keeping the "no infinite approvals" promise.
 *
 * Chain-aware: the spender (executor) and the input token (order.tokenIn — already remapped to the
 * chain's WETH for native-ETH inputs by useOrderEngine) are both resolved per the FROZEN order's
 * chainId, so the approval target is byte-identical to the contract the order is signed against.
 * Fail-closed: when no executor is deployed on the chain (getOrderExecutor → null) it reports
 * needsApproval=false and isApproved=false, so the modal renders no Approve button against a
 * null/wrong spender (and confirmOrder's own fail-closed guard surfaces the error).
 */

import { useState, useEffect, useCallback } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { erc20Abi } from 'viem'
import { getOrderExecutor } from '@/lib/order-engine'

export type OrderApprovalStatus = 'idle' | 'approving' | 'confirming' | 'ready' | 'error'

export interface UseOrderApprovalResult {
  /** The executor address the input token must be approved to (the spender). null = unwired chain. */
  spender: `0x${string}` | null
  /** Current on-chain allowance (owner → executor) for the input token, or undefined while loading. */
  allowance: bigint | undefined
  /** True when allowance >= the full signed total (no approval needed). */
  isApproved: boolean
  /** True when an approval transaction is still required before signing can be enabled. */
  needsApproval: boolean
  /** Approval lifecycle status. */
  status: OrderApprovalStatus
  /** Last error message, if any. */
  error: string | null
  /** Send the EXACT-total approve(executor, amountIn) tx (NO max-uint), then re-read allowance. */
  approve: () => Promise<void>
}

/**
 * @param tokenIn  The FROZEN order's input token (already chain-resolved WETH for native ETH).
 * @param amountIn The FULL signed total the executor will pull cumulatively (order.amountIn).
 * @param chainId  The chain the order was frozen/signed under (drives spender + allowance read).
 */
export function useOrderApproval(
  tokenIn: `0x${string}` | undefined,
  amountIn: bigint | undefined,
  chainId: number,
): UseOrderApprovalResult {
  const { address } = useAccount()
  const spender = getOrderExecutor(chainId)
  const [status, setStatus] = useState<OrderApprovalStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // ── Allowance read (owner → executor), pinned to the FROZEN order's chain ──
  const enabled = !!address && !!spender && !!tokenIn
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    chainId,
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && spender ? [address, spender] : undefined,
    query: { enabled },
  })

  const isApproved =
    !!spender && allowance !== undefined && amountIn !== undefined && allowance >= amountIn
  // Until the allowance read resolves we treat it as "not yet approved" so the gate stays closed
  // (fail-closed). On an unwired chain (spender === null) there is no valid approve target.
  const needsApproval = !!spender && !isApproved

  // ── Exact approve write (NO max-uint) ──
  const { writeContractAsync } = useWriteContract()
  const [approveHash, setApproveHash] = useState<`0x${string}` | undefined>(undefined)
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({ hash: approveHash })

  const approve = useCallback(async () => {
    // Fail-closed: never approve a null/wrong spender, and never approve max-uint.
    if (!tokenIn || !spender || amountIn === undefined || amountIn <= 0n) return
    setError(null)
    setStatus('approving')
    try {
      const hash = await writeContractAsync({
        chainId,
        address: tokenIn,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amountIn], // EXACT total — never max-uint
      })
      setApproveHash(hash as `0x${string}`)
      setStatus('confirming')
    } catch (err) {
      setStatus('error')
      const msg = err instanceof Error ? err.message.toLowerCase() : ''
      setError(
        msg.includes('user rejected') || msg.includes('user denied')
          ? 'Approval rejected in wallet.'
          : 'Approval failed. Please try again.',
      )
    }
  }, [tokenIn, spender, amountIn, chainId, writeContractAsync])

  // ── Re-read allowance once the approve tx confirms so the gate opens ──
  useEffect(() => {
    if (approveConfirmed) {
      void refetchAllowance()
      setStatus('ready')
    }
  }, [approveConfirmed, refetchAllowance])

  return { spender, allowance, isApproved, needsApproval, status, error, approve }
}
