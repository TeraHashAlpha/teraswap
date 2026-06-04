import { useState, useCallback, useRef, useEffect } from 'react'
import { parseUnits, encodeFunctionData } from 'viem'
import { getPublicClientForChain } from '@/lib/chains/clients'
import { useAccount, useSendTransaction } from 'wagmi'
import { useActiveChainId } from '@/hooks/useChainId'
import {
  validateFeeIntegrity,
  validateRouterAddress,
  usesFeeCollector,
  type NormalizedQuote,
} from '@/lib/api'
import {
  DEFAULT_SLIPPAGE,
  FEE_COLLECTOR_ABI,
  FEE_BPS,
  type AggregatorName,
} from '@/lib/constants'
import { isNativeETH, type Token } from '@/lib/tokens'
import { logSwapToSupabase } from '@/lib/analytics'
import { safeBigInt } from '@/lib/utils'
import type { SplitRoute } from '@/lib/split-routing-types'
import { KNOWN_SWAP_SELECTORS } from '@/lib/swap-selectors'
import { validateCallDataRecipient } from '@/lib/calldata-recipient'
import { buildSimulationTx, simulateSwapTx } from '@/lib/swap-simulation'
import { getChainConfig } from '@/lib/chains'

// ── Types ──

export type SplitSwapStatus =
  | 'idle'
  | 'planning'        // [SPRINT-9R R1] Phase A — building + validating + simulating every leg
  | 'awaiting-review' // [SPRINT-9R R1] plan frozen, awaiting the user's Review Split Plan confirm
  | 'executing'       // Phase B — signing the reviewed legs
  | 'success'         // all legs completed
  | 'error'           // one or more legs failed
  | 'partial'         // some legs succeeded, some failed

export interface LegStatus {
  source: AggregatorName
  percent: number
  status: 'pending' | 'fetching' | 'simulating' | 'reviewed' | 'signing' | 'confirming' | 'success' | 'error'
  txHash?: `0x${string}`
  error?: string
  /** [P209 / FULL-L-05] false when this leg's pre-flight simulation was
   *  inconclusive (RPC hiccup) and it proceeded without a client-side revert
   *  guard. The on-chain minimumOutput still protects the fill. */
  simulated?: boolean
}

/**
 * [SPRINT-9R R1] A frozen, reviewed split-leg. Phase A builds + validates + simulates
 * each leg and captures the EXACT transaction that will broadcast (txTo/txData/value/gas)
 * plus the inner router calldata for the review decode. Phase B (confirmPlan) signs these
 * 1:1 — no re-fetch — so the wallet only ever receives calldata the user reviewed.
 */
export interface PlannedLeg {
  source: AggregatorName
  percent: number
  /** Input amount (wei) allocated to this leg. */
  legAmount: bigint
  routeViaFeeCollector: boolean
  isNativeIn: boolean
  /** Inner DEX router target + calldata — what the review modal DECODES (mirrors single-swap). */
  routerAddress: string
  routerCalldata: string
  /** The FINAL tx that will be signed (FeeCollector-wrapped or direct). Absent for skipped legs. */
  txTo?: `0x${string}`
  txData?: `0x${string}`
  txValue?: bigint
  txGas?: bigint
  /** FeeCollector-enforced min output (raw wei) for this leg; 0n when not via FeeCollector. */
  legMinOutput: bigint
  /** Frozen expected output (raw string) + the route's leg output (for logging). */
  expectedOut: string
  outputAmount: string
  /** false when this leg's pre-flight sim was inconclusive (fail-open). */
  simulated: boolean
  /** 'reviewed' = passed Phase A, will sign; 'skipped' = failed pre-flight, will NOT sign. */
  status: 'reviewed' | 'skipped'
  error?: string
}

interface UseSplitSwapResult {
  status: SplitSwapStatus
  legs: LegStatus[]
  /** [SPRINT-9R R1] The frozen plan the Review Split Plan modal renders + confirmPlan signs. */
  plannedLegs: PlannedLeg[]
  completedLegs: number
  totalLegs: number
  errorMessage: string | null
  /** Phase A: build + freeze the plan, then await review. NEVER signs. */
  execute: (splitRoute: SplitRoute) => Promise<void>
  /** Phase B: sign the reviewed plan 1:1. Only runs from status 'awaiting-review'. */
  confirmPlan: () => Promise<void>
  reset: () => void
}

// ── Fetch swap calldata ──

