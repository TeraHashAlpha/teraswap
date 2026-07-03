import { useState, useEffect, useCallback, useRef } from 'react'
import {
  useAccount,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useSignTypedData,
} from 'wagmi'
import { useActiveChainId } from '@/hooks/useChainId'
import { parseUnits, formatUnits, encodeFunctionData, erc20Abi } from 'viem'
import { getPublicClientForChain } from '@/lib/chains/clients'
import { validateFeeIntegrity, validateRouterAddress, usesFeeCollector, submitCowOrder, pollCowOrderStatus, type NormalizedQuote, type QuoteMeta } from '@/lib/api'
import { DEFAULT_SLIPPAGE, AGGREGATOR_META, COW_SETTLEMENT, COW_VAULT_RELAYER, COW_MAX_ORDER_DURATION_SEC, FEE_COLLECTOR_ABI, FEE_BPS, FEE_NATIVE_SOURCES, type AggregatorName } from '@/lib/constants'
import { buildFeeCollectorSwapArgs } from '@/lib/simulation'
import { buildSimulationTx, simulateSwapTx } from '@/lib/swap-simulation'
import { getChainConfig } from '@/lib/chains'
import { deriveMinimumOutput } from '@/lib/minimum-output'
import { isNativeETH, type Token } from '@/lib/tokens'
import type { CowOrderParams } from '@/lib/adapters/types'
import { logSwapToSupabase, updateSwapStatus } from '@/lib/analytics'
import { trackWalletActivity } from '@/lib/wallet-activity-tracker'
import { KNOWN_SWAP_SELECTORS } from '@/lib/swap-selectors'
import { shouldFallbackToNextSource } from '@/lib/swap-fallback'
import { isExecutableSource } from '@/lib/executable-sources'
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
  quoteMeta?: QuoteMeta, chainId?: number,
  /** Output destination — defaults to `from` server-side. Used when the
   *  caller is the FeeCollector contract but tokens must land in the
   *  user's wallet. */
  recipient?: string,
): Promise<NormalizedQuote> {
  const res = await fetch('/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source, src, dst, amount, from, slippage,
      srcDecimals, dstDecimals, quoteMeta, chainId, recipient,
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
  | 'cow_awaiting_review' // [SPRINT-9U U1] CoW order frozen, awaiting the user's review before EIP-712 signing
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
  /** [SPRINT-9R R2] Frozen token snapshot — the Review modal renders the exact pair that was
   *  quoted/built, immune to live token-selector changes while status === 'confirming'. */
  tokenIn: Token
  tokenOut: Token
  /** [H-04] FeeCollector-enforced minimum output (raw wei). 0n when not routed via FeeCollector. */
  minimumOutput: bigint
  /** Timestamp when swap flow started */
  swapStartTime: number
}

/**
 * [SPRINT-9U U1] A frozen CoW order awaiting the user's review before the EIP-712 signature.
 * Phase A (executeCowSwap) builds + validates + FREEZES the EXACT typed-data payload (domain/types/
 * message) plus the orderParams needed to submit; Phase B (confirmCowOrder) signs THIS frozen payload
 * 1:1 — so the review modal renders exactly what the wallet will sign. chainId/account are captured for
 * a synchronous re-check at confirm time (alongside the chain/account-switch reset effects).
 */
export interface PendingCowOrder {
  /** The EXACT EIP-712 payload that will be signed (frozen). */
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>
  message: {
    sellToken: `0x${string}`; buyToken: `0x${string}`; receiver: `0x${string}`
    sellAmount: bigint; buyAmount: bigint; validTo: number; appData: `0x${string}`
    feeAmount: bigint; kind: string; partiallyFillable: boolean
    sellTokenBalance: string; buyTokenBalance: string
  }
  /** For submitCowOrder after signing (no re-fetch). */
  orderParams: CowOrderParams
  /** Frozen pair snapshot for faithful display + logging (immune to live token-selector changes). */
  tokenIn: Token
  tokenOut: Token
  /** Raw input amount (wei string) for logging. */
  rawAmount: string
  /** Settlement contract the order is bound to (domain.verifyingContract) — shown in the modal. */
  settlement: `0x${string}`
  /** Chain + account this order was built/validated for — confirmCowOrder rejects a mismatch. */
  chainId: number
  account: `0x${string}`
  /** Flow start time for duration analytics. */
  startTime: number
}

/** [SPRINT-9O Part B] Surfaced when the best route couldn't execute and the
 *  flow auto-switched to a working source. */
interface SwapFallbackNotice {
  from: AggregatorName
  to: AggregatorName
  reason?: string
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
  /** [P209 / FULL-L-05] True when the simulation was inconclusive (RPC
   *  hiccup / un-parseable error) and the swap proceeded without a
   *  client-side revert guard. UI surfaces a non-blocking "simulation
   *  unavailable" warning; the on-chain minimumOutput still protects funds. */
  simulationSkipped: boolean
  /** [SPRINT-9O Part B] Non-null when the best route failed its pre-swap
   *  simulation (or otherwise couldn't execute) and the flow auto-switched to
   *  a working source. UI surfaces "switched from X to Y". */
  fallbackNotice: SwapFallbackNotice | null
  /** Prepared tx data waiting for user confirmation (non-null when status === 'confirming') */
  pendingSwap: PendingSwapData | null
  /** [SPRINT-9U U1] Frozen CoW order awaiting review (non-null when status === 'cow_awaiting_review'). */
  pendingCowOrder: PendingCowOrder | null
  /** [LP-05] CoW-only: actual output-token surplus over the user's expected
   *  quoted output, raw wei. Populated on successful CoW fulfillment when
   *  the solver delivered more than originally quoted (positive price
   *  improvement). Null on error, on non-CoW swaps, or when the trades
   *  endpoint didn't return an executedBuyAmount. */
  mevSurplusActualWei: bigint | null
  execute: (source: AggregatorName, fallbacks?: AggregatorName[]) => Promise<void>
  /** Confirm the pending swap after reviewing the transaction preview */
  confirmSwap: () => void
  /** [SPRINT-9U U1] Phase B: sign the frozen CoW order + submit. Only runs from 'cow_awaiting_review'. */
  confirmCowOrder: () => Promise<void>
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
  /** [P104 / 13A-L-02] Raw adapter gas USD on the best non-CoW quote for
   *  the same pair. The server clamps + persists this as gas_savings_usd
   *  on CoW swaps; we never trust a client-derived "savings" figure. */
  bestNonCowGasUsd?: number,
): UseSwapResult {
  const { address } = useAccount()
  // [SPRINT-9G G6] Single chain-id source of truth — useActiveChainId() (the
  // wallet/active chain, same as the quote pipeline), NOT wagmi useChainId(),
  // so the chain the swap is simulated + broadcast on always matches the quote.
  const chainId = useActiveChainId()
  const [status, setStatus] = useState<SwapStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [cowOrderUid, setCowOrderUid] = useState<string | null>(null)
  const [txHashState, setTxHashState] = useState<`0x${string}` | undefined>()
  const [priceGuardBlocked, setPriceGuardBlocked] = useState(false)
  const [priceGuardDeviation, setPriceGuardDeviation] = useState<number | null>(null)
  const [simulationPassed, setSimulationPassed] = useState<boolean | null>(null) // null = not run yet
  const [simulationSkipped, setSimulationSkipped] = useState(false) // [P209] inconclusive sim → fail-open warning
  const [pendingSwap, setPendingSwap] = useState<PendingSwapData | null>(null)
  // [SPRINT-9U U1] Frozen CoW order awaiting review before the EIP-712 signature.
  const [pendingCowOrder, setPendingCowOrder] = useState<PendingCowOrder | null>(null)
  const [mevSurplusActualWei, setMevSurplusActualWei] = useState<bigint | null>(null)
  // [SPRINT-9O Part B] Set when a best route reverted its pre-swap sim and we auto-fell back.
  const [fallbackNotice, setFallbackNotice] = useState<SwapFallbackNotice | null>(null)

  // Q24: Mounted ref to prevent state updates after unmount (polling race condition)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // [FULL-M-04] Reset swap state on account switch or disconnect — prevents a
  // stale pendingSwap bound to wallet A from being confirmed under wallet B.
  // Uses a ref comparison so it only fires on an actual address change, never
  // on every render.
  const prevAddressRef = useRef(address)
  useEffect(() => {
    const prev = prevAddressRef.current
    const switched = prev && address && prev !== address
    const disconnected = !address
    if (switched || disconnected) {
      setPendingSwap(null)
      setPendingCowOrder(null) // [SPRINT-9U U1] never sign a CoW order reviewed under wallet A under wallet B
      setStatus('idle')
      setErrorMessage(null)
      setCowOrderUid(null)
      setTxHashState(undefined)
    }
    prevAddressRef.current = address
  }, [address])

  // [P219] Reset swap state on chain switch — a pendingSwap (router calldata,
  // FeeCollector address, minimumOutput) built for chain A must never carry
  // over to chain B. Ref comparison fires only on an actual chain change, so
  // staying on mainnet leaves all existing behaviour untouched.
  const prevChainIdRef = useRef(chainId)
  useEffect(() => {
    if (prevChainIdRef.current !== chainId) {
      setPendingSwap(null)
      setPendingCowOrder(null) // [SPRINT-9U U1] CoW order built for chain A must not be signed on chain B
      setStatus('idle')
      setErrorMessage(null)
      setCowOrderUid(null)
      setTxHashState(undefined)
      setSimulationPassed(null)
      setSimulationSkipped(false)
    }
    prevChainIdRef.current = chainId
  }, [chainId])

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
  // [SPRINT-9O Part B] Ref so the fallback path can re-enter the flow with the
  // next source without listing executeStandardSwap in its own dependency array.
  const executeStandardSwapRef = useRef<((source: AggregatorName, fallbacks?: AggregatorName[]) => Promise<void>) | null>(null)
  const executeStandardSwap = useCallback(async (source: AggregatorName, fallbacks: AggregatorName[] = []) => {
    if (!tokenIn || !tokenOut || !address || !amountIn) return

    setErrorMessage(null)
    setSimulationSkipped(false) // [P209] reset fail-open warning on each new swap
    setStatus('fetching_swap')
    const swapStartTime = Date.now()

    // [Wallet Activity] Track swap initiation
    trackWalletActivity(address, {
      category: 'swap', action: 'swap_initiated', source,
      token_in: tokenIn.symbol, token_out: tokenOut.symbol,
      metadata: { amountIn, slippage },
    })

    try {
      // [CHORE-SUSHI-V7] Defense-in-depth: a quote-only source (not execution-
      // wired on this chain — no SC-04 selector / R1 decoder / on-chain router
      // whitelist) must never reach a wallet prompt. The SwapBox scoping should
      // make this unreachable; throwing here lets the 9O walk continue to the
      // ranked executable fallbacks if a caller slipped one through.
      if (!isExecutableSource(source, chainId)) {
        throw new Error(`${source} is quote-only on this network — it can't settle swaps yet.`)
      }
      const rawAmountBn = parseUnits(amountIn, tokenIn.decimals)
      const routeViaFeeCollector = usesFeeCollector(source, chainId)

      // [P225] Resolve the FeeCollector address for the ACTIVE chain (mainnet
      // resolves to the canonical FeeCollector). Guard the null case defensively
      // — the activation guard should keep us off an unconfigured chain, but
      // never encode a call to the zero address.
      const feeCollectorAddress = getChainConfig(chainId).contracts.feeCollector
      if (routeViaFeeCollector && !feeCollectorAddress) {
        throw new Error(`Swaps via FeeCollector aren't available on chain ${chainId} yet.`)
      }

      // For FeeCollector routing: the contract deducts 0.1% fee first,
      // then forwards the NET amount to the DEX router. So we must build
      // the router calldata for the net amount, not the full amount.
      // This matches the exact amount FeeCollector approves to the router.
      const apiAmountBn = routeViaFeeCollector
        ? rawAmountBn - (rawAmountBn * BigInt(FEE_BPS) / 10000n)
        : rawAmountBn

      // [P139/P140] Sender + recipient switch.
      // When routing via FeeCollector the on-chain msg.sender hitting the
      // DEX router is the FeeCollector contract, so the aggregator must
      // build router calldata expecting FeeCollector as the funds source
      // (which forceApprove()s the router for the net amount). The user
      // wallet becomes the explicit recipient so output still lands there.
      // Helper extracted to src/lib/simulation.ts for unit testing.
      // [W5-I-02] buildFeeCollectorSwapArgs only reads the FeeCollector address
      // on the routeViaFeeCollector=true branch, where the throw above already
      // guarantees it's non-null — so no `?? FEE_COLLECTOR_ADDRESS` fallback.
      const apiArgs = buildFeeCollectorSwapArgs(routeViaFeeCollector, address, feeCollectorAddress!)
      const swapData = await fetchSwapViaApi(
        source,
        tokenIn.address,
        tokenOut.address,
        apiAmountBn.toString(),
        apiArgs.from,
        slippage,
        tokenIn.decimals,
        tokenOut.decimals,
        undefined,
        chainId, // [P219 review] thread active chain (CoW path already did this).
        apiArgs.recipient,
      )

      if (!swapData.tx) {
        throw new Error('Aggregator did not return transaction data')
      }

      // Security: validate swap target is a known router (SushiSwap RouteProcessor2 lesson)
      const routerCheck = validateRouterAddress(swapData.tx.to, source, chainId)
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

      // [R1] Validate recipient in calldata matches connected wallet.
      // [FULL-M-01] On direct routes the FeeCollector is NOT an acceptable
      // recipient — only fee-routed swaps may deliver to it.
      const recipientCheck = validateCallDataRecipient(swapData.tx.data as string, address, routeViaFeeCollector, chainId)
      if (!recipientCheck.valid) {
        console.error('[R1] Recipient mismatch:', recipientCheck)
        throw new Error(
          `Swap recipient mismatch: calldata would send tokens to ${recipientCheck.extracted?.slice(0, 10)}... instead of your wallet. Swap blocked.`
        )
      }

      // [M-01 → P156] Fee integrity check — only for partner-fee sources.
      //
      // There are three fee modes today and the check is only meaningful for
      // one of them:
      //
      //   1. FeeCollector routing (routeViaFeeCollector=true)
      //      Fee is enforced on-chain by the FeeCollector contract. The
      //      aggregator API never sees it, so comparing quote-output (full
      //      input) vs swap-output (net input) produces false positives.
      //
      //   2. Partner fee via API (source ∈ FEE_NATIVE_SOURCES)
      //      The aggregator's own API applies the 0.1% fee on the response.
      //      THIS is what the check was built for — it catches the case
      //      where the partner-fee parameter was silently ignored upstream.
      //
      //   3. No fee at all (source ∈ FEE_INCOMPATIBLE_SOURCES)
      //      Quote and swap both run on the full amount; comparing them is
      //      meaningless and any difference is just routing volatility.
      //
      // The previous guard (!routeViaFeeCollector) conflated cases 2 and 3.
      // Sprint 25D expanded FEE_INCOMPATIBLE_SOURCES to all 11 sources to
      // work around the V1 router whitelist gap, which made case 3 the only
      // path — and triggered the false-positive block on every swap.
      //
      // Gating on FEE_NATIVE_SOURCES restricts the check to case 2 only.
      // FEE_NATIVE_SOURCES is currently empty (no source uses partner-fee
      // mode), so the check is effectively inert; reintroducing a partner-
      // fee integration later automatically re-arms the check via the
      // constants list — no code change needed here.
      const usesPartnerFee = FEE_NATIVE_SOURCES.includes(source)
      if (quoteToAmount && usesPartnerFee) {
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
      // minimumOutput = swap toAmount * (10000 - slippageBps) / 10000 (shared
      // helper, src/lib/minimum-output.ts). The contract snapshots the user's
      // tokenOut balance pre-swap and reverts via InsufficientOutput(actual,
      // minimum) if the net delta is below this. For ETH output, pass
      // address(0); otherwise the ERC-20 output token address.
      // [W2-L-01] A malformed/zero swapData.toAmount on a fee-routed swap now
      // REFUSES the swap (deriveMinimumOutput throws UnusableQuoteError → this
      // try's catch → normal error + 9O fallback walk to the next source)
      // instead of the old 10-L-01 fallback to minimumOutput = 0n, which
      // silently disabled the on-chain InsufficientOutput check.
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
      const minimumOutput = routeViaFeeCollector
        ? deriveMinimumOutput(swapData.toAmount, slippage)
        : 0n
      const tokenOutForFc: `0x${string}` = isNativeETH(tokenOut!)
        ? ZERO_ADDRESS
        : (tokenOut!.address as `0x${string}`)

      // ── FeeCollector routing ──
      // All sources (except 0x/CoW) route through FeeCollector contract.
      // FeeCollector takes 0.1% fee and forwards the net amount to the DEX router.

      // ── Pre-swap simulation (Active Simulation Mechanism) ──
      // Simulates the final transaction via eth_call before wallet prompt.
      // Catches reverts early → saves gas on failed txs.
      // [P207] Tx construction + classification shared with the split-swap
      // path via src/lib/swap-simulation.ts (buildSimulationTx + simulateSwapTx).
      {
        const simTx = buildSimulationTx({
          swapData,
          routeViaFeeCollector,
          isNativeIn: !!isNativeIn,
          tokenIn: tokenIn!,
          tokenOut: tokenOut!,
          rawAmount: rawAmountBn,
          slippage,
          fromAddress: address,
          source,
          chainId, // [P227 review] thread active chain so the sim targets the right FeeCollector + RPC (matches useSplitSwap)
        })

        setStatus('simulating' as SwapStatus)
        const sim = await simulateSwapTx(simTx)
        setSimulationPassed(sim.success)

        // [P209] Inconclusive simulation (RPC hiccup / un-parseable error):
        // the swap proceeds but we flag it so SwapBox can warn the user. NOT
        // fail-closed — the on-chain minimumOutput is the real protection.
        if (sim.success && sim.simulated === false) {
          console.warn('[TeraSwap] Proceeding without simulation confirmation')
          setSimulationSkipped(true)
        }

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
          pendingTxTo = feeCollectorAddress! // [P225] guarded non-null above
          pendingTxData = feeCollectorCalldata
          pendingTxValue = rawAmountBn
          pendingTxGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 100_000n : undefined
          pendingRouteType = 'fee_collector_eth'
        } else {
          // Pre-flight: verify user approved FeeCollector for the full amount
          if (address) {
            try {
              // [SPRINT-9Q] Read the allowance on the ACTIVE chain — getPrivateClient was
              // mainnet-pinned, so on Base this read mainnet and the swap reached the (Base)
              // sim without the real Base-FeeCollector approval. chainId 1 → getPrivateClient.
              const client = getPublicClientForChain(chainId)
              const allowance = await client.readContract({
                address: tokenIn!.address as `0x${string}`,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [address, feeCollectorAddress!],
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
          pendingTxTo = feeCollectorAddress! // [P225] guarded non-null above
          pendingTxData = feeCollectorCalldata
          pendingTxValue = 0n
          pendingTxGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 120_000n : undefined
          pendingRouteType = 'fee_collector_erc20'
        }
      } else {
        // Direct routing — pre-flight allowance check
        if (!isNativeIn && address) {
          try {
            // [SPRINT-9Q] Active-chain allowance read (was mainnet-pinned).
            const client = getPublicClientForChain(chainId)
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
        // [SPRINT-9R R2] Freeze the token pair alongside the calldata so the preview is fully frozen.
        tokenIn: tokenIn!,
        tokenOut: tokenOut!,
        // [H-04] Only populated when routed via FeeCollector — 0x direct and CoW don't apply.
        minimumOutput: routeViaFeeCollector ? minimumOutput : 0n,
        swapStartTime,
      })
      setStatus('confirming')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      // [SPRINT-9O Part B] A best route that reverts the pre-swap simulation
      // (the mainnet Velora→Augustus RouterNotWhitelisted bug) — or otherwise
      // can't execute — must not dead-end the user. Walk to the next-best source
      // that simulates OK. Deliberate price-guard blocks and user-actionable
      // errors (approval needed) stop instead of silently switching.
      if (
        fallbacks.length > 0 &&
        !(err instanceof PriceGuardError) &&
        shouldFallbackToNextSource(err)
      ) {
        const [next, ...rest] = fallbacks
        console.warn(`[9O] ${source} can't execute (${errMsg.slice(0, 80)}) — falling back to ${next}`)
        setFallbackNotice({ from: source, to: next, reason: errMsg })
        return executeStandardSwapRef.current?.(next, rest)
      }
      setStatus('error')
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
  // [SPRINT-9O Part B] Keep the ref pointed at the latest closure for the fallback recursion.
  executeStandardSwapRef.current = executeStandardSwap

  // ── CoW Protocol flow (intent-based, EIP-712 signing) ──
  const executeCowSwap = useCallback(async () => {
    if (!tokenIn || !tokenOut || !address || !amountIn) return

    setErrorMessage(null)
    setSimulationSkipped(false) // [P209] CoW doesn't simulate, but clear any prior warning
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
      // [SPRINT-9Q] Chain-pin the CoW pre-flight reads — CoW supports Base, so the
      // balance/allowance checks must hit the active chain (chainId 1 → mainnet, byte-identical).
      const client = getPublicClientForChain(chainId)
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

      // [SPRINT-9U U1] Phase A ends by building the EXACT EIP-712 payload and FREEZING it for review.
      // The signature (Phase B → confirmCowOrder) is NOT reachable from here — no signTypedData below.
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

      // [SPRINT-9U U1] FREEZE the exact payload for review. confirmCowOrder signs THIS 1:1 — no
      // re-fetch, no rebuild — so the review modal shows precisely what the wallet will sign.
      setPendingCowOrder({
        domain,
        types,
        message,
        orderParams,
        tokenIn,
        tokenOut,
        rawAmount,
        settlement: COW_SETTLEMENT as `0x${string}`,
        chainId,
        account: address,
        startTime: cowStartTime,
      })
      setStatus('cow_awaiting_review')
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
  }, [tokenIn, tokenOut, address, amountIn, slippage, chainId, signTypedDataAsync, bestNonCowGasUsd])

  // ── [SPRINT-9U U1] Phase B: sign the FROZEN CoW order + submit (reachable ONLY via the review modal) ──
  const confirmCowOrder = useCallback(async () => {
    if (status !== 'cow_awaiting_review') return
    const p = pendingCowOrder
    if (!p || !address) return
    // [9R defense] Reject an order reviewed under a different chain/account than the one now connected.
    // The reset effects also close the modal; this holds the invariant synchronously regardless of timing.
    if (p.chainId !== chainId || p.account.toLowerCase() !== address.toLowerCase()) {
      setPendingCowOrder(null)
      setStatus('idle')
      return
    }
    // [SPRINT-9U audit] Freshness: don't waste a signature on an order whose validTo already passed
    // while the review sat open (CoW would reject it on submit anyway). Fail-safe → re-quote.
    if (p.message.validTo <= Math.floor(Date.now() / 1000)) {
      setPendingCowOrder(null)
      setStatus('error')
      setErrorMessage('This MEV-protected order expired before you signed — please re-quote.')
      return
    }

    setStatus('cow_signing')
    trackWalletActivity(address, {
      category: 'swap', action: 'cow_signing', source: 'cowswap',
      token_in: p.tokenIn.symbol, token_out: p.tokenOut.symbol,
      duration_ms: Date.now() - p.startTime,
    })

    try {
      // Sign the EXACT frozen payload (no re-fetch, no rebuild).
      const signature = await signTypedDataAsync({
        domain: p.domain,
        types: p.types,
        primaryType: 'Order',
        message: p.message,
      })

      // Submit signed order to CoW orderbook
      setStatus('cow_pending')
      const orderUid = await submitCowOrder(p.orderParams, signature, p.chainId)
      setCowOrderUid(orderUid)
      trackWalletActivity(address, {
        category: 'swap', action: 'cow_submitted', source: 'cowswap',
        token_in: p.tokenIn.symbol, token_out: p.tokenOut.symbol,
        order_id: orderUid,
        duration_ms: Date.now() - p.startTime,
      })

      logSwapToSupabase({
        wallet: address,
        chainId: p.chainId,
        source: 'cowswap',
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        amountIn: p.rawAmount,
        amountOut: p.orderParams.buyAmount,
        slippage,
        mevProtected: true,
        feeCollected: false,
        status: 'pending',
        bestNonCowGasUsd,
        expectedOutput: p.orderParams.buyAmount,
      })

      // Poll for order fulfillment
      const result = await pollCowOrderStatus(orderUid, 120_000, p.chainId)
      if (result.status === 'fulfilled' && result.txHash) {
        setTxHashState(result.txHash as `0x${string}`)
        setStatus('success')
        let cowSurplusForPatch: string | undefined
        if (result.executedBuyAmount) {
          try {
            const executed = BigInt(result.executedBuyAmount)
            const quoted = BigInt(p.orderParams.buyAmount)
            const surplus = executed - quoted
            setMevSurplusActualWei(surplus > 0n ? surplus : 0n)
            cowSurplusForPatch = surplus > 0n ? surplus.toString() : undefined
          } catch {
            setMevSurplusActualWei(null)
          }
        }
        updateSwapStatus({ txHash: result.txHash, status: 'confirmed', wallet: address, mevSavingsActual: cowSurplusForPatch })
        trackWalletActivity(address, {
          category: 'swap', action: 'swap_confirmed', source: 'cowswap',
          token_in: p.tokenIn.symbol, token_out: p.tokenOut.symbol,
          success: true, tx_hash: result.txHash, order_id: orderUid,
          duration_ms: Date.now() - p.startTime,
        })
      } else if (result.status === 'cancelled') {
        setStatus('error')
        setErrorMessage('Order was cancelled by the protocol.')
        trackWalletActivity(address, { category: 'swap', action: 'cow_cancelled', source: 'cowswap', token_in: p.tokenIn.symbol, token_out: p.tokenOut.symbol, success: false, error_code: 'cancelled', order_id: orderUid, duration_ms: Date.now() - p.startTime })
      } else {
        setStatus('error')
        setErrorMessage('Order expired. No solver filled it within the time limit. Try again or increase slippage.')
        trackWalletActivity(address, { category: 'swap', action: 'cow_expired', source: 'cowswap', token_in: p.tokenIn.symbol, token_out: p.tokenOut.symbol, success: false, error_code: 'expired', order_id: orderUid, duration_ms: Date.now() - p.startTime })
      }
    } catch (err) {
      setStatus('error')
      if (err instanceof PriceGuardError) {
        setPriceGuardBlocked(true)
        setPriceGuardDeviation(err.deviation)
      }
      let cowErrMsg = 'Unknown error'
      let cowErrCode = 'unknown'
      if (err instanceof Error) {
        const msg = err.message.toLowerCase()
        if (msg.includes('user rejected') || msg.includes('user denied')) {
          cowErrMsg = 'Signature rejected in wallet.'; cowErrCode = 'user_rejected'
        } else if (msg.includes('funds worth at least') || msg.includes('insufficient balance')) {
          cowErrMsg = `Insufficient balance or allowance for this CoW swap. Ensure you have enough ${p.tokenIn.symbol} and have approved the CoW VaultRelayer.`; cowErrCode = 'insufficient_balance'
        } else if (msg.includes('insufficient') && msg.includes('allowance')) {
          cowErrMsg = err.message; cowErrCode = 'insufficient_allowance'
        } else {
          cowErrMsg = err.message.slice(0, 200); cowErrCode = 'cow_error'
        }
      }
      setErrorMessage(cowErrMsg)
      trackWalletActivity(address, {
        category: 'swap', action: 'swap_rejected', source: 'cowswap',
        token_in: p.tokenIn.symbol, token_out: p.tokenOut.symbol,
        success: false, error_code: cowErrCode, error_msg: cowErrMsg.slice(0, 200),
        duration_ms: Date.now() - p.startTime,
      })
    }
  }, [status, pendingCowOrder, address, chainId, slippage, bestNonCowGasUsd, signTypedDataAsync])

  // ── Main execute dispatcher ──
  const execute = useCallback(async (source: AggregatorName, fallbacks: AggregatorName[] = []) => {
    setFallbackNotice(null) // [SPRINT-9O] fresh swap — clear any prior auto-switch notice
    if (source === 'cowswap') {
      return executeCowSwap()
    }
    return executeStandardSwap(source, fallbacks)
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
      // [P118] meta.best.toAmount, raw wei pre-slippage. The validator
      // computes surplus = actual - expectedMinOutput, but for ADR-006
      // we want surplus relative to the unmodified quote so we record
      // this separately from amount_out (which already equals toAmount
      // today but is semantically the "logged output" rather than the
      // "quoted output").
      expectedOutput: data.swapToAmount,
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
      if (swapHash) updateSwapStatus({ txHash: swapHash, status: 'confirmed', wallet: address })
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
      // [SPRINT-9Q] Poll the ACTIVE chain — was mainnet-pinned, so a Base tx hash never
      // resolved and the swap hung to the 2-min timeout. chainId 1 → mainnet (unchanged).
      const client = getPublicClientForChain(chainId)

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
              updateSwapStatus({ txHash: swapHash, status: 'confirmed', wallet: address })
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
              updateSwapStatus({ txHash: swapHash, status: 'failed', wallet: address })
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
  }, [swapHash, status, chainId])

  useEffect(() => {
    if (sendError) {
      setStatus('error')
      const parsedErr = parseWagmiError(sendError)
      setErrorMessage(parsedErr)
      if (swapHash) updateSwapStatus({ txHash: swapHash, status: 'failed', wallet: address })
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
    setSimulationSkipped(false)
    setPendingSwap(null)
    setPendingCowOrder(null) // [SPRINT-9U U1]
    setMevSurplusActualWei(null)
    setFallbackNotice(null)
    resetSend()
  }, [resetSend])

  return { status, txHash, errorMessage, cowOrderUid, priceGuardBlocked, priceGuardDeviation, simulationPassed, simulationSkipped, fallbackNotice, pendingSwap, pendingCowOrder, mevSurplusActualWei, execute, confirmSwap, confirmCowOrder, reset }
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
