'use client'

import type { MetaQuoteResult } from '@/lib/api'
import type { Token } from '@/lib/tokens'
import type { PriceCheck } from '@/lib/chainlink'
import type { ApprovalPlan } from '@/lib/approvals'
import { FEE_PERCENT, FEE_NATIVE_SOURCES, AGGREGATOR_META, type AggregatorName } from '@/lib/constants'
import { isFeeCollectorActive } from '@/lib/api'
import { formatUnits } from 'viem'
import { formatDisplay, formatWithSeparator } from '@/lib/format'

interface Props {
  meta: MetaQuoteResult
  tokenIn: Token
  tokenOut: Token
  amountIn: string
  slippage: number
  countdown: number
  priceCheck: PriceCheck
  approvalPlan: ApprovalPlan | null
  onEditSlippage: () => void
  gasEstimate?: (gasUnits: number) => { eth: number; usd: number } | null
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
  meta, tokenIn, tokenOut, amountIn, slippage, countdown, priceCheck, approvalPlan, onEditSlippage, gasEstimate,
}: Props) {
  const best = meta.best
  const outputAmount = Number(formatUnits(BigInt(best.toAmount), tokenOut.decimals))
  const inputAmount = Number(amountIn)
  const rate = inputAmount > 0 ? formatDisplay(outputAmount / inputAmount, 4) : '—'
  // Fee is collected when: source has native fee API params, OR FeeCollector proxy is active
  const feeCollected = FEE_NATIVE_SOURCES.includes(best.source) || isFeeCollectorActive()
  const feeAbsolute = feeCollected ? (inputAmount * FEE_PERCENT) / 100 : 0
  const minOutput = outputAmount * (1 - slippage / 100)

  const secondBest = meta.all[1]
  let savingsVsSecond: string | null = null
  if (secondBest) {
    const secondOutput = Number(formatUnits(BigInt(secondBest.toAmount), tokenOut.decimals))
    const diff = outputAmount - secondOutput
    if (diff > 0) savingsVsSecond = `+${formatDisplay(diff, 4)} ${tokenOut.symbol} vs ${sourceLabel(secondBest.source)}`
  }

  const bestIsMevProtected = isMevProtected(best.source)
  const bestIsIntent = isIntentBased(best.source)
  const bestTime = estimatedTime(best.source)
  const bestIsDirect = AGGREGATOR_META[best.source]?.isDirect ?? false

  return (
    <div className="space-y-3">
      {/* Chainlink warnings */}
      {priceCheck.level === 'danger' && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{priceCheck.message}</div>
      )}
      {priceCheck.level === 'warn' && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">{priceCheck.message}</div>
      )}

      {/* Oracle unavailable — inline tooltip only */}

      {/* Main breakdown */}
      <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-3 text-sm">
        {/* Winner badge */}
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-success" />
            <span className="text-xs font-medium text-success">Best via {sourceLabel(best.source)}</span>
          </span>
          <span className="flex items-center gap-1 text-xs text-cream-35">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cream-50" />
            {countdown}s
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
        <div className="mb-2 flex items-center justify-between text-cream-65">
          <span
            className="text-cream-35"
            title={
              priceCheck.oracleUnavailable
                ? `No Chainlink oracle for ${tokenIn.symbol} — price not independently verified`
                : priceCheck.chainlinkPrice != null
                  ? `Verified by Chainlink ($${priceCheck.chainlinkPrice.toFixed(2)})`
                  : undefined
            }
          >
            Rate
          </span>
          <span className="truncate text-cream-80 text-xs sm:text-sm">1 {tokenIn.symbol} = {rate} {tokenOut.symbol}</span>
        </div>

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
                <span className="cursor-help" title="Uniswap V3 pools charge a fee on every swap. Each token pair can have multiple pools with different fee tiers (0.01%, 0.05%, 0.3%, 1%). TeraSwap automatically picks the pool with the best output for you.">&#9432;</span>
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

        {/* Slippage */}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-cream-35">Max slippage</span>
          <button onClick={onEditSlippage} className="text-xs text-cream-65 transition hover:text-cream">
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
            <span className="cursor-help text-cream-35" title={feeCollected ? 'This fee supports platform development. Collected by the aggregator API.' : 'No fee for this route. Fees are collected on 1inch, 0x, and KyberSwap routes.'}>&#9432;</span>
          </span>
          {feeCollected ? (
            <span>
              {formatDisplay(feeAbsolute, 6)} {tokenIn.symbol}
              {priceCheck.chainlinkPrice != null && (
                <span className="ml-1 font-normal text-cream-50">(${(feeAbsolute * priceCheck.chainlinkPrice).toFixed(2)})</span>
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
            priceCheck.deviation > 0.05 ? 'text-danger font-semibold' : priceCheck.deviation > 0.02 ? 'text-warning' : 'text-cream-50'
          }`}>
            <span className="flex items-center gap-1">
              Price impact
              <span className="cursor-help text-cream-35" title="Estimated impact based on Chainlink oracle vs execution price. Higher impact means your trade is large relative to available liquidity.">&#9432;</span>
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
            const out = Number(formatUnits(BigInt(q.toAmount), tokenOut.decimals))
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
                <span className="font-mono tabular-nums">{formatDisplay(out, 4)} {tokenOut.symbol}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
