'use client'

import { useState } from 'react'
import type { MetaQuoteResult } from '@/lib/api'
import type { Token } from '@/lib/tokens'
import type { PriceCheck } from '@/lib/chainlink'
import type { ApprovalPlan } from '@/lib/approvals'
import { FEE_PERCENT, FEE_NATIVE_SOURCES, AGGREGATOR_META, PRICE_DEVIATION_WARN, PRICE_DEVIATION_BLOCK, type AggregatorName } from '@/lib/constants'
import { isFeeCollectorActive } from '@/lib/api'
import { isExecutableSource } from '@/lib/executable-sources'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { estimateMevSavings } from '@/lib/mev-savings'
import { swapNotionalUsd, feeUsd, formatFeeUsd } from '@/lib/fee-usd'
import { safeBigInt } from '@/lib/utils'
import { formatUnits } from 'viem'
import { formatDisplay, formatWithSeparator } from '@/lib/format'
import InfoTooltip from './InfoTooltip'

interface Props {
  meta: MetaQuoteResult
  tokenIn: Token
  tokenOut: Token
  amountIn: string
  slippage: number
  countdown: number
  priceCheck: PriceCheck
  /** [chore/swap-fee-usd-fix] Each token's OWN Chainlink USD price (null when it
   *  has no feed). Used to value the platform fee from the reliably-priced side
   *  instead of `priceCheck.chainlinkPrice`, which falls back to the OTHER leg's
   *  price for an unfeeded token (mis-valuing e.g. an AERO fee at WETH's price). */
  tokenInUsdPrice?: number | null
  tokenOutUsdPrice?: number | null
  approvalPlan: ApprovalPlan | null
  onEditSlippage: () => void
  gasEstimate?: (gasUnits: number) => { eth: number; usd: number } | null
  /** [LP-04] true when the SwapBox auto-promoted CoW into best because it
   *  was within MEV_PREFERENCE_THRESHOLD of the highest-output quote. */
  smartMevApplied?: boolean
  /** [LP-04] true when best is non-MEV-protected AND the user has not
   *  enabled Force MEV Protection AND no competitive CoW quote was found.
   *  Triggers a small advisory inviting the user to enable the toggle. */
  mevExposedBest?: boolean
  /** [P95] Switch the swap to the gasless (CoW) route. Invoked from the
   *  "Use Gasless Route" CTA in the recommendation card. */
  onUseGasless?: () => void
  /** [P147] Manual quote refresh. Rendered next to the countdown. */
  onRefresh?: () => void
  /** [P147] true while a refresh is on the wire — drives the spin state. */
  refreshing?: boolean
  /** [CHORE-SUSHI-V7] Active chain — drives the per-chain "Quote only" label
   *  for sources that cannot settle on this chain (executable-sources.ts). */
  chainId?: number
}

function sourceLabel(source: AggregatorName): string {
  return AGGREGATOR_META[source]?.label || source
}

function isMevProtected(source: AggregatorName): boolean {
  return AGGREGATOR_META[source]?.mevProtected ?? false
}

function isIntentBased(source: AggregatorName): boolean {
  return AGGREGATOR_META[source]?.intentBased ?? false
}

function estimatedTime(source: AggregatorName): number | undefined {
  return AGGREGATOR_META[source]?.estimatedTime
}

