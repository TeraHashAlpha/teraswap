'use client'

import { formatUnits } from 'viem'
import type { SplitQuoteResult } from '@/lib/split-routing-types'
import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'
import { fmtPct, fmtToken, fmtUsd } from '@/lib/format'
import { safeBigInt } from '@/lib/utils'
import type { Token } from '@/lib/tokens'
import { Surface, Toggle } from '../../primitives'
import { Notice } from '../QuotePanel'

const label = (s: AggregatorName) => AGGREGATOR_META[s]?.label || s

/**
 * [B5] v1's SplitRouteVisualizer, v2-styled: same data, same words, same gating (nothing when the best split is not a split or a
 * quote amount is malformed). OFF by default as in v1; the non-atomic warning shows only while it is ON.
 */
export function SplitRoutePanel({ splitResult, tokenOut, useSplit, onToggle, analyzing }: { splitResult: SplitQuoteResult; tokenOut: Token; useSplit: boolean; onToggle: () => void; analyzing: boolean }) {
  const { bestSplit, bestSingle, splitRecommended } = splitResult
  if (!bestSplit.isSplit) return null
  const singleBn = safeBigInt(bestSingle.toAmount)
  const splitTotalBn = safeBigInt(bestSplit.totalOutput)
  if (singleBn === null || splitTotalBn === null) return null
  const singleOutput = Number(formatUnits(singleBn, tokenOut.decimals))
  const splitOutput = Number(formatUnits(splitTotalBn, tokenOut.decimals))
  const diff = splitOutput - singleOutput
  const improvementPercent = fmtPct(bestSplit.improvementBps / 100)

  return (
    <Surface edge="top" className="mt-3 py-3" data-testid="split-route">
      <Toggle
        checked={useSplit}
        onChange={() => onToggle()}
        label={
          <span className="inline-flex items-center gap-2">
            Split Route
            {analyzing && <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-v2-muted" />}
            {splitRecommended && !analyzing && <span className="font-v2-mono text-[10px] font-bold text-v2-green">+{improvementPercent}%</span>}
          </span>
        }
      />
      {useSplit && (
        <div className="mt-2">
          <Notice tone="amber" testId="split-non-atomic">
            <span className="font-semibold">⚠️ Non-atomic execution:</span> Split routes execute as separate transactions. If one leg fails, you may end up with a partial swap. Each leg is independently visible to MEV searchers.
          </Notice>
        </div>
      )}
      <div className="mt-2 space-y-1 text-[13px]">
        {bestSplit.legs.map((leg, i) => {
          const legOut = Number(formatUnits(BigInt(leg.outputAmount), tokenOut.decimals))
          return (
            <div key={`${leg.source}-${i}`} className="flex items-center justify-between gap-3">
              <span className="text-v2-muted">
                {label(leg.source)} <span className="text-v2-dim">{leg.percent}%</span>
              </span>
              <span className="font-v2-mono tabular-nums text-v2-text/90">
                {fmtToken(legOut)} {tokenOut.symbol}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-2 ts-v2-rule-t pt-2 text-[13px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-v2-muted">Single source ({label(bestSingle.source)})</span>
          <span className="font-v2-mono tabular-nums text-v2-text/90">
            {fmtToken(singleOutput)} {tokenOut.symbol}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-v2-text">Split total ({bestSplit.legs.length} sources)</span>
          <span className="font-v2-mono font-semibold tabular-nums text-v2-green">
            {fmtToken(splitOutput)} {tokenOut.symbol}
          </span>
        </div>
        {diff > 0 && (
          <div className="mt-1 text-center text-[12px] font-semibold text-v2-green">
            +{fmtToken(diff)} {tokenOut.symbol} extra ({improvementPercent} better)
          </div>
        )}
        {bestSplit.totalGasUsd > bestSingle.gasUsd * 1.5 && bestSplit.totalGasUsd > 5 && (
          <div className="mt-1 text-center text-[11px] text-v2-amber">
            Note: Split uses ~{fmtUsd(bestSplit.totalGasUsd)} gas vs ~{fmtUsd(bestSingle.gasUsd)} single
          </div>
        )}
      </div>
    </Surface>
  )
}
