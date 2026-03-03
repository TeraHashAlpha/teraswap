'use client'

import { formatUnits } from 'viem'
import type { SplitQuoteResult, SplitRoute, SplitLeg } from '@/lib/split-routing-types'
import { AGGREGATOR_META, type AggregatorName } from '@/lib/constants'
import { formatDisplay } from '@/lib/format'
import type { Token } from '@/lib/tokens'

interface Props {
  splitResult: SplitQuoteResult
  tokenOut: Token
  useSplit: boolean
  onToggle: () => void
  analyzing: boolean
}

function sourceLabel(source: AggregatorName): string {
  return AGGREGATOR_META[source]?.label || source
}

/** Color per source — consistent across the UI */
const SOURCE_COLORS: Record<string, string> = {
  '1inch':     '#1B314F',
  '0x':        '#3B2F4A',
  velora:      '#2F3B4A',
  odos:        '#4A2F3B',
  kyberswap:   '#2F4A3B',
  uniswapv3:   '#FF007A',
  openocean:   '#0068FF',
  sushiswap:   '#D63B98',
  balancer:    '#1E1A32',
  curve:       '#A5A4CE',
  cowswap:     '#194D05',
}

function getSourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? '#333'
}

/** Brighter version for text labels */
const SOURCE_TEXT_COLORS: Record<string, string> = {
  '1inch':     '#6B8DB9',
  '0x':        '#A38BC4',
  velora:      '#8BA3C4',
  odos:        '#C48B9D',
  kyberswap:   '#8BC49D',
  uniswapv3:   '#FF5AA8',
  openocean:   '#4A9FFF',
  sushiswap:   '#E880BE',
  balancer:    '#7A74C4',
  curve:       '#D4D3FF',
  cowswap:     '#4CAF50',
}

function getSourceTextColor(source: string): string {
  return SOURCE_TEXT_COLORS[source] ?? '#aaa'
}

export default function SplitRouteVisualizer({
  splitResult,
  tokenOut,
  useSplit,
  onToggle,
  analyzing,
}: Props) {
  const { bestSplit, bestSingle, splitRecommended } = splitResult

  if (!bestSplit.isSplit) return null

  const singleOutput = Number(formatUnits(BigInt(bestSingle.toAmount), tokenOut.decimals))
  const splitOutput = Number(formatUnits(BigInt(bestSplit.totalOutput), tokenOut.decimals))
  const diff = splitOutput - singleOutput
  const improvementPercent = (bestSplit.improvementBps / 100).toFixed(2)

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-3">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-cream-65">Split Route</span>
          {analyzing && (
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cream-50" />
          )}
          {splitRecommended && !analyzing && (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">
              +{improvementPercent}%
            </span>
          )}
        </div>

        {/* Toggle */}
        <button
          onClick={onToggle}
          className={`relative h-5 w-9 rounded-full transition-colors ${
            useSplit ? 'bg-success/40' : 'bg-cream-15'
          }`}
          title={useSplit ? 'Disable split routing' : 'Enable split routing'}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${
              useSplit ? 'left-[18px] bg-success' : 'left-0.5 bg-cream-50'
            }`}
          />
        </button>
      </div>

      {/* Split visualization bar */}
      <div className="mb-2 flex h-6 w-full overflow-hidden rounded-lg">
        {bestSplit.legs.map((leg, i) => (
          <div
            key={`${leg.source}-${i}`}
            className="flex items-center justify-center text-[10px] font-bold"
            style={{
              width: `${leg.percent}%`,
              backgroundColor: getSourceColor(leg.source),
              color: getSourceTextColor(leg.source),
              borderRight: i < bestSplit.legs.length - 1 ? '1px solid rgba(0,0,0,0.3)' : 'none',
            }}
          >
            {leg.percent}%
          </div>
        ))}
      </div>

      {/* Leg details */}
      <div className="space-y-1">
        {bestSplit.legs.map((leg, i) => {
          const legOutput = Number(formatUnits(BigInt(leg.outputAmount), tokenOut.decimals))
          return (
            <div
              key={`${leg.source}-detail-${i}`}
              className="flex items-center justify-between text-xs"
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: getSourceColor(leg.source) }}
                />
                <span style={{ color: getSourceTextColor(leg.source) }}>
                  {sourceLabel(leg.source)}
                </span>
                <span className="text-cream-35">{leg.percent}%</span>
              </span>
              <span className="font-mono tabular-nums text-cream-65">
                {formatDisplay(legOutput, 4)} {tokenOut.symbol}
              </span>
            </div>
          )
        })}
      </div>

      {/* Comparison */}
      <div className="mt-2 border-t border-cream-08 pt-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-cream-35">Single source ({sourceLabel(bestSingle.source)})</span>
          <span className="font-mono tabular-nums text-cream-50">
            {formatDisplay(singleOutput, 4)} {tokenOut.symbol}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-cream-65">Split total ({bestSplit.legs.length} sources)</span>
          <span className="font-mono tabular-nums font-semibold text-success">
            {formatDisplay(splitOutput, 4)} {tokenOut.symbol}
          </span>
        </div>
        {diff > 0 && (
          <div className="mt-1 text-center text-[11px] font-semibold text-success">
            +{formatDisplay(diff, 4)} {tokenOut.symbol} extra ({improvementPercent}% better)
          </div>
        )}

        {/* Gas warning if split gas is significantly higher */}
        {bestSplit.totalGasUsd > bestSingle.gasUsd * 1.5 && bestSplit.totalGasUsd > 5 && (
          <div className="mt-1 text-center text-[10px] text-warning">
            Note: Split uses ~${bestSplit.totalGasUsd.toFixed(2)} gas vs ~${bestSingle.gasUsd.toFixed(2)} single
          </div>
        )}
      </div>
    </div>
  )
}