export default function QuoteBreakdown({
  meta, tokenIn, tokenOut, amountIn, slippage, countdown, priceCheck, tokenInUsdPrice, tokenOutUsdPrice, approvalPlan, onEditSlippage, gasEstimate,
  smartMevApplied = false, mevExposedBest = false, onUseGasless,
  onRefresh, refreshing = false, chainId = DEFAULT_CHAIN_ID,
}: Props) {
  // [SPRINT-9Q Q2] Rate-direction toggle (display-only). Persisted for the session so the
  // chosen reading direction survives quote refreshes / remounts.
  const [rateInverted, setRateInverted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try { return sessionStorage.getItem('teraswap:rateInverted') === '1' } catch { return false }
  })
  const toggleRateDirection = () => {
    setRateInverted((prev) => {
      const next = !prev
      try { sessionStorage.setItem('teraswap:rateInverted', next ? '1' : '0') } catch {}
      return next
    })
  }

  const best = meta.best
  // [10-L-01] Guard against malformed toAmount on the winning quote.
  // If parsing fails, every downstream derived value collapses to 0/—
  // and the row renders gracefully instead of crashing the component tree.
  const bestAmountBn = safeBigInt(best.toAmount)
  const outputAmount = bestAmountBn !== null
    ? Number(formatUnits(bestAmountBn, tokenOut.decimals))
    : 0
  const outputAmountValid = bestAmountBn !== null
  const inputAmount = Number(amountIn)
  const rate = outputAmountValid && inputAmount > 0
    ? formatDisplay(outputAmount / inputAmount, 4)
    : '—'
  // [SPRINT-9Q Q2] Display-only inverse (1 tokenOut = N tokenIn). Guard zero output so a
  // div-by-zero never produces Infinity; formatDisplay handles separators + tiny values.
  const inverseRate = outputAmountValid && outputAmount > 0 && inputAmount > 0
    ? formatDisplay(inputAmount / outputAmount, 4)
    : '—'
  // Fee is collected when: source has native fee API params, OR FeeCollector proxy is active
  const feeCollected = FEE_NATIVE_SOURCES.includes(best.source) || isFeeCollectorActive()
  const feeAbsolute = feeCollected ? (inputAmount * FEE_PERCENT) / 100 : 0
  // [chore/swap-fee-usd-fix] Fee USD = FEE_PERCENT% of the swap's REAL notional,
  // taken from whichever side is reliably priced (its own oracle) — NEVER the
  // input-token fee amount × the other leg's price. For AERO→WETH (AERO unfeeded)
  // this values the fee off the WETH output oracle (~$0.002), not WETH's price ×
  // an AERO amount (~$5.79). Oracle-input swaps are unchanged.
  const platformFeeUsd = feeCollected
    ? feeUsd(
        swapNotionalUsd({
          inputAmount,
          inputPrice: tokenInUsdPrice ?? null,
          outputAmount,
          outputPrice: tokenOutUsdPrice ?? null,
        }),
        FEE_PERCENT,
      )
    : null
  const minOutput = outputAmount * (1 - slippage / 100)

  const secondBest = meta.all[1]
  let savingsVsSecond: string | null = null
  if (secondBest && outputAmountValid) {
    const secondBn = safeBigInt(secondBest.toAmount)
    if (secondBn !== null) {
      const secondOutput = Number(formatUnits(secondBn, tokenOut.decimals))
      const diff = outputAmount - secondOutput
      if (diff > 0) savingsVsSecond = `+${formatDisplay(diff, 4)} ${tokenOut.symbol} vs ${sourceLabel(secondBest.source)}`
    }
  }

  const bestIsMevProtected = isMevProtected(best.source)
  const bestIsIntent = isIntentBased(best.source)
  const bestTime = estimatedTime(best.source)
  const bestIsDirect = AGGREGATOR_META[best.source]?.isDirect ?? false

  // [P95] Gasless recommendation overlay (computed in useQuote via analyzeGasless).
  // Three display states:
  //   1. Best is already CoW + recommended → confirmation banner.
  //   2. Recommended but a non-CoW source currently winning → prominent CTA card.
  //   3. Available but not recommended → existing tiny "Gasless" badge handles it.
  const gasless = meta.gasless
  const showGaslessCard = !!gasless && gasless.recommended && !bestIsIntent
  const showGaslessConfirm = !!gasless && gasless.recommended && bestIsIntent

  // [LP-05] Estimated MEV savings vs the non-CoW median (helper in
  // src/lib/mev-savings.ts; same calc is reused by SwapBox for analytics
  // logging on swap success so the displayed estimate matches what gets
  // persisted). Returns null when CoW didn't win, when the comparison
  // set is too small, or when CoW's quote isn't strictly above the
  // non-CoW median — i.e. we never display a negative or zero savings.
  const mevSavingsRaw = estimateMevSavings(meta)
  const mevSavings = mevSavingsRaw
    ? {
        amount: Number(formatUnits(mevSavingsRaw.amountWei, tokenOut.decimals)),
        pct: mevSavingsRaw.pct,
      }
    : null

  return (
    <div className="space-y-3">
      {/* Chainlink warnings */}
      {priceCheck.level === 'danger' && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{priceCheck.message}</div>
      )}
      {/* [SPRINT-9S S2] Dedup: when the oracle is unavailable the generic warn banner is
          redundant with the specific notice below — show only the specific one. */}
      {priceCheck.level === 'warn' && !priceCheck.oracleUnavailable && priceCheck.message && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">{priceCheck.message}</div>
      )}

      {/* [SPRINT-9S S2] Oracle unavailable — ONE calm, specific notice naming the token(s)
          actually missing a feed, and stating the swap is still protected. */}
      {priceCheck.oracleUnavailable && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-300">
          <span className="font-semibold">&#9888; No Chainlink oracle</span> for{' '}
          {(priceCheck.oracleMissingSymbols?.length ? priceCheck.oracleMissingSymbols : [tokenIn.symbol]).join(' / ')}.
          {' '}This price isn&apos;t independently Chainlink-verified, but your swap is still protected by{' '}
          <strong>multi-source price comparison</strong> and an <strong>on-chain minimum-output</strong> guarantee — double-check the rate looks right before swapping.
        </div>
      )}

      {/* [P95] Gasless recommendation card — surfaces when CoW is competitive
          enough to be the better deal. Two layouts: a prominent CTA when a
          non-CoW source is currently winning, a softer confirmation when CoW
          is already selected. */}
      {showGaslessCard && gasless && (
        <div
          className="rounded-xl border border-transparent bg-surface-tertiary p-3"
          style={{
            backgroundImage:
              'linear-gradient(var(--surface-tertiary, #1a1a1a), var(--surface-tertiary, #1a1a1a)), linear-gradient(135deg, #8B5CF6, #3B82F6)',
            backgroundOrigin: 'border-box',
            backgroundClip: 'padding-box, border-box',
            borderWidth: '1px',
          }}
          role="region"
          aria-label="Gasless route recommendation"
        >
          <div className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-0.5 text-base text-purple-400">&#9889;</span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-cream">Zero Gas Available</p>
              <p className="mt-0.5 text-xs text-cream-65">
                {gasless.gasSavingsUsd >= 0.5
                  ? `Save ~$${gasless.gasSavingsUsd.toFixed(2)} in gas fees by using CoW Protocol.`
                  : 'Use CoW Protocol for a fully gasless swap.'}
                {' '}Your swap is fully MEV-protected.
              </p>
              {onUseGasless && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={onUseGasless}
                    className="rounded-full bg-purple-500/90 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-purple-500"
                    aria-label="Switch to the gasless CoW Protocol route"
                  >
                    Use Gasless Route
                  </button>
                  <span className="self-center text-[11px] text-cream-35">
                    or keep current
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showGaslessConfirm && gasless && (
        <div
          className="rounded-lg border border-purple-500/30 bg-purple-500/8 px-3 py-2 text-xs text-purple-300"
          role="status"
        >
          <span className="font-semibold">&#10003; You&apos;re using the gasless route</span>
          {gasless.gasSavingsUsd >= 0.5 && (
            <span> — saving ~${gasless.gasSavingsUsd.toFixed(2)} in gas.</span>
          )}
        </div>
      )}

      {/* [LP-04 / hotfix-ui] The MEV-exposure amber banner used to live
          here. It read as an error and crowded the QuoteBreakdown card.
          The advisory is now a subtle one-liner under the swap button
          in SwapBox (`MevExposureHint`) — same signal, dismissible,
          no scary visual. The `mevExposedBest` prop is preserved on
          this component for callers, but the in-card banner is gone. */}

      {/* Main breakdown */}
      <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-3 text-sm">
        {/* Winner badge */}
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-success" />
            <span className="text-xs font-medium text-success">Best via {sourceLabel(best.source)}</span>
            {/* [LP-04] Annotate when CoW was auto-promoted (not strictly highest output) */}
            {smartMevApplied && (
              <span
                className="text-[10px] font-medium text-cream-50"
                title="CoW Protocol's price was within 0.3% of the highest quote, so TeraSwap routed through it for MEV protection."
              >
                · auto-selected for MEV protection
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-cream-35">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cream-50" />
            {countdown}s
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh quote"
                title="Refresh quote"
                className="relative inline-flex h-5 w-5 items-center justify-center rounded text-[11px] leading-none text-cream-35 transition hover:text-cream disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:-inset-3 before:content-['']"
              >
                <span className={refreshing ? 'inline-block animate-spin' : 'inline-block'}>⟳</span>
              </button>
            )}
          </span>
        </div>

        {/* Feature badges */}
        {(bestIsMevProtected || bestIsIntent || bestIsDirect) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {bestIsDirect && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-400">
                Direct DEX
              </span>
            )}
            {bestIsMevProtected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-cream-gold/15 px-2 py-0.5 text-[10px] font-semibold text-cream-gold">
                <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none"><path d="M8 1l6 3v4c0 3.5-2.5 6.5-6 7.5C4.5 14.5 2 11.5 2 8V4l6-3z" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.5"/><path d="M5.5 8l2 2 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                MEV Protected
              </span>
            )}
            {bestIsIntent && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-400">
                Intent-Based
              </span>
            )}
            {best.estimatedGas === 0 && bestIsIntent && (
              <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] font-semibold text-purple-400">
                Gasless
              </span>
            )}
          </div>
        )}

        {/* CoW timing info */}
        {bestIsIntent && bestTime && (
          <div className="mb-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-300">
            <span className="font-medium">Execution time: ~{bestTime}s</span>
            <span className="text-blue-300/70"> — Solvers compete in batch auctions for the best fill. Your trade is fully protected from MEV (frontrunning, sandwich attacks).</span>
          </div>
        )}

        {/* Rate */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 text-cream-65">
          <span
            className="text-cream-35"
            title={
              priceCheck.oracleUnavailable
                ? `⚠ No Chainlink oracle for ${tokenIn.symbol} — price NOT independently verified. Risk of mispricing on wrapped/exotic tokens.`
                : priceCheck.chainlinkPrice != null
                  ? `✓ Verified by Chainlink ($${priceCheck.chainlinkPrice.toFixed(2)})`
                  : undefined
            }
          >
            Rate {priceCheck.oracleUnavailable && <span className="text-amber-400">&#9888;</span>}
            {priceCheck.chainlinkPrice != null && !priceCheck.oracleUnavailable && <span className="text-success">&#10003;</span>}
          </span>
          <button
            type="button"
            onClick={toggleRateDirection}
            className="inline-flex items-center gap-1 text-right text-xs text-cream-80 transition hover:text-cream sm:text-sm"
            aria-label="Flip rate direction"
            title="Click to flip the rate direction"
          >
            {rateInverted
              ? <>1 {tokenOut.symbol} = {inverseRate} {tokenIn.symbol}</>
              : <>1 {tokenIn.symbol} = {rate} {tokenOut.symbol}</>}
            <span aria-hidden="true" className="text-cream-35">&#8644;</span>
          </button>
        </div>

        {/* [LP-05] Estimated MEV savings vs non-CoW median (CoW-only, positive only) */}
        {mevSavings && (
          <div
            className="mb-2 flex items-center justify-between text-[11px] text-emerald-400/80"
            title="Difference between CoW Protocol's quote and the median of the non-CoW (public-mempool) quotes for this pair. A rough lower-bound estimate of what MEV bots could have extracted on a non-protected route."
          >
            <span className="text-cream-35">Est. MEV savings</span>
            <span className="font-mono tabular-nums">
              +{formatDisplay(mevSavings.amount, 4)} {tokenOut.symbol} ({mevSavings.pct.toFixed(2)}%)
            </span>
          </div>
        )}

        {/* Route */}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-cream-35">Route</span>
          <span className="max-w-[55%] truncate text-right text-xs text-cream-65 sm:max-w-[60%]">
            {best.routes.join(' + ') || sourceLabel(best.source)}
          </span>
        </div>

        {/* Uniswap V3 fee tier detail */}
        {best.source === 'uniswapv3' && best.meta?.uniswapV3Fee != null && (
          <div className="mb-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-cream-35">
                Pool fee tier
                <InfoTooltip label="Pool fee tier info" content="Uniswap V3 pools charge a fee on every swap. Each token pair can have multiple pools with different fee tiers (0.01%, 0.05%, 0.3%, 1%). TeraSwap automatically picks the pool with the best output for you." />
              </span>
              <span className="text-xs font-semibold text-orange-400">
                {best.meta.uniswapV3Fee / 10000}%
                {best.meta.uniswapV3Reason === 'single_pool' && (
                  <span className="ml-1 text-cream-35 font-normal">(only pool)</span>
                )}
                {best.meta.uniswapV3Reason === 'best_net_output' && (
                  <span className="ml-1 text-cream-35 font-normal">(gas tie-break)</span>
                )}
              </span>
            </div>
            {best.meta.uniswapV3Candidates && best.meta.uniswapV3Candidates.filter(c => c.ok).length > 1 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {best.meta.uniswapV3Candidates.map(c => (
                  <span
                    key={c.fee}
                    className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-mono ${
                      c.ok
                        ? c.fee === best.meta?.uniswapV3Fee
                          ? 'bg-orange-500/20 text-orange-400 font-bold'
                          : 'bg-cream-08 text-cream-35'
                        : 'bg-cream-08/50 text-cream-20 line-through'
                    }`}
                    title={c.ok ? `amountOut: ${c.amountOut}, gas: ${c.gasEstimate}` : c.error || 'No pool'}
                  >
                    {c.fee / 10000}%{c.ok ? '' : ' N/A'}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Slippage — mobile bumps tap target to ≥44px via min-h + negative
            margin on the row so layout stays compact on desktop. */}
        <div className="-my-2 mb-2 flex items-center justify-between sm:my-0">
          <span className="text-cream-35">Max slippage</span>
          <button onClick={onEditSlippage} className="inline-flex min-h-[44px] items-center px-2 text-xs text-cream-65 transition hover:text-cream sm:min-h-0 sm:px-0">
            {slippage}% &#9998;
          </button>
        </div>

        <div className="my-2 border-t border-cream-08" />

        {/* Gas */}
        <div className="mb-1 flex items-center justify-between">
          <span className="text-cream-35">Est. gas</span>
          <span className="text-cream-80">
            {best.estimatedGas === 0 && bestIsIntent
              ? <span className="font-semibold text-purple-400">Free (solver-paid)</span>
              : (() => {
                  const cost = gasEstimate?.(best.estimatedGas)
                  return cost
                    ? <span>~{cost.eth.toFixed(4)} ETH <span className="text-cream-50">(${cost.usd.toFixed(2)})</span></span>
                    : `~${formatWithSeparator(best.estimatedGas.toString())} gas`
                })()
            }
          </span>
        </div>

        {/* Platform fee */}
        <div className="mb-1 flex items-center justify-between font-medium text-cream-80">
          <span className="flex items-center gap-1">
            Platform fee {feeCollected ? `(${FEE_PERCENT}%)` : ''}
            <InfoTooltip label="Platform fee info" content={feeCollected ? 'This fee supports platform development. Collected by the aggregator API.' : 'No fee for this route. Fees are collected on 1inch, 0x, and KyberSwap routes.'} />
          </span>
          {feeCollected ? (
            <span>
              {formatDisplay(feeAbsolute, 6)} {tokenIn.symbol}
              {platformFeeUsd != null && (
                <span className="ml-1 font-normal text-cream-50">(${formatFeeUsd(platformFeeUsd)})</span>
              )}
            </span>
          ) : (
            <span className="text-xs font-semibold text-success">Free</span>
          )}
        </div>

        {/* Approval method */}
        {approvalPlan && approvalPlan.extraGas === 0 && (
          <div className="mb-1 flex items-center justify-between">
            <span className="text-cream-35">Approval</span>
            <span className="text-xs font-semibold text-success">{approvalPlan.label}</span>
          </div>
        )}

        {/* Permit2 security note — anti-phishing awareness */}
        {approvalPlan?.method === 'permit2' && (
          <div className="mb-1 rounded bg-blue-500/8 px-2 py-1.5 text-[10px] leading-relaxed text-cream-50">
            <span className="font-semibold text-blue-400">Permit2 Signature</span> — Deadline capped at 30 min. Never sign Permit2 requests from unknown dApps.
          </div>
        )}

        {/* Price impact estimate */}
        {priceCheck.chainlinkPrice != null && priceCheck.executionPrice != null && priceCheck.deviation > 0.005 && (
          <div className={`mb-1 flex items-center justify-between ${
            priceCheck.deviation > PRICE_DEVIATION_BLOCK ? 'text-danger font-semibold' : priceCheck.deviation > PRICE_DEVIATION_WARN ? 'text-warning' : 'text-cream-50'
          }`}>
            <span className="flex items-center gap-1">
              Price impact
              <InfoTooltip label="Price impact info" content="Estimated impact based on Chainlink oracle vs execution price. Higher impact means your trade is large relative to available liquidity." />
            </span>
            <span>~{(priceCheck.deviation * 100).toFixed(2)}%</span>
          </div>
        )}

        <div className="my-2 border-t border-cream-08" />

        {/* Min output */}
        <div className="flex items-center justify-between">
          <span className="text-cream-35">Min. output</span>
          <span className="font-mono font-semibold tabular-nums text-cream-95">{formatDisplay(minOutput, 4)} {tokenOut.symbol}</span>
        </div>

        {/* Savings */}
        {savingsVsSecond && (
          <div className="mt-2 text-center text-xs font-semibold text-success">{savingsVsSecond}</div>
        )}
      </div>

      {/* All sources comparison */}
      {meta.all.length > 1 && (
        <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-2">
          <p className="mb-1.5 text-[11px] font-semibold text-cream-35">Compare ({meta.all.length} sources)</p>
          {meta.all.map((q, i) => {
            // [10-L-01] Per-quote guard — a malformed entry shows "—"
            // rather than crashing the whole comparison list.
            const qBn = safeBigInt(q.toAmount)
            const out = qBn !== null ? Number(formatUnits(qBn, tokenOut.decimals)) : null
            const isBest = i === 0
            const qMeta = AGGREGATOR_META[q.source]
            return (
              <div key={q.source} className={`flex items-center justify-between rounded-lg px-2 py-1 text-xs ${isBest ? 'bg-success/10 text-success' : 'text-cream-35'}`}>
                <span className="flex items-center gap-1.5">
                  {isBest && <span>&#10003;</span>}
                  {sourceLabel(q.source)}
                  {qMeta?.isDirect && (
                    <span className="inline-flex items-center rounded bg-orange-500/20 px-1 py-0 text-[9px] font-bold text-orange-400" title="Direct on-chain swap — no API middleman">
                      Direct
                    </span>
                  )}
                  {!isExecutableSource(q.source, chainId) && (
                    <span className="inline-flex items-center rounded bg-cream-08 px-1 py-0 text-[9px] font-bold text-cream-35" title="Price shown for comparison — this source can't settle swaps on this network yet, so it is never used for execution.">
                      Quote only
                    </span>
                  )}
                  {q.source === 'uniswapv3' && q.meta?.uniswapV3Fee != null && (
                    <span className="text-[9px] text-orange-400/70" title={`Pool fee: ${q.meta.uniswapV3Fee / 10000}%`}>
                      {q.meta.uniswapV3Fee / 10000}%
                    </span>
                  )}
                  {qMeta?.mevProtected && (
                    <span className="inline-flex items-center rounded bg-cream-gold/20 px-1 py-0 text-[9px] font-bold text-cream-gold" title="MEV Protected — no frontrunning or sandwich attacks">
                      MEV
                    </span>
                  )}
                  {qMeta?.intentBased && qMeta.estimatedTime && (
                    <span className="text-[9px] text-blue-400/70" title={`Intent-based: ~${qMeta.estimatedTime}s execution`}>
                      ~{qMeta.estimatedTime}s
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums">{out !== null ? `${formatDisplay(out, 4)} ${tokenOut.symbol}` : '—'}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