async function fetchSwapViaApi(
  source: string, src: string, dst: string, amount: string,
  from: string, slippage: number, srcDecimals: number, dstDecimals: number,
  chainId?: number, // [P221/43-I-01] target chain — undefined → mainnet (identical)
): Promise<NormalizedQuote> {
  const res = await fetch('/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, src, dst, amount, from, slippage, srcDecimals, dstDecimals, chainId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Swap API error ${res.status}`)
  return data
}

// ── Wait for receipt manually ──

async function waitForReceipt(
  txHash: `0x${string}`,
  chainId: number,
  timeoutMs = 120_000,
): Promise<'success' | 'reverted' | 'timeout'> {
  // [SPRINT-9Q] Poll the active chain's client — was mainnet-pinned (getPrivateClient), so a
  // Base leg's receipt never resolved and the leg reported a false "Confirmation timeout".
  // chainId 1 → getPrivateClient (mainnet byte-identical).
  const client = getPublicClientForChain(chainId)
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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

/**
 * Hook that executes a split-route swap — multiple sequential transactions
 * across different DEX sources, each handling a portion of the total amount.
 *
 * [SPRINT-9R R1] Two-phase, review-gated:
 *   execute()      → Phase A: fetch + validate + simulate + FREEZE every leg → 'awaiting-review'.
 *                    No wallet signature is reachable here.
 *   confirmPlan()  → Phase B: sign the frozen, reviewed plan 1:1 (no re-fetch).
 * Re-invoking execute() rebuilds the plan and resets to 'awaiting-review', so any rebuilt leg
 * is re-reviewed before it can be signed.
 */
export function useSplitSwap(
  tokenIn: Token | null,
  tokenOut: Token | null,
  amountIn: string,
  slippage: number = DEFAULT_SLIPPAGE,
): UseSplitSwapResult {
  const { address } = useAccount()
  // [SPRINT-9G G6] Single chain-id source of truth — useActiveChainId() (the
  // active/wallet chain, matching the quote pipeline), NOT wagmi useChainId().
  const chainId = useActiveChainId()
  const { sendTransactionAsync } = useSendTransaction()

  const [status, setStatus] = useState<SplitSwapStatus>('idle')
  const [legs, setLegs] = useState<LegStatus[]>([])
  const [plannedLegs, setPlannedLegs] = useState<PlannedLeg[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const abortRef = useRef(false)
  // [SPRINT-9R audit] true while Phase B is broadcasting — blocks a concurrent rebuild
  // (a re-click of the swap button during 'executing', when the review modal is unmounted)
  // and a double-submit of confirmPlan, both of which could double-broadcast a leg.
  const executingRef = useRef(false)
  // [SPRINT-9R audit] the chain + account the frozen plan was built and validated FOR.
  // confirmPlan refuses to sign if either changed — defence-in-depth alongside the
  // chain/account-switch reset effects below, so the invariant holds independent of
  // React effect timing (the plan's calldata embeds the chain-A FeeCollector/router and
  // the account-A recipient; signing it under chain/account B is exactly [P219]/[FULL-M-04]).
  const planContextRef = useRef<{ chainId: number; address: string } | null>(null)

  const completedLegs = legs.filter(l => l.status === 'success').length
  const totalLegs = legs.length

  const updateLeg = useCallback((index: number, update: Partial<LegStatus>) => {
    setLegs(prev => prev.map((l, i) => i === index ? { ...l, ...update } : l))
  }, [])

  const reset = useCallback(() => {
    abortRef.current = true
    executingRef.current = false
    planContextRef.current = null
    setStatus('idle')
    setLegs([])
    setPlannedLegs([])
    setErrorMessage(null)
  }, [])

  // [SPRINT-9R audit / FULL-M-04 parity] Discard a frozen plan on account switch or
  // disconnect. useSwap clears its pendingSwap here; useSplitSwap had no such effect, so a
  // plan reviewed under wallet A survived a switch and confirmPlan would broadcast wallet-A
  // calldata under wallet B. 9R's review-pause widened this window from near-zero to an
  // indefinite human-paced wait, so the guard is now load-bearing. Ref comparison fires only
  // on an actual change — never on every render — so a steady wallet is untouched.
  const prevAddressRef = useRef(address)
  useEffect(() => {
    const prev = prevAddressRef.current
    const switched = prev && address && prev !== address
    // Only a genuine connected→disconnected transition invalidates a plan — never the
    // initial never-connected mount (no plan exists there, and execute() already guards !address).
    const disconnected = prev && !address
    if (switched || disconnected) reset()
    prevAddressRef.current = address
  }, [address, reset])

  // [SPRINT-9R audit / P219 parity] Discard a frozen plan on chain switch — the plan's
  // calldata embeds the chain-A FeeCollector address, router target and per-leg minimumOutput,
  // which must never broadcast onto chain B. Staying on one chain leaves all behaviour
  // unchanged (ref comparison).
  const prevChainIdRef = useRef(chainId)
  useEffect(() => {
    if (prevChainIdRef.current !== chainId) reset()
    prevChainIdRef.current = chainId
  }, [chainId, reset])

  // ── Phase A — build + validate + simulate + FREEZE all legs (NO signing) ──
  const execute = useCallback(async (splitRoute: SplitRoute) => {
    if (!tokenIn || !tokenOut || !address || !amountIn || !splitRoute.isSplit) return
    // [SPRINT-9R audit] Refuse to rebuild while Phase B is mid-broadcast. The swap button
    // receives the single-swap status (idle during a split) so it stays clickable while the
    // review modal is unmounted in 'executing'; a re-click here would race the in-flight
    // confirmPlan loop and double-broadcast already-signed legs.
    if (executingRef.current) return

    abortRef.current = false
    setErrorMessage(null)
    setStatus('planning')

    let totalRaw: bigint
    try {
      totalRaw = parseUnits(amountIn, tokenIn.decimals)
    } catch {
      setStatus('error')
      setErrorMessage('Invalid input amount.')
      return
    }

    // Initialize leg statuses (rebuild: a fresh plan supersedes any prior review)
    const initialLegs: LegStatus[] = splitRoute.legs.map(leg => ({
      source: leg.source as AggregatorName,
      percent: leg.percent,
      status: 'pending',
    }))
    setLegs(initialLegs)
    setPlannedLegs([])

    const isNativeIn = isNativeETH(tokenIn)
    const tokenOutForFc: `0x${string}` = isNativeETH(tokenOut)
      ? ZERO_ADDRESS
      : (tokenOut.address as `0x${string}`)
    const slippageBpsBn = BigInt(Math.max(0, Math.round(slippage * 100)))

    const planned: PlannedLeg[] = []

    for (let i = 0; i < splitRoute.legs.length; i++) {
      if (abortRef.current) return

      const leg = splitRoute.legs[i]
      const source = leg.source as AggregatorName
      const legAmount = (totalRaw * BigInt(leg.percent)) / 100n
      const routeViaFeeCollector = usesFeeCollector(source, chainId)

      try {
        // Step 1: Fetch calldata
        updateLeg(i, { status: 'fetching' })

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
          chainId, // [P221/43-I-01] thread active chain to the adapter
        )

        if (!swapData.tx) throw new Error('No transaction data returned')

        // Validate router
        const routerCheck = validateRouterAddress(swapData.tx.to, source, chainId)
        if (!routerCheck.valid) throw new Error(routerCheck.reason || 'Router not whitelisted')

        // FE-HIGH-01: Calldata validations (mirrors useSwap.ts safety checks)
        const calldataHex = swapData.tx.data as string
        if (!calldataHex || calldataHex.length < 10) {
          throw new Error('Swap calldata is empty or too short.')
        }
        if (calldataHex.length > 200_000) {
          throw new Error('Swap calldata abnormally large — possible injection.')
        }
        const selector = calldataHex.slice(0, 10).toLowerCase()
        if (!KNOWN_SWAP_SELECTORS.has(selector)) {
          throw new Error(`Unknown swap selector ${selector} in split leg. Blocked for safety.`)
        }
        // [R1] Validate recipient in calldata matches connected wallet.
        // [FULL-M-01] Direct legs reject the FeeCollector as a recipient.
        const recipientCheck = validateCallDataRecipient(calldataHex, address, routeViaFeeCollector, chainId)
        if (!recipientCheck.valid) {
          throw new Error(`Split leg recipient mismatch: tokens would go to ${recipientCheck.extracted?.slice(0, 10)}... instead of your wallet.`)
        }
        // Fee integrity check
        if (leg.quote?.toAmount) {
          const feeCheck = validateFeeIntegrity(leg.quote.toAmount, swapData.toAmount, source)
          if (!feeCheck.valid) {
            throw new Error('Fee integrity failed on split leg — output unexpectedly high.')
          }
        }

        // [P207] Pre-leg simulation — eth_call the exact transaction before review,
        // mirroring the single-swap path. Catches reverts (stale routing, FeeCollector
        // InsufficientOutput) so a doomed leg is SKIPPED (not signed), not aborted.
        updateLeg(i, { status: 'simulating' })
        const simTx = buildSimulationTx({
          swapData,
          routeViaFeeCollector,
          isNativeIn,
          tokenIn,
          tokenOut,
          rawAmount: legAmount,
          slippage,
          fromAddress: address,
          source,
          chainId, // [P221/43-I-01] thread active chain into the simulation
        })
        const sim = await simulateSwapTx(simTx)
        if (!sim.success) {
          updateLeg(i, { status: 'error', error: sim.error || 'Simulation failed — leg would revert' })
          planned.push({
            source, percent: leg.percent, legAmount, routeViaFeeCollector, isNativeIn,
            routerAddress: swapData.tx.to, routerCalldata: calldataHex,
            legMinOutput: 0n, expectedOut: swapData.toAmount, outputAmount: leg.outputAmount,
            simulated: true, status: 'skipped', error: sim.error || 'Simulation reverted',
          })
          continue // Skip this leg from the signable plan
        }
        // [P209] Inconclusive sim — proceed, but flag the leg so the UI can signal it ran
        // without a client-side revert guard (on-chain minimumOutput still protects the fill).
        const simulated = sim.simulated !== false

        // [H-04] Per-leg FeeCollector minimumOutput derived from leg toAmount + user slippage.
        // [10-L-01] A malformed leg toAmount disables the on-chain minimumOutput check for
        // that leg rather than throwing during calldata encoding.
        const legToAmountBn = safeBigInt(swapData.toAmount)
        const legMinOutput =
          legToAmountBn === null || slippageBpsBn >= 10_000n
            ? 0n
            : (legToAmountBn * (10_000n - slippageBpsBn)) / 10_000n

        // FREEZE the EXACT transaction that will broadcast (encode now, sign in confirmPlan).
        // This is byte-identical to what was just simulated.
        let txTo: `0x${string}`
        let txData: `0x${string}`
        let txValue: bigint
        let txGas: bigint | undefined

        if (routeViaFeeCollector) {
          // [P225] Resolve the FeeCollector for the active chain. Guard null defensively.
          const feeCollectorAddress = getChainConfig(chainId).contracts.feeCollector
          if (!feeCollectorAddress) {
            throw new Error(`Swaps via FeeCollector aren't available on chain ${chainId} yet.`)
          }
          if (isNativeIn) {
            txData = encodeFunctionData({
              abi: FEE_COLLECTOR_ABI,
              functionName: 'swapETHWithFee',
              args: [swapData.tx.to as `0x${string}`, swapData.tx.data as `0x${string}`, tokenOutForFc, legMinOutput],
            })
            txTo = feeCollectorAddress
            txValue = legAmount
            txGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 100_000n : undefined
          } else {
            txData = encodeFunctionData({
              abi: FEE_COLLECTOR_ABI,
              functionName: 'swapTokenWithFee',
              args: [tokenIn.address as `0x${string}`, legAmount, swapData.tx.to as `0x${string}`, swapData.tx.data as `0x${string}`, tokenOutForFc, legMinOutput],
            })
            txTo = feeCollectorAddress
            txValue = 0n
            txGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 120_000n : undefined
          }
        } else {
          // Direct swap (0x, etc.)
          txTo = swapData.tx.to as `0x${string}`
          txData = swapData.tx.data as `0x${string}`
          txValue = BigInt(swapData.tx.value || '0')
          txGas = swapData.tx.gas > 0 ? BigInt(swapData.tx.gas) + 50_000n : undefined
        }

        planned.push({
          source, percent: leg.percent, legAmount, routeViaFeeCollector, isNativeIn,
          routerAddress: swapData.tx.to, routerCalldata: calldataHex,
          txTo, txData, txValue, txGas,
          legMinOutput, expectedOut: swapData.toAmount, outputAmount: leg.outputAmount,
          simulated, status: 'reviewed',
        })
        updateLeg(i, { status: 'reviewed', simulated })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        updateLeg(i, { status: 'error', error: msg.slice(0, 100) })
        planned.push({
          source, percent: leg.percent, legAmount, routeViaFeeCollector, isNativeIn,
          routerAddress: '', routerCalldata: '',
          legMinOutput: 0n, expectedOut: '0', outputAmount: leg.outputAmount,
          simulated: true, status: 'skipped', error: msg.slice(0, 100),
        })
      }
    }

    if (abortRef.current) return

    setPlannedLegs(planned)
    const signable = planned.filter(p => p.status === 'reviewed')
    if (signable.length === 0) {
      setStatus('error')
      setErrorMessage('No split leg can execute — every leg failed pre-flight checks.')
      return
    }
    // Stamp the chain + account this plan was built/validated for, so confirmPlan can reject
    // a stale cross-chain/cross-account signature even if the reset effect hasn't fired yet.
    planContextRef.current = { chainId, address }
    // FREEZE: await the user's review of the plan. NO transaction has been signed.
    setStatus('awaiting-review')
  }, [tokenIn, tokenOut, address, amountIn, slippage, updateLeg, chainId])

  // ── Phase B — sign the FROZEN, reviewed plan 1:1 (reachable ONLY via the review modal) ──
  const confirmPlan = useCallback(async () => {
    // Guard: only a freshly-reviewed plan may be signed. A rebuild (execute()) resets status
    // to 'awaiting-review' with a NEW plan, so a stale confirm cannot sign old/unreviewed calldata.
    if (status !== 'awaiting-review') return
    if (!tokenIn || !tokenOut || !address) return
    // [SPRINT-9R audit] Double-submit guard — two synchronous Confirm clicks both capture
    // status==='awaiting-review' before React re-renders; the ref blocks the second.
    if (executingRef.current) return
    // [SPRINT-9R audit] Reject a plan built for a different chain/account than the one now
    // connected (the reset effect closes the modal, but this holds the invariant synchronously,
    // independent of effect timing). The frozen calldata embeds the chain-A FeeCollector/router
    // and the account-A recipient — never sign it under chain/account B.
    const ctx = planContextRef.current
    if (!ctx || ctx.chainId !== chainId || ctx.address.toLowerCase() !== address.toLowerCase()) {
      reset()
      return
    }

    executingRef.current = true
    abortRef.current = false
    setStatus('executing')

    let successCount = 0
    let errorCount = 0

    try {
    for (let i = 0; i < plannedLegs.length; i++) {
      if (abortRef.current) break
      const p = plannedLegs[i]
      // Skipped legs (failed Phase-A pre-flight) are never signed.
      if (p.status !== 'reviewed' || !p.txTo || !p.txData) continue

      try {
        updateLeg(i, { status: 'signing' })
        const txHash = await sendTransactionAsync({
          to: p.txTo,
          data: p.txData,
          value: p.txValue ?? 0n,
          gas: p.txGas,
        })
        updateLeg(i, { status: 'confirming', txHash })

        const receipt = await waitForReceipt(txHash, chainId)
        if (receipt === 'success') {
          updateLeg(i, { status: 'success' })
          successCount++
          logSwapToSupabase({
            wallet: address,
            chainId,
            source: p.source,
            tokenIn,
            tokenOut,
            amountIn: p.legAmount.toString(),
            amountOut: p.outputAmount,
            slippage,
            mevProtected: false,
            feeCollected: p.routeViaFeeCollector,
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
        // If the user rejected, abort the remaining legs.
        if (isUserReject) {
          setErrorMessage('Transaction rejected in wallet.')
          break
        }
      }
    }

    // Final status — denominator is ALL legs (a skipped leg means not all executed → partial).
    if (successCount === plannedLegs.length) {
      setStatus('success')
    } else if (successCount > 0) {
      setStatus('partial')
      // Failed = every leg that didn't succeed (reverted/timed-out signed legs + Phase-A skipped legs).
      setErrorMessage(`${successCount}/${plannedLegs.length} legs completed. ${plannedLegs.length - successCount} failed.`)
    } else {
      setStatus('error')
      if (!errorMessage) setErrorMessage('Split swap failed.')
    }
    } finally {
      executingRef.current = false
    }
  }, [status, plannedLegs, tokenIn, tokenOut, address, chainId, slippage, sendTransactionAsync, updateLeg, errorMessage, reset])

  return {
    status,
    legs,
    plannedLegs,
    completedLegs,
    totalLegs,
    errorMessage,
    execute,
    confirmPlan,
    reset,
  }
}
