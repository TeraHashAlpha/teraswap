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

import { useState, useEffect, useCallback, useRef } from 'react'
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

  // ── Exact approve write (NO max-uint) ──
  const { writeContractAsync } = useWriteContract()
  const [approveHash, setApproveHash] = useState<`0x${string}` | undefined>(undefined)
  // [CHORE-DCA-UX-FIXES] Bug 2: pin the receipt watcher to the FROZEN order's chainId so the
  // confirmation fires on the right chain (Base, not the connected/last-used chain). isError lets
  // us surface an on-chain revert / dropped tx as an error instead of hanging.
  const { isSuccess: approveConfirmed, isError: approveReverted } = useWaitForTransactionReceipt({
    hash: approveHash,
    chainId,
  })

  // [CHORE-DCA-UX-FIXES] Bug 2: the on-chain allowance read can lag behind the approve receipt
  // (wagmi/RQ propagation), which previously left needsApproval=true after a confirmed approve — the
  // modal hung on a disabled "Approve" until a tab leave/re-enter forced a fresh read. Record what
  // the confirmed receipt approved (token+spender+amount+chain) and treat THAT as approved
  // immediately, independent of the allowance refetch. Scoped to the exact approved amount so a
  // later, LARGER order still requires a fresh approval (the gate re-closes).
  const [approvedFor, setApprovedFor] = useState<
    { token: string; spender: string; amount: bigint; chainId: number } | null
  >(null)

  const justApproved =
    !!approvedFor &&
    !!tokenIn &&
    !!spender &&
    amountIn !== undefined &&
    approvedFor.token === tokenIn.toLowerCase() &&
    approvedFor.spender === spender.toLowerCase() &&
    approvedFor.chainId === chainId &&
    approvedFor.amount >= amountIn

  const isApproved =
    (!!spender && allowance !== undefined && amountIn !== undefined && allowance >= amountIn) ||
    justApproved
  // Until the allowance read resolves we treat it as "not yet approved" so the gate stays closed
  // (fail-closed). On an unwired chain (spender === null) there is no valid approve target.
  const needsApproval = !!spender && !isApproved

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

  // ── Auto-advance once the approve tx confirms ──
  // We snapshot the order context (token/spender/amount/chain) at the moment of confirmation via a
  // ref, and fire ONLY on the approveConfirmed transition — NOT whenever amountIn changes. So a
  // confirmed approve for one total never silently green-lights a later, larger order (the gate
  // re-closes); a genuinely new approve (new receipt) records afresh. Records the approved context so
  // the gate opens immediately (justApproved) and the modal advances to Sign, AND re-reads the
  // allowance so the on-chain value catches up. We no longer wait on the refetch — that lag was the
  // hang (Bug 2).
  const ctxRef = useRef({ tokenIn, spender, amountIn, chainId })
  ctxRef.current = { tokenIn, spender, amountIn, chainId }
  useEffect(() => {
    if (!approveConfirmed) return
    const c = ctxRef.current
    if (c.tokenIn && c.spender && c.amountIn !== undefined) {
      void refetchAllowance()
      setApprovedFor({
        token: c.tokenIn.toLowerCase(),
        spender: c.spender.toLowerCase(),
        amount: c.amountIn,
        chainId: c.chainId,
      })
      setStatus('ready')
    }
  }, [approveConfirmed, refetchAllowance])

  // ── Surface an on-chain failure (reverted / dropped approve tx) ──
  useEffect(() => {
    if (approveReverted) {
      setStatus('error')
      setError('Approval transaction failed on-chain. Please try again.')
    }
  }, [approveReverted])

  return { spender, allowance, isApproved, needsApproval, status, error, approve }
}
