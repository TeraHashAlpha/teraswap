import { useState, useCallback, useRef } from 'react'
import { parseUnits, encodeFunctionData, erc20Abi, createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { useAccount, useChainId, useSendTransaction, useSignTypedData } from 'wagmi'
import {
  validateFeeIntegrity,
  validateRouterAddress,
  usesFeeCollector,
  submitCowOrder,
  pollCowOrderStatus,
  type NormalizedQuote,
} from '@/lib/api'
import {
  DEFAULT_SLIPPAGE,
  FEE_COLLECTOR_ADDRESS,
  FEE_COLLECTOR_ABI,
  FEE_BPS,
  type AggregatorName,
} from '@/lib/constants'
import { isNativeETH, type Token } from '@/lib/tokens'
import { logSwapToSupabase, updateSwapStatus } from '@/lib/analytics'
import type { SplitRoute, SplitLeg } from '@/lib/split-routing-types'

// ── Types ──

export type SplitSwapStatus =
  | 'idle'
  | 'executing'   // currently executing legs
  | 'success'     // all legs completed
  | 'error'       // one or more legs failed
  | 'partial'     // some legs succeeded, some failed

export interface LegStatus {
  source: AggregatorName
  percent: number
  status: 'pending' | 'fetching' | 'signing' | 'confirming' | 'success' | 'error'
  txHash?: `0x${string}`
  error?: string
}

interface UseSplitSwapResult {
  status: SplitSwapStatus
  legs: LegStatus[]
  completedLegs: number
  totalLegs: number
  errorMessage: string | null
  execute: (splitRoute: SplitRoute) => Promise<void>
  reset: () => void
}

// ── Fetch swap calldata ──

async function fetchSwapViaApi(
  source: string, src: string, dst: string, amount: string,
  from: string, slippage: number, srcDecimals: number, dstDecimals: number,
): Promise<NormalizedQuote> {
  const res = await fetch('/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, src, dst, amount, from, slippage, srcDecimals, dstDecimals }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Swap API error ${res.status}`)
  return data
}

// ── Wait for receipt manually ──

async function waitForReceipt(
  txHash: `0x${string}`,
  timeoutMs = 120_000,
): Promise<'success' | 'reverted' | 'timeout'> {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || 'https://eth.llamarpc.com'
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash })
      if (receipt) return receipt.status === 'success' ? 'success' : 'reverted'
    } catch {
      // not mined yet
    }
    await new Promise(r => setTimeout(r, 3_000))
  }
  return 'timeout'
}

/**
 * Hook that executes a split-route swap — multiple sequential transactions
 * across different DEX sources, each handling a portion of the total amount.
 */
