'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSwap, type QuoteToAmountBySource } from '@/hooks/useSwap'
import { useSplitSwap } from '@/hooks/useSplitSwap'
import { useSplitRoute } from '@/hooks/useSplitRoute'
import { useSwapHistory } from '@/hooks/useSwapHistory'
import { useActiveApprovals } from '@/hooks/useActiveApprovals'
import { useAccount } from 'wagmi'
import type { ApprovalStatus } from '@/hooks/useApproval'
import type { MetaQuoteResult } from '@/lib/adapters/types'
import { orderExecutableFallbacks } from '@/lib/executable-sources'
import { estimateMevSavings } from '@/lib/mev-savings'
import { updateSwapStatus } from '@/lib/analytics'
import { COW_VAULT_RELAYER } from '@/lib/constants'
import { isNativeETH, type Token } from '@/lib/tokens'
import { playCancelOrderMP3, playSwapConfirmMP3, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { useV2Toast } from '../../shell/toasts'
import type { SwapGateState } from './use-swap-gates'
import type { SwapStatus } from '@/hooks/useSwap'
import { buildSuccessSummary, effectiveSwapStatus, TRACKED_STATUSES, type SuccessSummary } from './lifecycle-view'

export interface LifecycleArgs {
  tokenIn: Token | null
  tokenOut: Token | null
  /** Raw amount without separators (v1's `amountIn`). */
  amountIn: string
  slippage: number
  /** The amount-current, MEV-selected quote (v1's `meta`). */
  meta: MetaQuoteResult | null
  activeChainId: number
  isChainOkForQuote: boolean
  /** v1's `isChainActive(activeChainId)` (P223: swaps are disabled on a coming-soon chain). */
  chainActive: boolean
  /** The server's tier for the pair is `unpriced` (v1: `priceTier?.tier === 'unpriced'`). */
  unpricedPair: boolean
  gates: Pick<SwapGateState, 'anyBlocked'>
  approval: { status: ApprovalStatus; error: string | null; approve: () => Promise<void>; isReady: boolean }
  /** Chainlink price of the buy token (v1: `tokenOutPriceCheck.chainlinkPrice`) — only for the CoW "you saved" line. */
  tokenOutUsdPrice: number | null
}

/**
 * [ADR-025 / B5] The v2 swap lifecycle: v1's `useSwap` / `useSplitSwap` / `useSplitRoute` called with SwapBox's own arguments, SwapBox's
 * own click handlers (approval → consent → execute, same argument lists, same `unpricedAck` propagation), and SwapBox's own side
 * effects (sounds, toasts, history, MEV telemetry, CoW approval record). The UI never computes an amount, a minimum output or
 * calldata — it hands the hooks the quote and renders what they freeze.
 */
export function useSwapLifecycle(a: LifecycleArgs) {
  const { tokenIn, tokenOut, amountIn, slippage, meta, activeChainId, approval } = a
  const { address } = useAccount()
  const { toast, dismiss } = useV2Toast()
  const { addRecord } = useSwapHistory()
  const { addApproval } = useActiveApprovals()

  // [Architect ruling R3-2] every source's accepted quote, so useSwap floors the source that ACTUALLY executes against its own quote.
  const quoteToAmountBySource = useMemo<QuoteToAmountBySource>(() => Object.fromEntries((meta?.all ?? []).map((q) => [q.source, q.toAmount])), [meta])
  // [P104] raw adapter gasUsd of the best non-CoW quote; the server clamps and persists it.
  const bestNonCowGasUsd = meta?.all.find((q) => q.source !== 'cowswap')?.gasUsd

  const swap = useSwap(tokenIn, tokenOut, amountIn, slippage, quoteToAmountBySource, bestNonCowGasUsd)
  const splitRoute = useSplitRoute(meta, tokenIn, tokenOut, amountIn, a.isChainOkForQuote, activeChainId)
  const split = useSplitSwap(tokenIn, tokenOut, amountIn, slippage)

  const isSplitActive = !!(splitRoute.useSplit && splitRoute.splitResult?.bestSplit.isSplit)
  const status = effectiveSwapStatus({ isSplitActive, swapStatus: swap.status, splitStatus: split.status })
  const error = isSplitActive ? split.errorMessage : swap.errorMessage
  // v1: the 409 reopens the consent whichever hook raised it.
  const ackRequired = swap.unpricedAckRequired || split.unpricedAckRequired

  // The last in-flight status before a failure — the timeline draws the failure on the step that was running. Adjusting state during
  // render (React's documented derive-from-props pattern), not in an effect.
  const [lastActive, setLastActive] = useState<SwapStatus>('idle')
  if (status === 'idle' && lastActive !== 'idle') setLastActive('idle')
  else if (TRACKED_STATUSES.has(status) && status !== lastActive) setLastActive(status)

  // The split path has no pre-review sheet (v1 goes straight to the plan), so its consent is a sheet of its own; this is v1's
  // `unpricedConsentRequested`.
  const [consentRequested, setConsentRequested] = useState(false)

  // The quote the user confirmed, frozen: the success toast, the history row and the success sheet describe what was signed even
  // if a re-quote lands while the wallet prompt is open (v1 reads the live quote at settle time — identical unless that happens).
  const [confirmedQuote, setConfirmedQuote] = useState<MetaQuoteResult | null>(null)

  const run = useCallback(
    (unpricedAck: boolean) => {
      setConfirmedQuote(meta)
      if (isSplitActive && splitRoute.splitResult?.bestSplit) {
        if (unpricedAck) split.execute(splitRoute.splitResult.bestSplit, { unpricedAck: true })
        else split.execute(splitRoute.splitResult.bestSplit)
      } else if (meta?.best.source) {
        // [SPRINT-9O Part B] ranked fallbacks so a best route that reverts its pre-swap simulation auto-switches to the next working source.
        const fallbacks = orderExecutableFallbacks(meta, meta.best.source, activeChainId)
        if (unpricedAck) swap.execute(meta.best.source, fallbacks, { unpricedAck: true })
        else swap.execute(meta.best.source, fallbacks)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- swap/split are fresh objects each render; their `execute` callbacks are what matter
    [meta, isSplitActive, splitRoute.splitResult, split.execute, swap.execute, activeChainId],
  )

  /**
   * SwapBox's `handleApproveAndSwap` / `handleSwap` / `confirmUnpricedSwap` in one: gates → (approval) → consent → execute.
   * `unpricedAck` is true only when the user ticked the consent for THIS attempt; it rides every /api/swap call (single, CoW, each split leg).
   */
  const confirm = useCallback(
    async (c: { unpricedAck: boolean } = { unpricedAck: false }) => {
      if (!a.chainActive) return // [P223]
      if (a.gates.anyBlocked) return // hard block — never execute above the deviation threshold or an unverified large swap
      startWaitingSound()
      if (!approval.isReady) {
        await approval.approve()
        return
      }
      // [feat/swap-price-tiers D3] no reference price on either leg → informed consent before executing.
      if (a.unpricedPair && !c.unpricedAck) {
        stopWaitingSound()
        setConsentRequested(true)
        return
      }
      setConsentRequested(false)
      run(c.unpricedAck) // the ack is whatever THIS attempt's consent produced — also after a 409 the client tier did not predict
    },
    [a.chainActive, a.gates.anyBlocked, a.unpricedPair, approval, run],
  )

  /** SwapBox's `cancelUnpricedSwap` + the review modals' `onCancel={resetSwap | resetSplitSwap}`. */
  const cancel = useCallback(() => {
    setConsentRequested(false)
    stopWaitingSound() // v1 leaves the loop running after a cancelled review; stopping it is the settle the loop is waiting for
    if (swap.status === 'confirming' || swap.status === 'cow_awaiting_review' || swap.unpricedAckRequired) swap.reset()
    if (split.status === 'awaiting-review' || split.unpricedAckRequired) split.reset()
  }, [swap, split])

  /** A fresh attempt / "New swap": back to idle in whichever hook holds state (SwapBox's `if (status !== 'idle') reset()`). */
  const resetAll = useCallback(() => {
    setConsentRequested(false)
    if (swap.status === 'idle' && split.status === 'idle') return
    stopWaitingSound()
    if (swap.status !== 'idle') swap.reset()
    if (split.status !== 'idle') split.reset()
  }, [swap, split])

  // ── Toast: swap initiated (loading) ──
  const swapToastId = useRef<string | null>(null)
  useEffect(() => {
    if (swap.status === 'swapping' || swap.status === 'cow_signing' || swap.status === 'cow_pending') {
      const msg = swap.status === 'cow_signing' ? 'Signing CoW order...' : swap.status === 'cow_pending' ? 'CoW order submitted — waiting for settlement...' : 'Transaction pending...'
      // v1 overwrites the id when cow_signing → cow_pending, leaving the first loading toast sticky; replace it instead.
      if (swapToastId.current) dismiss(swapToastId.current)
      swapToastId.current = toast({ type: 'loading', title: msg, description: `${tokenIn?.symbol} → ${tokenOut?.symbol}` })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- v1 keys this on the status alone: a symbol change must not raise a toast
  }, [swap.status])

  // ── Track swap success: toast, history, approvals ──
  const successQuote = confirmedQuote ?? meta
  const success = useMemo<SuccessSummary | null>(
    () => (swap.status === 'success' && tokenOut && successQuote?.best ? buildSuccessSummary({ meta: successQuote, tokenOut, mevSurplusActualWei: swap.mevSurplusActualWei, tokenOutUsdPrice: a.tokenOutUsdPrice }) : null),
    [swap.status, swap.mevSurplusActualWei, tokenOut, successQuote, a.tokenOutUsdPrice],
  )
  useEffect(() => {
    const quote = successQuote
    if (swap.status === 'success' && swap.txHash && tokenIn && tokenOut && quote?.best) {
      stopWaitingSound()
      playSwapConfirmMP3()
      if (swapToastId.current) dismiss(swapToastId.current)

      // [LP-05] MEV savings: the pre-swap estimate and the post-swap realised surplus are both logged; only a realised CoW surplus is shown.
      const mevEstimate = estimateMevSavings(quote)
      const summary = buildSuccessSummary({ meta: quote, tokenOut, mevSurplusActualWei: swap.mevSurplusActualWei, tokenOutUsdPrice: a.tokenOutUsdPrice })
      toast({
        type: 'success',
        title: 'Swap confirmed!',
        description: `${amountIn} ${tokenIn.symbol} → ${summary.outDisplay} ${tokenOut.symbol}${summary.savingsLine ? ` · ${summary.savingsLine}` : ''}`,
        txHash: swap.txHash,
        chainId: activeChainId,
        duration: 10000,
      })
      swapToastId.current = null

      addRecord({
        id: swap.txHash,
        date: new Date().toLocaleDateString('en-GB'),
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        amountIn,
        // numeric-format-allow: stored in swap history (addRecord), not display
        amountOut: summary.outNumber !== null ? summary.outNumber.toFixed(4) : '0',
        txHash: swap.txHash,
        status: 'confirmed',
        chainId: activeChainId,
      })

      if (address && (mevEstimate || summary.realisedSurplusWei)) {
        updateSwapStatus({
          txHash: swap.txHash,
          status: 'confirmed',
          wallet: address,
          mevSavingsEstimate: mevEstimate ? mevEstimate.amountWei.toString() : undefined,
          mevSavingsActual: summary.realisedSurplusWei ? summary.realisedSurplusWei.toString() : undefined,
        })
      }

      // [FULL-L-04] CoW approvals are exact (no residual allowance): record it accurately, never the old "infinite allowance" warning.
      if (quote.best.source === 'cowswap' && !isNativeETH(tokenIn)) {
        addApproval({
          tokenAddress: tokenIn.address,
          tokenSymbol: tokenIn.symbol,
          spenderAddress: COW_VAULT_RELAYER,
          spenderLabel: 'CoW VaultRelayer',
          source: 'cowswap',
          method: 'exact',
          timestamp: Date.now(),
          needsRevoke: false,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- v1 keys this on [swapStatus, txHash]: it must run once per settle, not per quote poll
  }, [swap.status, swap.txHash])

  // ── Play error sound + toast on swap failure ──
  useEffect(() => {
    if (swap.status === 'error') {
      stopWaitingSound()
      playCancelOrderMP3()
      if (swapToastId.current) dismiss(swapToastId.current)
      toast({ type: 'error', title: 'Swap failed', description: swap.errorMessage || 'Transaction was rejected or failed.' })
      swapToastId.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- v1 keys this on the status alone
  }, [swap.status])

  // ── Split swap toasts ──
  useEffect(() => {
    if (split.status === 'success') {
      stopWaitingSound()
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'Split swap complete!', description: `All ${split.totalLegs} legs executed successfully.`, duration: 10000 })
    } else if (split.status === 'partial') {
      stopWaitingSound()
      playCancelOrderMP3()
      toast({ type: 'warning', title: 'Split swap partially complete', description: split.errorMessage || `${split.completedLegs}/${split.totalLegs} legs succeeded.`, duration: 10000 })
    } else if (split.status === 'error') {
      stopWaitingSound()
      playCancelOrderMP3()
      toast({ type: 'error', title: 'Split swap failed', description: split.errorMessage || 'Transaction was rejected or failed.' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- v1 keys this on the split status alone
  }, [split.status])

  // ── Toast: approval error ──
  useEffect(() => {
    if (approval.error) {
      stopWaitingSound() // v1 leaves the loop running after a failed approval; the approval has settled
      toast({ type: 'error', title: 'Approval failed', description: approval.error })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- v1 keys this on the error alone
  }, [approval.error])

  // The approval settled (ready) with no swap running: the loop the Approve press started has nothing left to wait for.
  useEffect(() => {
    if (approval.isReady && swap.status === 'idle' && split.status === 'idle') stopWaitingSound()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the approval settling matters
  }, [approval.isReady])

  return {
    swap,
    split,
    splitRoute,
    isSplitActive,
    /** SwapBox's `effectiveSwapStatus`. */
    status,
    error,
    ackRequired,
    consentRequested,
    /** The summary of the swap that just succeeded (standard path); null otherwise. */
    success,
    lastActive,
    /** The route the timeline follows: CoW signs an order, everything else sends a transaction. */
    route: ((confirmedQuote ?? meta)?.best.source === 'cowswap' ? 'cow' : 'standard') as 'cow' | 'standard',
    confirm,
    cancel,
    resetAll,
  }
}

export type SwapLifecycle = ReturnType<typeof useSwapLifecycle>
