import { useState, useEffect, useCallback, useRef } from 'react'
import {
  useAccount,
  useChainId,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useSignTypedData,
} from 'wagmi'
import { parseUnits, formatUnits, encodeFunctionData, erc20Abi } from 'viem'
import { getPrivateClient } from '@/lib/rpc'
import { validateFeeIntegrity, validateRouterAddress, usesFeeCollector, submitCowOrder, pollCowOrderStatus, type NormalizedQuote } from '@/lib/api'
import { DEFAULT_SLIPPAGE, AGGREGATOR_META, COW_SETTLEMENT, COW_VAULT_RELAYER, COW_MAX_ORDER_DURATION_SEC, FEE_COLLECTOR_ADDRESS, FEE_COLLECTOR_ABI, FEE_BPS, WETH_ADDRESS, type AggregatorName } from '@/lib/constants'
import { isNativeETH, type Token } from '@/lib/tokens'
import { logSwapToSupabase, updateSwapStatus } from '@/lib/analytics'
import { trackWalletActivity } from '@/lib/wallet-activity-tracker'
import { KNOWN_SWAP_SELECTORS } from '@/lib/swap-selectors'
import { validateCallDataRecipient } from '@/lib/calldata-recipient'

// ── Price Guard error (DefiLlama server-side block) ──────
class PriceGuardError extends Error {
  deviation: number
  constructor(message: string, deviation: number) {
    super(message)
    this.name = 'PriceGuardError'
    this.deviation = deviation
  }
}

// ── Pre-swap simulation (ASM equivalent) ─────────────────
// Simulates the transaction via eth_call before sending.
// Catches reverts, insufficient gas, and sandwich attacks.
async function simulateSwapTx(params: {
  to: `0x${string}`
  data: `0x${string}`
  value: bigint
  gas?: bigint
  from: `0x${string}`
  expectedOutput: string
  tokenOut: Token
  source: string
}): Promise<{ success: boolean; gasUsed?: bigint; error?: string }> {
  try {
    const client = getPrivateClient()
    const result = await client.call({
      account: params.from,
      to: params.to,
      data: params.data,
      value: params.value,
      gas: params.gas,
    })
    // If eth_call returns data without reverting, the tx would succeed
    return { success: true, gasUsed: params.gas }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Parse common revert reasons
    if (msg.includes('insufficient funds')) {
      return { success: false, error: 'Insufficient ETH balance for this swap + gas.' }
    }
    if (msg.includes('STF') || msg.includes('TRANSFER_FROM_FAILED')) {
      return { success: false, error: 'Token transfer would fail — check approval or balance.' }
    }
    if (msg.includes('Too little received') || msg.includes('INSUFFICIENT_OUTPUT')) {
      return { success: false, error: 'Swap would fail due to slippage — price moved since quote. Try again.' }
    }
    if (msg.includes('execution reverted')) {
      return { success: false, error: `Simulation reverted: swap would fail on-chain. Try a different route or amount.` }
    }
    // Non-critical simulation failures shouldn't block the swap
    console.warn('[TeraSwap] Simulation inconclusive:', msg)
    return { success: true }
  }
}

// ── Fallback receipt polling ──────────────────────────────
// wagmi's useWaitForTransactionReceipt can stall when the RPC is slow
// or returns transient errors. This manual poller provides a safety net.
const FALLBACK_POLL_INTERVAL = 3_000 // 3 seconds
const FALLBACK_START_DELAY = 8_000   // wait 8s before activating fallback
const SWAP_TIMEOUT_MS = 120_000      // 2 minutes hard timeout

/**
 * Fetch swap calldata via server-side API route (avoids CORS).
 */
async function fetchSwapViaApi(
  source: string, src: string, dst: string, amount: string,
  from: string, slippage: number, srcDecimals: number, dstDecimals: number,
  quoteMeta?: any, chainId?: number,
): Promise<NormalizedQuote> {
  const res = await fetch('/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source, src, dst, amount, from, slippage,
      srcDecimals, dstDecimals, quoteMeta, chainId,
    }),
  })
  const data = await res.json()
  if (!res.ok) {
    // Detect server-side DefiLlama price guard block (HTTP 422)
    if (data.priceGuard) {
      throw new PriceGuardError(
        data.error || 'Swap blocked by server-side price protection.',
        typeof data.deviation === 'number' ? data.deviation : 0,
      )
    }
    throw new Error(data.error || `Swap API error ${res.status}`)
  }
  return data
}

