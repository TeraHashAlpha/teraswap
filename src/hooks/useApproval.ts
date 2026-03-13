import { useState, useEffect, useCallback } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useSignTypedData } from 'wagmi'
import { erc20Abi, parseUnits } from 'viem'
import { PERMIT2_ADDRESS } from '@/lib/constants'
import { permit2Abi, eip2612DetectionAbi, planApproval, PERMIT2_DOMAIN, PERMIT_SINGLE_TYPES, type ApprovalMethod, type ApprovalPlan } from '@/lib/approvals'
import { isNativeETH, type Token } from '@/lib/tokens'
import { trackWalletActivity } from '@/lib/wallet-activity-tracker'

export type ApprovalStatus = 'idle' | 'checking' | 'approving_permit2' | 'signing' | 'ready' | 'error'

interface UseApprovalResult {
  plan: ApprovalPlan | null
  status: ApprovalStatus
  error: string | null
  /** Call this to execute the necessary approval steps */
  approve: () => Promise<void>
  /** Is the token ready to be swapped? (no further approval needed) */
  isReady: boolean
}

export function useApproval(
  tokenIn: Token | null,
  amountIn: string,
  spenderAddress: `0x${string}` | undefined,
): UseApprovalResult {
  const { address } = useAccount()
  const [plan, setPlan] = useState<ApprovalPlan | null>(null)
  const [status, setStatus] = useState<ApprovalStatus>('idle')
  const [approvalError, setApprovalError] = useState<string | null>(null)

  const isNative = tokenIn ? isNativeETH(tokenIn) : true
  let rawAmount = 0n
  try {
    if (tokenIn && amountIn && Number(amountIn) > 0) {
      rawAmount = parseUnits(amountIn, tokenIn.decimals)
    }
  } catch {
    // Invalid input (e.g. too many decimals) — treat as zero
  }

  // ── Check 1: Does user have allowance to Permit2 contract? ──
  const { data: permit2TokenAllowance } = useReadContract({
    address: tokenIn?.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address!, PERMIT2_ADDRESS],
    query: { enabled: !!address && !!tokenIn && !isNative },
  })

  const hasPermit2Allowance = permit2TokenAllowance !== undefined && permit2TokenAllowance > 0n

  // ── Check 2: Does token support EIP-2612? ──
  const { data: nonces, isError: noncesError } = useReadContract({
    address: tokenIn?.address as `0x${string}`,
    abi: eip2612DetectionAbi,
    functionName: 'nonces',
    args: [address!],
    query: { enabled: !!address && !!tokenIn && !isNative },
  })

  const tokenSupportsEip2612 = nonces !== undefined && !noncesError

  // ── Check 3: Direct allowance to spender (for exact approve) ──
  const { data: directAllowance, refetch: refetchAllowance } = useReadContract({
    address: tokenIn?.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address!, spenderAddress!],
    query: { enabled: !!address && !!spenderAddress && !!tokenIn && !isNative },
  })

  const hasDirectAllowance = directAllowance !== undefined && rawAmount > 0n && directAllowance >= rawAmount

  // ── Plan approval method ──
  useEffect(() => {
    if (!tokenIn || rawAmount === 0n) {
      setPlan(null)
      return
    }

    // If user already has direct allowance to spender, they're ready
    if (hasDirectAllowance || isNative) {
      setPlan({
        method: 'exact',
        needsOnChainApprove: false,
        label: isNative ? 'No approval needed' : 'Existing approval',
        extraGas: 0,
      })
      setStatus('ready')
      return
    }

    // Always use exact approve to the actual spender.
    // Permit2/EIP-2612 paths require swap-level signing integration which most
    // DEX routers don't support. Direct exact approve is universally compatible.
    setPlan({
      method: 'exact',
      needsOnChainApprove: true,
      label: 'Exact approval (1 transaction)',
      extraGas: 46_000,
    })
    setStatus('idle')
  }, [tokenIn, rawAmount, hasPermit2Allowance, tokenSupportsEip2612, hasDirectAllowance, isNative])

  // ── Approve to Permit2 contract (one-time per token) ──
  const {
    writeContract: writeApprovePermit2,
    data: approvePermit2Hash,
    error: approvePermit2Error,
    reset: resetApprovePermit2,
  } = useWriteContract()

  const { isSuccess: permit2ApproveConfirmed } = useWaitForTransactionReceipt({
    hash: approvePermit2Hash,
  })

  // ── Direct exact approve (fallback) ──
  const {
    writeContract: writeExactApprove,
    data: exactApproveHash,
    error: exactApproveError,
    reset: resetExactApprove,
  } = useWriteContract()

  const { isSuccess: exactApproveConfirmed } = useWaitForTransactionReceipt({
    hash: exactApproveHash,
  })

  // ── Execute approval ──
  const approve = useCallback(async () => {
    if (!plan || !tokenIn || !address || rawAmount === 0n) return
    setApprovalError(null)

    // [Wallet Activity] Track approval start
    trackWalletActivity(address, {
      category: 'approval', action: 'approval_started',
      token_in: tokenIn.symbol,
      metadata: { method: plan.method, spender: spenderAddress },
    })

    try {
      if (plan.method === 'permit2' && !hasPermit2Allowance) {
        // Step 1: approve token → Permit2 contract (max, since Permit2 manages permissions)
        setStatus('approving_permit2')
        writeApprovePermit2({
          address: tokenIn.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'approve',
          args: [PERMIT2_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffff')], // uint160 max, not uint256 max
        })
        return // useEffect continues after confirmation
      }

      if (plan.method === 'exact' && plan.needsOnChainApprove && spenderAddress) {
        // Exact approve: ONLY the amount needed, never more
        setStatus('approving_permit2') // reuse status
        writeExactApprove({
          address: tokenIn.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spenderAddress, rawAmount],
        })
        return
      }

      // If permit2 allowance exists or EIP-2612, we sign off-chain later during swap
      setStatus('ready')
    } catch (err) {
      setStatus('error')
      setApprovalError(err instanceof Error ? err.message : 'Approval error')
    }
  }, [plan, tokenIn, address, rawAmount, hasPermit2Allowance, spenderAddress])

  // ── React to approve confirmations ──
  useEffect(() => {
    if (permit2ApproveConfirmed && status === 'approving_permit2') {
      setStatus('ready')
      if (address && tokenIn) {
        trackWalletActivity(address, {
          category: 'approval', action: 'approval_confirmed',
          token_in: tokenIn.symbol, success: true,
          tx_hash: approvePermit2Hash,
          metadata: { method: 'permit2' },
        })
      }
    }
  }, [permit2ApproveConfirmed])

  useEffect(() => {
    if (exactApproveConfirmed) {
      refetchAllowance()
      setStatus('ready')
      if (address && tokenIn) {
        trackWalletActivity(address, {
          category: 'approval', action: 'approval_confirmed',
          token_in: tokenIn.symbol, success: true,
          tx_hash: exactApproveHash,
          metadata: { method: 'exact', spender: spenderAddress },
        })
      }
    }
  }, [exactApproveConfirmed])

  // ── React to errors ──
  useEffect(() => {
    if (approvePermit2Error) {
      setStatus('error')
      const errMsg = parseApprovalError(approvePermit2Error)
      setApprovalError(errMsg)
      if (address && tokenIn) {
        const isRejected = approvePermit2Error.message.toLowerCase().includes('user rejected') ||
          approvePermit2Error.message.toLowerCase().includes('user denied')
        trackWalletActivity(address, {
          category: 'approval',
          action: isRejected ? 'approval_rejected' : 'approval_failed',
          token_in: tokenIn.symbol, success: false,
          error_code: isRejected ? 'user_rejected' : 'tx_error',
          error_msg: errMsg,
        })
      }
    }
    if (exactApproveError) {
      setStatus('error')
      const errMsg = parseApprovalError(exactApproveError)
      setApprovalError(errMsg)
      if (address && tokenIn) {
        const isRejected = exactApproveError.message.toLowerCase().includes('user rejected') ||
          exactApproveError.message.toLowerCase().includes('user denied')
        trackWalletActivity(address, {
          category: 'approval',
          action: isRejected ? 'approval_rejected' : 'approval_failed',
          token_in: tokenIn.symbol, success: false,
          error_code: isRejected ? 'user_rejected' : 'tx_error',
          error_msg: errMsg,
        })
      }
    }
  }, [approvePermit2Error, exactApproveError])

  const isReady = status === 'ready' || isNative || hasDirectAllowance

  return { plan, status, error: approvalError, approve, isReady }
}

function parseApprovalError(error: Error): string {
  const msg = error.message.toLowerCase()
  if (msg.includes('user rejected') || msg.includes('user denied')) {
    return 'Approval rejected in wallet.'
  }
  return 'Approval error. Please try again.'
}