export function useSplitSwap(
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  slippage: number = DEFAULT_SLIPPAGE,
): UseSplitSwapResult {
  const { address } = useAccount()
  const chainId = useChainId()
  const { sendTransactionAsync } = useSendTransaction()

  const [status, setStatus] = useState<SplitSwapStatus>('idle')
  const [legs, setLegs] = useState<LegStatus[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const abortRef = useRef(false)

  const completedLegs = legs.filter(l => l.status === 'success').length
  const totalLegs = legs.length

  const updateLeg = useCallback((index: number, update: Partial<LegStatus>) => {
    setLegs(prev => prev.map((l, i) => i === index ? { ...l, ...update } : l))
  }, [])

  const reset = useCallback(() => {
    abortRef.current = true
    setStatus('idle')
    setLegs([])
    setErrorMessage(null)
  }, [])

  const execute = useCallback(async (splitRoute: SplitRoute) => {
    if (!tokenIn || !tokenOut || !address || !amountIn || !splitRoute.isSplit) return

    abortRef.current = false
    setErrorMessage(null)
    setStatus('executing')

    let totalRaw: bigint
    try {
      totalRaw = parseUnits(amountIn, tokenIn.decimals)
    } catch {
      setStatus('error')
      setErrorMessage('Invalid input amount.')
      return
    }

    // Initialize leg statuses
    const initialLegs: LegStatus[] = splitRoute.legs.map(leg => ({
      source: leg.source as AggregatorName,
      percent: leg.percent,
      status: 'pending',
    }))
    setLegs(initialLegs)

    let successCount = 0
    let errorCount = 0

    for (let i = 0; i < splitRoute.legs.length; i++) {
      if (abortRef.current) break

      const leg = splitRoute.legs[i]
      const source = leg.source as AggregatorName
      const legAmount = (totalRaw * BigInt(leg.percent)) / 100n

      try {
        // Step 1: Fetch calldata
        updateLeg(i, { status: 'fetching' })

        const routeViaFeeCollector = usesFeeCollector(source)
        const apiAmount = routeViaFeeCollector
          ? legAmount - (legAmount * BigInt(FEE_BPS) / 10000n)
          : legAmount

        const swapData = await fetchSwapViaApi(
          source,
          tokenIn.address,
          tokenOut.address,
          apiAmount.toString(),
          address,
          slippage,
          tokenIn.decimals,
          tokenOut.decimals,
        )

        if (!swapData.tx) throw new Error('No transaction data returned')

        // Validate router
        const routerCheck = validateRouterAddress(swapData.tx.to, source)
        if (!routerCheck.valid) throw new Error(routerCheck.reason || 'Router not whitelisted')

        // Step 2: Send transaction
        updateLeg(i, { status: 'signing' })

        let txHash: `0x${string}`

        if (routeViaFeeCollector) {
          // Route through FeeCollector
          if (isNativeETH(tokenIn)) {
            const feeCollectorData = encodeFunctionData({
              abi: FEE_COLLECTOR_ABI,
              functionName: 'swapETHWithFee',
              args: [swapData.tx.to as `0x${string}`, swapData.tx.data as `0x${string}`],
            })
            txHash = await sendTransactionAsync({
              to: FEE_COLLECTOR_ADDRESS as `0x${string}`,
              data: feeCollectorData,
              value: legAmount,
              gas: swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 100_000n : undefined,
            })
          } else {
            const feeCollectorData = encodeFunctionData({
              abi: FEE_COLLECTOR_ABI,
              functionName: 'swapTokenWithFee',
              args: [
                tokenIn.address as `0x${string}`,
                legAmount,
                swapData.tx.to as `0x${string}`,
                swapData.tx.data as `0x${string}`,
              ],
            })
            txHash = await sendTransactionAsync({
              to: FEE_COLLECTOR_ADDRESS as `0x${string}`,
              data: feeCollectorData,
              value: 0n,
              gas: swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 120_000n : undefined,
            })
          }
        } else {
          // Direct swap (0x, etc.)
          txHash = await sendTransactionAsync({
            to: swapData.tx.to as `0x${string}`,
            data: swapData.tx.data as `0x${string}`,
            value: BigInt(swapData.tx.value || '0'),
            gas: swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 50_000n : undefined,
          })
        }

        updateLeg(i, { status: 'confirming', txHash })

        // Step 3: Wait for confirmation
        const receipt = await waitForReceipt(txHash)

        if (receipt === 'success') {
          updateLeg(i, { status: 'success' })
          successCount++
          logSwapToSupabase({
            wallet: address,
            chainId,
            source,
            tokenIn,
            tokenOut,
            amountIn: legAmount.toString(),
            amountOut: leg.outputAmount,
            slippage,
            mevProtected: false,
            feeCollected: routeViaFeeCollector,
            status: 'confirmed',
            txHash,
          })
        } else {
          updateLeg(i, { status: 'error', error: receipt === 'reverted' ? 'Transaction reverted' : 'Confirmation timeout' })
          errorCount++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        const isUserReject = msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')
        updateLeg(i, { status: 'error', error: isUserReject ? 'Rejected in wallet' : msg.slice(0, 100) })
        errorCount++

        // If user rejected, abort remaining legs
        if (isUserReject) {
          setErrorMessage('Transaction rejected in wallet.')
          break
        }
      }
    }

    // Final status
    if (successCount === splitRoute.legs.length) {
      setStatus('success')
    } else if (successCount > 0 && errorCount > 0) {
      setStatus('partial')
      setErrorMessage(`${successCount}/${splitRoute.legs.length} legs completed. ${errorCount} failed.`)
    } else {
      setStatus('error')
      if (!errorMessage) setErrorMessage('Split swap failed.')
    }
  }, [tokenIn, tokenOut, address, amountIn, slippage, sendTransactionAsync, updateLeg])

  return {
    status,
    legs,
    completedLegs,
    totalLegs,
    errorMessage,
    execute,
    reset,
  }
}