export type SwapStatus =
  | 'idle'
  | 'fetching_swap'
  | 'simulating'
  | 'confirming'        // Waiting for user to review transaction preview
  | 'swapping'
  | 'cow_signing'       // CoW: waiting for user to sign the order
  | 'cow_pending'       // CoW: order submitted, waiting for solver to fill
  | 'success'
  | 'error'

/** Prepared transaction data waiting for user confirmation in the preview modal. */
export interface PendingSwapData {
  source: AggregatorName
  /** Final sendTransaction params */
  txTo: `0x${string}`
  txData: `0x${string}`
  txValue: bigint
  txGas: bigint | undefined
  /** DEX router address (for calldata decoding in preview) */
  routerAddress: string
  /** DEX router calldata (for calldata decoding in preview) */
  routerCalldata: string
  routeViaFeeCollector: boolean
  routeType: 'fee_collector_eth' | 'fee_collector_erc20' | 'direct'
  /** Expected output amount (raw string) */
  swapToAmount: string
  /** Input amount in wei */
  rawAmountBn: bigint
  /** [H-04] FeeCollector-enforced minimum output (raw wei). 0n when not routed via FeeCollector. */
  minimumOutput: bigint
  /** Timestamp when swap flow started */
  swapStartTime: number
}

interface UseSwapResult {
  status: SwapStatus
  txHash: `0x${string}` | undefined
  errorMessage: string | null
  cowOrderUid: string | null
  /** True when DefiLlama server-side oracle blocked the swap (output too far below fair value) */
  priceGuardBlocked: boolean
  /** Oracle deviation that triggered the price guard (e.g. -0.12 = 12% below fair value) */
  priceGuardDeviation: number | null
  /** Pre-swap simulation result: true = passed, false = would revert, null = not yet simulated */
  simulationPassed: boolean | null
  /** Prepared tx data waiting for user confirmation (non-null when status === 'confirming') */
  pendingSwap: PendingSwapData | null
  execute: (source: AggregatorName) => Promise<void>
  /** Confirm the pending swap after reviewing the transaction preview */
  confirmSwap: () => void
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
  const [priceGuardBlocked, setPriceGuardBlocked] = useState(false)
  const [priceGuardDeviation, setPriceGuardDeviation] = useState<number | null>(null)
  const [simulationPassed, setSimulationPassed] = useState<boolean | null>(null) // null = not run yet
  const [pendingSwap, setPendingSwap] = useState<PendingSwapData | null>(null)

