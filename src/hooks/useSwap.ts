import { useState, useEffect, useCallback } from 'react'
import {
  useAccount,
  useChainId,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useSignTypedData,
} from 'wagmi'
import { parseUnits, erc20Abi, createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { fetchSwapFromSource, validateFeeIntegrity, validateRouterAddress, submitCowOrder, pollCowOrderStatus, type NormalizedQuote } from '@/lib/api'
import { DEFAULT_SLIPPAGE, AGGREGATOR_META, COW_SETTLEMENT, PERMIT2_MAX_DEADLINE_SEC, type AggregatorName } from '@/lib/constants'
import { isNativeETH, type Token } from '@/lib/tokens'

export type SwapStatus =
  | 'idle'
  | 'fetching_swap'
  | 'swapping'
  | 'cow_signing'       // CoW: waiting for user to sign the order
  | 'cow_pending'       // CoW: order submitted, waiting for solver to fill
  | 'success'
  | 'error'

interface UseSwapResult {
  status: SwapStatus
  txHash: `0x${string}` | undefined
  errorMessage: string | null
  cowOrderUid: string | null
  execute: (source: AggregatorName) => Promise<void>
  reset: () => void
}

/**
 * Hook that executes the swap via the winning aggregator.
 * For CoW Protocol, uses EIP-712 signing instead of sendTransaction.
 */
export function useSwap(
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  slippage: number = DEFAULT_SLIPPAGE,
  /** Quote-phase toAmount for fee integrity validation */
  quoteToAmount?: string,
): UseSwapResult {
  const { address } = useAccount()
  const chainId = useChainId()
  const [status, setStatus] = useState<SwapStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [cowOrderUid, setCowOrderUid] = useState<string | null>(null)
  const [txHashState, setTxHashState] = useState<`0x${string}` | undefined>()

  const {
    sendTransaction,
    data: swapHash,
    error: sendError,
    reset: resetSend,
  } = useSendTransaction()

  const {
    signTypedDataAsync,
  } = useSignTypedData()

  const { isSuccess: swapConfirmed } = useWaitForTransactionReceipt({ hash: swapHash })

  // ── Standard swap flow (1inch, 0x, Velora, Odos, KyberSwap) ──
  const executeStandardSwap = useCallback(async (source: AggregatorName) => {
    if (!tokenIn || !tokenOut || !address || !amountIn) return

    setErrorMessage(null)
    setStatus('fetching_swap')

    try {
      const rawAmount = parseUnits(amountIn, tokenIn.decimals).toString()

      const swapData = await fetchSwapFromSource(
        source,
        tokenIn.address,
        tokenOut.address,
        rawAmount,
        address,
        slippage,
        tokenIn.decimals,
        tokenOut.decimals,
      )

      if (!swapData.tx) {
        throw new Error('Aggregator did not return transaction data')
      }

      // Security: validate swap target is a known router (SushiSwap RouteProcessor2 lesson)
      const routerCheck = validateRouterAddress(swapData.tx.to, source)
      if (!routerCheck.valid) {
        throw new Error(routerCheck.reason || 'Swap target address not whitelisted')
      }

      // Security: calldata sanity check (1inch Fusion v1 buffer overflow lesson)
      // Reject abnormally large calldata (>100KB) which may indicate overflow attacks
      const calldataLen = swapData.tx.data?.length ?? 0
      if (calldataLen > 200_000) { // 100KB hex = 200k chars
        throw new Error(`Abnormally large calldata (${Math.round(calldataLen / 2000)}KB). Swap rejected for safety.`)
      }
      if (calldataLen < 10) { // minimum valid calldata: 0x + 4byte selector
        throw new Error('Swap calldata is empty or too short. Possible API error.')
      }

      // Fee integrity check: verify aggregator applied partner fee
      if (quoteToAmount) {
        const feeCheck = validateFeeIntegrity(quoteToAmount, swapData.toAmount, source)
        if (!feeCheck.valid) {
          console.warn('[TeraSwap] Fee integrity warning:', feeCheck.reason)
          // Log but don't block — aggregator may legitimately return better price
          // In production with custom router, this would be enforced on-chain
        }
      }

      // For native ETH swaps, the router needs msg.value = input amount to wrap.
      // Some aggregators (KyberSwap, Odos) route through WETH internally and may
      // return value='0', causing TRANSFER_FROM_FAILED because the router tries
      // transferFrom(WETH) instead of receiving ETH via msg.value.
      const isNativeIn = tokenIn && isNativeETH(tokenIn)
      const rawAmountBn = parseUnits(amountIn, tokenIn!.decimals)
      const apiValue = BigInt(swapData.tx.value || '0')
      const txValue = isNativeIn && apiValue === 0n ? rawAmountBn : apiValue

      // Pre-flight: verify ERC-20 allowance before sending tx (prevents STF reverts)
      if (!isNativeIn && address) {
        try {
          const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || 'https://eth.llamarpc.com'
          const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
          const allowance = await client.readContract({
            address: tokenIn!.address as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address, swapData.tx.to as `0x${string}`],
          })
          if (allowance < rawAmountBn) {
            throw new Error(
              `Insufficient allowance for ${tokenIn!.symbol}. Please approve the router first. ` +
              `(Have: ${allowance.toString()}, Need: ${rawAmountBn.toString()})`
            )
          }
        } catch (err) {
          // If it's our own allowance error, rethrow; otherwise log and continue
          if (err instanceof Error && err.message.includes('Insufficient allowance')) throw err
          console.warn('[TeraSwap] Pre-flight allowance check failed:', err)
        }
      }

      setStatus('swapping')
      sendTransaction({
        to: swapData.tx.to,
        data: swapData.tx.data,
        value: txValue,
        gas: swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) : undefined,
      })
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Unknown error')
    }
  }, [tokenIn, tokenOut, address, amountIn, slippage, sendTransaction])

  // ── CoW Protocol flow (intent-based, EIP-712 signing) ──
  const executeCowSwap = useCallback(async () => {
    if (!tokenIn || !tokenOut || !address || !amountIn) return

    setErrorMessage(null)
    setStatus('fetching_swap')

    try {
      const rawAmount = parseUnits(amountIn, tokenIn.decimals).toString()

      const swapData = await fetchSwapFromSource(
        'cowswap',
        tokenIn.address,
        tokenOut.address,
        rawAmount,
        address,
        slippage,
        tokenIn.decimals,
        tokenOut.decimals,
      ) as NormalizedQuote & { cowOrderParams?: any }

      if (!swapData.cowOrderParams) {
        throw new Error('CoW Protocol did not return order parameters')
      }

      const orderParams = swapData.cowOrderParams

      // Security: verify receiver matches user wallet (Balancer manageUserBalance lesson)
      // Prevents API manipulation where funds are routed to attacker's address
      const receiver = (orderParams.receiver || '').toLowerCase()
      if (receiver && receiver !== address.toLowerCase()) {
        throw new Error(`CoW order receiver (${receiver}) does not match your wallet. Possible API compromise.`)
      }

      // Security: cap validTo to max 30 minutes from now
      const maxValidTo = Math.floor(Date.now() / 1000) + PERMIT2_MAX_DEADLINE_SEC
      if (orderParams.validTo > maxValidTo) {
        orderParams.validTo = maxValidTo
      }

      // Step 1: User signs the order via EIP-712
      setStatus('cow_signing')

      const domain = {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId: chainId,
        verifyingContract: COW_SETTLEMENT as `0x${string}`,
      } as const

      const types = {
        Order: [
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'receiver', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'buyAmount', type: 'uint256' },
          { name: 'validTo', type: 'uint32' },
          { name: 'appData', type: 'bytes32' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'kind', type: 'string' },
          { name: 'partiallyFillable', type: 'bool' },
          { name: 'sellTokenBalance', type: 'string' },
          { name: 'buyTokenBalance', type: 'string' },
        ],
      } as const

      const message = {
        sellToken: orderParams.sellToken as `0x${string}`,
        buyToken: orderParams.buyToken as `0x${string}`,
        receiver: (orderParams.receiver || address) as `0x${string}`,
        sellAmount: BigInt(orderParams.sellAmount),
        buyAmount: BigInt(orderParams.buyAmount),
        validTo: orderParams.validTo,
        appData: orderParams.appDataHash as `0x${string}`,
        feeAmount: BigInt(orderParams.feeAmount),
        kind: orderParams.kind,
        partiallyFillable: orderParams.partiallyFillable,
        sellTokenBalance: orderParams.sellTokenBalance,
        buyTokenBalance: orderParams.buyTokenBalance,
      }

      const signature = await signTypedDataAsync({
        domain,
        types,
        primaryType: 'Order',
        message,
      })

      // Step 2: Submit signed order to CoW orderbook
      setStatus('cow_pending')
      const orderUid = await submitCowOrder(orderParams, signature)
      setCowOrderUid(orderUid)

      // Step 3: Poll for order fulfillment
      const result = await pollCowOrderStatus(orderUid)

      if (result.status === 'fulfilled' && result.txHash) {
        setTxHashState(result.txHash as `0x${string}`)
        setStatus('success')
      } else if (result.status === 'cancelled') {
        setStatus('error')
        setErrorMessage('Order was cancelled by the protocol.')
      } else {
        setStatus('error')
        setErrorMessage('Order expired. No solver filled it within the time limit. Try again or increase slippage.')
      }
    } catch (err) {
      setStatus('error')
      if (err instanceof Error) {
        const msg = err.message.toLowerCase()
        if (msg.includes('user rejected') || msg.includes('user denied')) {
          setErrorMessage('Signature rejected in wallet.')
        } else {
          setErrorMessage(err.message.slice(0, 120))
        }
      } else {
        setErrorMessage('Unknown error')
      }
    }
  }, [tokenIn, tokenOut, address, amountIn, slippage, signTypedDataAsync])

  // ── Main execute dispatcher ──
  const execute = useCallback(async (source: AggregatorName) => {
    if (source === 'cowswap') {
      return executeCowSwap()
    }
    return executeStandardSwap(source)
  }, [executeCowSwap, executeStandardSwap])

  // Track standard tx confirmation
  useEffect(() => {
    if (swapConfirmed) setStatus('success')
  }, [swapConfirmed])

  useEffect(() => {
    if (sendError) {
      setStatus('error')
      setErrorMessage(parseWagmiError(sendError))
    }
  }, [sendError])

  // Merge txHash from both flows
  const txHash = swapHash || txHashState

  const reset = useCallback(() => {
    setStatus('idle')
    setErrorMessage(null)
    setCowOrderUid(null)
    setTxHashState(undefined)
    resetSend()
  }, [resetSend])

  return { status, txHash, errorMessage, cowOrderUid, execute, reset }
}

function parseWagmiError(error: Error): string {
  const msg = error.message.toLowerCase()
  if (msg.includes('user rejected') || msg.includes('user denied'))
    return 'Transaction rejected in wallet.'
  if (msg.includes('insufficient funds'))
    return 'Insufficient ETH for gas fees.'
  if (msg.includes('execution reverted'))
    return 'Swap reverted on-chain — price may have moved. Try increasing slippage.'
  if (msg.includes('nonce'))
    return 'Nonce conflict. Reset your wallet nonce or wait a moment.'
  if (msg.includes('intrinsic gas too low') || msg.includes('gas too low'))
    return 'Gas estimate too low. Try again — the network may be congested.'
  if (msg.includes('replacement transaction underpriced'))
    return 'A pending transaction is blocking this swap. Speed it up or wait.'
  if (msg.includes('already known'))
    return 'This transaction was already submitted. Check your wallet.'
  if (msg.includes('timeout') || msg.includes('failed to fetch'))
    return 'Network error. Check your connection and try again.'
  return error.message.slice(0, 150)
}