  // Q24: Mounted ref to prevent state updates after unmount (polling race condition)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const {
    sendTransaction,
    data: swapHash,
    error: sendError,
    reset: resetSend,
  } = useSendTransaction()

  const {
    signTypedDataAsync,
  } = useSignTypedData()

  const { isSuccess: swapConfirmed } = useWaitForTransactionReceipt({
    hash: swapHash,
    confirmations: 1,
    pollingInterval: 2_000, // poll every 2s (wagmi default is 4s)
  })

  // ── Standard swap flow (1inch, 0x, Velora, Odos, KyberSwap) ──
  const executeStandardSwap = useCallback(async (source: AggregatorName) => {
    if (!tokenIn || !tokenOut || !address || !amountIn) return

    setErrorMessage(null)
    setStatus('fetching_swap')
    const swapStartTime = Date.now()

    // [Wallet Activity] Track swap initiation
    trackWalletActivity(address, {
      category: 'swap', action: 'swap_initiated', source,
      token_in: tokenIn.symbol, token_out: tokenOut.symbol,
      metadata: { amountIn, slippage },
    })

    try {
      const rawAmountBn = parseUnits(amountIn, tokenIn.decimals)
      const routeViaFeeCollector = usesFeeCollector(source)

      // For FeeCollector routing: the contract deducts 0.1% fee first,
      // then forwards the NET amount to the DEX router. So we must build
      // the router calldata for the net amount, not the full amount.
      // This matches the exact amount FeeCollector approves to the router.
      const apiAmountBn = routeViaFeeCollector
        ? rawAmountBn - (rawAmountBn * BigInt(FEE_BPS) / 10000n)
        : rawAmountBn

      const swapData = await fetchSwapViaApi(
        source,
        tokenIn.address,
        tokenOut.address,
        apiAmountBn.toString(),
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

      // [N-05] Validate function selector is a known swap method
      const selector = swapData.tx.data?.slice(0, 10)?.toLowerCase()
      if (selector && !KNOWN_SWAP_SELECTORS.has(selector)) {
        console.warn(`[TeraSwap] Unknown swap selector ${selector} from ${source}. Blocking for safety.`)
        throw new Error(`Unrecognized swap function selector (${selector}). Contact support if this persists.`)
      }

      // [R1] Validate recipient in calldata matches connected wallet
      const recipientCheck = validateCallDataRecipient(swapData.tx.data as string, address)
      if (!recipientCheck.valid) {
        console.error('[R1] Recipient mismatch:', recipientCheck)
        throw new Error(
          `Swap recipient mismatch: calldata would send tokens to ${recipientCheck.extracted?.slice(0, 10)}... instead of your wallet. Swap blocked.`
        )
      }

      // [M-01] Fee integrity check: verify aggregator applied partner fee
      // BLOCKING in production — if the aggregator returns suspicious output
      // (significantly MORE than quoted), the fee may have been bypassed.
      if (quoteToAmount) {
        const feeCheck = validateFeeIntegrity(quoteToAmount, swapData.toAmount, source)
        if (!feeCheck.valid) {
          console.error('[TeraSwap] Fee integrity BLOCKED:', feeCheck.reason)
          throw new Error(
            'Fee verification failed — swap output is unexpectedly high. ' +
            'This may indicate the partner fee was not applied. Swap blocked for safety.'
          )
        }
      }

      // For native ETH swaps, the router needs msg.value = input amount to wrap.
      // Some aggregators (KyberSwap, Odos) route through WETH internally and may
      // return value='0', causing TRANSFER_FROM_FAILED because the router tries
      // transferFrom(WETH) instead of receiving ETH via msg.value.
      const isNativeIn = tokenIn && isNativeETH(tokenIn)
      const apiValue = BigInt(swapData.tx.value || '0')
      // For non-FeeCollector: use apiAmountBn as fallback value for ETH
      // For FeeCollector: txValue is not used (FeeCollector gets full rawAmountBn)
      const txValue = isNativeIn && apiValue === 0n ? apiAmountBn : apiValue

      // ── [H-04] Compute FeeCollector-enforced minimumOutput ──
      // minimumOutput = swap toAmount * (10000 - slippageBps) / 10000.
      // `slippage` is a percentage (0.5 = 0.5%), so slippageBps = slippage * 100.
      // The contract snapshots the user's tokenOut balance pre-swap and reverts
      // via InsufficientOutput(actual, minimum) if the net delta is below this.
      // For ETH output, pass address(0); otherwise the ERC-20 output token address.
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
      const slippageBpsBn = BigInt(Math.max(0, Math.round(slippage * 100)))
      const minimumOutput = slippageBpsBn >= 10_000n
        ? 0n
        : (BigInt(swapData.toAmount) * (10_000n - slippageBpsBn)) / 10_000n
      const tokenOutForFc: `0x${string}` = isNativeETH(tokenOut!)
        ? ZERO_ADDRESS
        : (tokenOut!.address as `0x${string}`)

      // ── FeeCollector routing ──
      // All sources (except 0x/CoW) route through FeeCollector contract.
      // FeeCollector takes 0.1% fee and forwards the net amount to the DEX router.

      // ── Pre-swap simulation (Active Simulation Mechanism) ──
      // Simulates the final transaction via eth_call before wallet prompt.
      // Catches reverts early → saves gas on failed txs.
      {
        const simTo = routeViaFeeCollector
          ? (FEE_COLLECTOR_ADDRESS as `0x${string}`)
          : (swapData.tx.to as `0x${string}`)
        const simData = routeViaFeeCollector
          ? encodeFunctionData({
              abi: FEE_COLLECTOR_ABI,
              functionName: isNativeIn ? 'swapETHWithFee' : 'swapTokenWithFee',
              args: isNativeIn
                ? [swapData.tx.to as `0x${string}`, swapData.tx.data as `0x${string}`, tokenOutForFc, minimumOutput]
                : [tokenIn!.address as `0x${string}`, rawAmountBn, swapData.tx.to as `0x${string}`, swapData.tx.data as `0x${string}`, tokenOutForFc, minimumOutput],
            })
          : (swapData.tx.data as `0x${string}`)
        const simValue = routeViaFeeCollector && isNativeIn
          ? rawAmountBn
          : BigInt(swapData.tx.value || '0')
        const simGas = swapData.tx.gas > 0
          ? BigInt(swapData.tx.gas) + (routeViaFeeCollector ? (isNativeIn ? 100_000n : 120_000n) : 0n)
          : undefined

        setStatus('simulating' as SwapStatus)
        const sim = await simulateSwapTx({
          to: simTo,
          data: simData,
          value: simValue,
          gas: simGas,
          from: address,
          expectedOutput: swapData.toAmount,
          tokenOut: tokenOut!,
          source,
        })
        setSimulationPassed(sim.success)

        if (!sim.success) {
          trackWalletActivity(address, {
            category: 'swap', action: 'swap_simulation_failed', source,
            token_in: tokenIn!.symbol, token_out: tokenOut!.symbol,
            success: false, error_msg: sim.error?.slice(0, 200),
            duration_ms: Date.now() - swapStartTime,
          })
          throw new Error(sim.error || 'Transaction simulation failed — swap would revert on-chain.')
        }
      }

      // ── Build final tx params and show confirmation preview ──
      // Prepare the transaction but pause for user review before signing.
      let pendingTxTo: `0x${string}`
      let pendingTxData: `0x${string}`
      let pendingTxValue: bigint
      let pendingTxGas: bigint | undefined
      let pendingRouteType: PendingSwapData['routeType']

      if (routeViaFeeCollector) {
        const router = swapData.tx.to as `0x${string}`
        const routerData = swapData.tx.data as `0x${string}`

        if (isNativeIn) {
          const feeCollectorCalldata = encodeFunctionData({
            abi: FEE_COLLECTOR_ABI,
            functionName: 'swapETHWithFee',
            args: [router, routerData, tokenOutForFc, minimumOutput],
          })
          pendingTxTo = FEE_COLLECTOR_ADDRESS
          pendingTxData = feeCollectorCalldata
          pendingTxValue = rawAmountBn
          pendingTxGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 100_000n : undefined
          pendingRouteType = 'fee_collector_eth'
        } else {
          // Pre-flight: verify user approved FeeCollector for the full amount
          if (address) {
            try {
              const client = getPrivateClient()
              const allowance = await client.readContract({
                address: tokenIn!.address as `0x${string}`,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [address, FEE_COLLECTOR_ADDRESS],
              })
              if (allowance < rawAmountBn) {
                throw new Error(
                  `Insufficient allowance for ${tokenIn!.symbol}. Please approve the FeeCollector first. ` +
                  `(Have: ${allowance.toString()}, Need: ${rawAmountBn.toString()})`
                )
              }
            } catch (err) {
              if (err instanceof Error && err.message.includes('Insufficient allowance')) throw err
              console.warn('[TeraSwap] Pre-flight FeeCollector allowance check failed:', err)
            }
          }

          const feeCollectorCalldata = encodeFunctionData({
            abi: FEE_COLLECTOR_ABI,
            functionName: 'swapTokenWithFee',
            args: [
              tokenIn!.address as `0x${string}`,
              rawAmountBn,
              router,
              routerData,
              tokenOutForFc,
              minimumOutput,
            ],
          })
          pendingTxTo = FEE_COLLECTOR_ADDRESS
          pendingTxData = feeCollectorCalldata
          pendingTxValue = 0n
          pendingTxGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 120_000n : undefined
          pendingRouteType = 'fee_collector_erc20'
        }
      } else {
        // Direct routing — pre-flight allowance check
        if (!isNativeIn && address) {
          try {
            const client = getPrivateClient()
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
            if (err instanceof Error && err.message.includes('Insufficient allowance')) throw err
            console.warn('[TeraSwap] Pre-flight allowance check failed:', err)
          }
        }

        pendingTxTo = swapData.tx.to as `0x${string}`
        pendingTxData = swapData.tx.data as `0x${string}`
        pendingTxValue = txValue
        pendingTxGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) : undefined
        pendingRouteType = 'direct'
      }

      // Store prepared tx and show confirmation modal
      setPendingSwap({
        source,
        txTo: pendingTxTo,
        txData: pendingTxData,
        txValue: pendingTxValue,
        txGas: pendingTxGas,
        routerAddress: swapData.tx.to,
        routerCalldata: swapData.tx.data,
        routeViaFeeCollector,
        routeType: pendingRouteType,
        swapToAmount: swapData.toAmount,
        rawAmountBn,
        // [H-04] Only populated when routed via FeeCollector — 0x direct and CoW don't apply.
        minimumOutput: routeViaFeeCollector ? minimumOutput : 0n,
        swapStartTime,
      })
      setStatus('confirming')
    } catch (err) {
      setStatus('error')
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      setErrorMessage(errMsg)
      // Detect DefiLlama price guard block
      if (err instanceof PriceGuardError) {
        setPriceGuardBlocked(true)
        setPriceGuardDeviation(err.deviation)
      }
      trackWalletActivity(address, {
        category: 'swap',
        action: err instanceof PriceGuardError ? 'swap_blocked_price_guard' : 'swap_failed',
        source,
        token_in: tokenIn.symbol, token_out: tokenOut.symbol,
        success: false,
        error_code: err instanceof PriceGuardError ? 'price_guard' : undefined,
        error_msg: errMsg.slice(0, 200),
        duration_ms: Date.now() - swapStartTime,
        metadata: err instanceof PriceGuardError ? { deviation: err.deviation } : undefined,
      })
    }
  }, [tokenIn, tokenOut, address, amountIn, slippage, sendTransaction])

  // ── CoW Protocol flow (intent-based, EIP-712 signing) ──
  const executeCowSwap = useCallback(async () => {
    if (!tokenIn || !tokenOut || !address || !amountIn) return

    setErrorMessage(null)
    setStatus('fetching_swap')
    const cowStartTime = Date.now()

    // [Wallet Activity] Track CoW swap initiation
    trackWalletActivity(address, {
      category: 'swap', action: 'swap_initiated', source: 'cowswap',
      token_in: tokenIn.symbol, token_out: tokenOut.symbol,
      metadata: { amountIn, slippage, flow: 'cow' },
    })

    try {
      // ── [FIX] Block native ETH — CoW requires WETH (no ETH-flow support yet) ──
      if (isNativeETH(tokenIn)) {
        throw new Error(
          'CoW Protocol requires WETH, not native ETH. Please wrap your ETH to WETH first, or select a different aggregator.'
        )
      }

      const rawAmountBn = parseUnits(amountIn, tokenIn.decimals)
      const rawAmount = rawAmountBn.toString()

      // ── [FIX] Pre-flight balance check ──
      // CoW orderbook rejects orders when the user doesn't have enough tokens.
      // Check locally first for a better error message.
      // [H-01] Mainnet only — Sepolia removed for production
      const client = getPrivateClient()
      try {
        const balance = await client.readContract({
          address: tokenIn.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        })
        if (balance < rawAmountBn) {
          const have = formatUnits(balance, tokenIn.decimals)
          const need = formatUnits(rawAmountBn, tokenIn.decimals)
          throw new Error(
            `Insufficient ${tokenIn.symbol} balance. You have ${have} but need ${need}.`
          )
        }
      } catch (balErr) {
        // Re-throw our own balance error, ignore RPC errors (let CoW API catch them)
        if (balErr instanceof Error && balErr.message.includes('Insufficient')) throw balErr
        console.warn('[TeraSwap] Pre-flight balance check failed:', balErr)
      }

      // ── [FIX] Pre-flight allowance check ──
      // Verify VaultRelayer has sufficient allowance before signing + submitting.
      try {
        const allowance = await client.readContract({
          address: tokenIn.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, COW_VAULT_RELAYER as `0x${string}`],
        })
        if (allowance < rawAmountBn) {
          const have = formatUnits(allowance, tokenIn.decimals)
          const need = formatUnits(rawAmountBn, tokenIn.decimals)
          throw new Error(
            `Insufficient ${tokenIn.symbol} allowance for CoW VaultRelayer. Approved: ${have}, needed: ${need}. Please approve again.`
          )
        }
      } catch (allowErr) {
        if (allowErr instanceof Error && allowErr.message.includes('Insufficient')) throw allowErr
        console.warn('[TeraSwap] Pre-flight allowance check failed:', allowErr)
      }

      const swapData = await fetchSwapViaApi(
        'cowswap',
        tokenIn.address,
        tokenOut.address,
        rawAmount,
        address,
        slippage,
        tokenIn.decimals,
        tokenOut.decimals,
        undefined,
        chainId,
      )

      if (!swapData.cowOrderParams) {
        throw new Error('CoW Protocol did not return order parameters')
      }

      const orderParams = swapData.cowOrderParams

      // Security: verify receiver matches user wallet (Balancer manageUserBalance lesson)
      const receiver = (orderParams.receiver || '').toLowerCase()
      if (receiver && receiver !== address.toLowerCase()) {
        throw new Error(`CoW order receiver (${receiver}) does not match your wallet. Possible API compromise.`)
      }

      // [L-04] Security: cap validTo to max 30 minutes from now
      // Uses CoW-specific constant (not Permit2) for semantic clarity
      const maxValidTo = Math.floor(Date.now() / 1000) + COW_MAX_ORDER_DURATION_SEC
      if (orderParams.validTo > maxValidTo) {
        orderParams.validTo = maxValidTo
      }

      // Step 1: User signs the order via EIP-712
      setStatus('cow_signing')
      trackWalletActivity(address, {
        category: 'swap', action: 'cow_signing', source: 'cowswap',
        token_in: tokenIn.symbol, token_out: tokenOut.symbol,
        duration_ms: Date.now() - cowStartTime,
      })

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
      const orderUid = await submitCowOrder(orderParams, signature, chainId)
      setCowOrderUid(orderUid)
      trackWalletActivity(address, {
        category: 'swap', action: 'cow_submitted', source: 'cowswap',
        token_in: tokenIn.symbol, token_out: tokenOut.symbol,
        order_id: orderUid,
        duration_ms: Date.now() - cowStartTime,
      })

      // Log CoW swap (fire-and-forget)
      logSwapToSupabase({
        wallet: address,
        chainId,
        source: 'cowswap',
        tokenIn,
        tokenOut,
        amountIn: rawAmount,
        amountOut: orderParams.buyAmount,
        slippage,
        mevProtected: true,
        feeCollected: false,
        status: 'pending',
      })

      // Step 3: Poll for order fulfillment
      const result = await pollCowOrderStatus(orderUid, 120_000, chainId)

      if (result.status === 'fulfilled' && result.txHash) {
        setTxHashState(result.txHash as `0x${string}`)
        setStatus('success')
        trackWalletActivity(address, {
          category: 'swap', action: 'swap_confirmed', source: 'cowswap',
          token_in: tokenIn.symbol, token_out: tokenOut.symbol,
          success: true, tx_hash: result.txHash, order_id: orderUid,
          duration_ms: Date.now() - cowStartTime,
        })
      } else if (result.status === 'cancelled') {
        setStatus('error')
        setErrorMessage('Order was cancelled by the protocol.')
        trackWalletActivity(address, {
          category: 'swap', action: 'cow_cancelled', source: 'cowswap',
          token_in: tokenIn.symbol, token_out: tokenOut.symbol,
          success: false, error_code: 'cancelled', order_id: orderUid,
          duration_ms: Date.now() - cowStartTime,
        })
      } else {
        setStatus('error')
        setErrorMessage('Order expired. No solver filled it within the time limit. Try again or increase slippage.')
        trackWalletActivity(address, {
          category: 'swap', action: 'cow_expired', source: 'cowswap',
          token_in: tokenIn.symbol, token_out: tokenOut.symbol,
          success: false, error_code: 'expired', order_id: orderUid,
          duration_ms: Date.now() - cowStartTime,
        })
      }
    } catch (err) {
      setStatus('error')
      // Detect DefiLlama price guard block in CoW flow too
      if (err instanceof PriceGuardError) {
        setPriceGuardBlocked(true)
        setPriceGuardDeviation(err.deviation)
      }
      let cowErrMsg = 'Unknown error'
      let cowErrCode = 'unknown'
      if (err instanceof Error) {
        const msg = err.message.toLowerCase()
        if (msg.includes('user rejected') || msg.includes('user denied')) {
          cowErrMsg = 'Signature rejected in wallet.'
          cowErrCode = 'user_rejected'
        } else if (msg.includes('funds worth at least') || msg.includes('insufficient balance')) {
          cowErrMsg = `Insufficient balance or allowance for this CoW swap. Ensure you have enough ${tokenIn?.symbol ?? 'tokens'} and have approved the CoW VaultRelayer.`
          cowErrCode = 'insufficient_balance'
        } else if (msg.includes('insufficient') && msg.includes('allowance')) {
          cowErrMsg = err.message
          cowErrCode = 'insufficient_allowance'
        } else {
          cowErrMsg = err.message.slice(0, 200)
          cowErrCode = 'cow_error'
        }
      }
      setErrorMessage(cowErrMsg)
      trackWalletActivity(address!, {
        category: 'swap', action: 'swap_rejected', source: 'cowswap',
        token_in: tokenIn?.symbol, token_out: tokenOut?.symbol,
        success: false, error_code: cowErrCode, error_msg: cowErrMsg.slice(0, 200),
        duration_ms: Date.now() - cowStartTime,
      })
    }
  }, [tokenIn, tokenOut, address, amountIn, slippage, chainId, signTypedDataAsync])

  // ── Main execute dispatcher ──
  const execute = useCallback(async (source: AggregatorName) => {
    if (source === 'cowswap') {
      return executeCowSwap()
    }
    return executeStandardSwap(source)
  }, [executeCowSwap, executeStandardSwap])

  // ── Confirm swap after user reviews transaction preview ──
  const confirmSwap = useCallback(() => {
    const data = pendingSwap
    if (!data || !tokenIn || !tokenOut || !address) return

    // Log swap to Supabase (fire-and-forget)
    logSwapToSupabase({
      wallet: address,
      chainId,
      source: data.source,
      tokenIn,
      tokenOut,
      amountIn: data.rawAmountBn.toString(),
      amountOut: data.swapToAmount,
      slippage,
      mevProtected: AGGREGATOR_META[data.source]?.mevProtected ?? false,
      feeCollected: data.routeViaFeeCollector,
      status: 'pending',
    })

    setStatus('swapping')
    trackWalletActivity(address, {
      category: 'swap', action: 'swap_submitted', source: data.source,
      token_in: tokenIn.symbol, token_out: tokenOut.symbol,
      duration_ms: Date.now() - data.swapStartTime,
      metadata: { routing: data.routeType },
    })

    try {
      sendTransaction({
        to: data.txTo,
        data: data.txData,
        value: data.txValue,
        gas: data.txGas,
      })
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Transaction failed')
    }

    setPendingSwap(null)
  }, [pendingSwap, tokenIn, tokenOut, address, chainId, slippage, sendTransaction])

  // Track standard tx confirmation (wagmi's built-in hook)
  useEffect(() => {
    if (swapConfirmed) {
      setStatus('success')
      if (swapHash) updateSwapStatus(swapHash, 'confirmed', undefined, undefined, address)
      if (address && swapHash) {
        trackWalletActivity(address, {
          category: 'swap', action: 'swap_confirmed',
          token_in: tokenIn?.symbol, token_out: tokenOut?.symbol,
          success: true, tx_hash: swapHash,
        })
      }
    }
  }, [swapConfirmed, swapHash, address])

  // ── Fallback receipt polling ─────────────────────────────
  // If wagmi's useWaitForTransactionReceipt stalls (RPC errors, slow node),
  // we manually poll eth_getTransactionReceipt as a safety net.
  const fallbackTimerRef = useRef<NodeJS.Timeout | null>(null)
  const swapStartTimeRef = useRef<number>(0)

  useEffect(() => {
    // Start tracking time when entering 'swapping' state
    if (status === 'swapping') {
      swapStartTimeRef.current = Date.now()
    }
  }, [status])

  useEffect(() => {
    if (!swapHash || status !== 'swapping') {
      // Clear fallback if status changes or no hash
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
      return
    }

    // Give wagmi's hook a head start, then activate fallback
    const activateTimeout = setTimeout(() => {
      if (status !== 'swapping') return // already resolved

      // Fallback receipt polling activated
      const client = getPrivateClient()

      fallbackTimerRef.current = setInterval(async () => {
        if (!mountedRef.current) { // Q24: stop polling if unmounted
          if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current)
          return
        }
        try {
          const receipt = await client.getTransactionReceipt({ hash: swapHash })
          if (receipt) {
            if (!mountedRef.current) return // Q24: check again after async
            // Fallback detected tx confirmation
            if (receipt.status === 'success') {
              setStatus('success')
              updateSwapStatus(swapHash, 'confirmed', undefined, undefined, address)
              if (address) {
                trackWalletActivity(address, {
                  category: 'swap', action: 'swap_confirmed',
                  success: true, tx_hash: swapHash,
                  metadata: { detection: 'fallback_poll' },
                })
              }
            } else {
              setStatus('error')
              setErrorMessage('Transaction reverted on-chain. Try increasing slippage.')
              updateSwapStatus(swapHash, 'failed', undefined, undefined, address)
              if (address) {
                trackWalletActivity(address, {
                  category: 'swap', action: 'swap_failed',
                  success: false, error_code: 'reverted', tx_hash: swapHash,
                  error_msg: 'Transaction reverted on-chain',
                })
              }
            }
            if (fallbackTimerRef.current) {
              clearInterval(fallbackTimerRef.current)
              fallbackTimerRef.current = null
            }
          }
        } catch {
          // Receipt not available yet — keep polling
        }

        // Hard timeout: after 2 minutes, stop polling and show timeout message
        if (Date.now() - swapStartTimeRef.current > SWAP_TIMEOUT_MS) {
          console.warn('[TeraSwap] Swap timeout reached for', swapHash)
          setStatus('error')
          setErrorMessage(
            `Transaction sent but confirmation is taking too long. ` +
            `Check your wallet or Etherscan for tx: ${swapHash.slice(0, 10)}...`
          )
          if (address) {
            trackWalletActivity(address, {
              category: 'swap', action: 'swap_timeout',
              success: false, error_code: 'timeout', tx_hash: swapHash,
              duration_ms: SWAP_TIMEOUT_MS,
            })
          }
          if (fallbackTimerRef.current) {
            clearInterval(fallbackTimerRef.current)
            fallbackTimerRef.current = null
          }
        }
      }, FALLBACK_POLL_INTERVAL)
    }, FALLBACK_START_DELAY)

    return () => {
      clearTimeout(activateTimeout)
      if (fallbackTimerRef.current) {
        clearInterval(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
    }
  }, [swapHash, status])

  useEffect(() => {
    if (sendError) {
      setStatus('error')
      const parsedErr = parseWagmiError(sendError)
      setErrorMessage(parsedErr)
      if (swapHash) updateSwapStatus(swapHash, 'failed', undefined, undefined, address)
      if (address) {
        const isRejected = sendError.message.toLowerCase().includes('user rejected') ||
          sendError.message.toLowerCase().includes('user denied')
        trackWalletActivity(address, {
          category: 'swap',
          action: isRejected ? 'swap_rejected' : 'swap_failed',
          token_in: tokenIn?.symbol, token_out: tokenOut?.symbol,
          success: false,
          error_code: isRejected ? 'user_rejected' : 'tx_error',
          error_msg: parsedErr.slice(0, 200),
          tx_hash: swapHash,
        })
      }
    }
  }, [sendError, swapHash, address])

  // Merge txHash from both flows
  const txHash = swapHash || txHashState

  const reset = useCallback(() => {
    setStatus('idle')
    setErrorMessage(null)
    setCowOrderUid(null)
    setTxHashState(undefined)
    setPriceGuardBlocked(false)
    setPriceGuardDeviation(null)
    setSimulationPassed(null)
    setPendingSwap(null)
    resetSend()
  }, [resetSend])

  return { status, txHash, errorMessage, cowOrderUid, priceGuardBlocked, priceGuardDeviation, simulationPassed, pendingSwap, execute, confirmSwap, reset }
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
