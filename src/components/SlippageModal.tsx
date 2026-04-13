'use client'

import { useState } from 'react'

interface Props {
  value: number
  onChange: (val: number) => void
  onClose: () => void
  isAuto: boolean
  onAutoChange: (auto: boolean) => void
  tokenInSymbol?: string
  tokenOutSymbol?: string
}

const PRESETS = [0.1, 0.5, 1.0, 3.0]

// ── Smart auto-slippage logic ──
// Determines optimal slippage based on token pair characteristics
const STABLECOINS = ['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'PYUSD', 'USDe', 'USDS', 'BOLD']
const MAJOR_TOKENS = ['ETH', 'WETH', 'WBTC', 'cbBTC', 'wstETH', 'cbETH', 'weETH', 'rsETH']
const MEMECOINS = ['PEPE', 'SHIB', 'FLOKI', 'TURBO', 'MOG']

export function calculateAutoSlippage(tokenIn?: string, tokenOut?: string): number {
  if (!tokenIn || !tokenOut) return 0.5

  const inIsStable = STABLECOINS.includes(tokenIn)
  const outIsStable = STABLECOINS.includes(tokenOut)
  const inIsMajor = MAJOR_TOKENS.includes(tokenIn)
  const outIsMajor = MAJOR_TOKENS.includes(tokenOut)
  const inIsMeme = MEMECOINS.includes(tokenIn)
  const outIsMeme = MEMECOINS.includes(tokenOut)

  // Stable-to-stable: very low slippage
  if (inIsStable && outIsStable) return 0.1

  // Major-to-stable or stable-to-major: low slippage
  if ((inIsMajor && outIsStable) || (inIsStable && outIsMajor)) return 0.3

  // Major-to-major: moderate low
  if (inIsMajor && outIsMajor) return 0.5

  // Memecoins: higher slippage due to volatility
  if (inIsMeme || outIsMeme) return 2.0

  // Default: moderate
  return 0.5
}

export default function SlippageModal({ value, onChange, onClose, isAuto, onAutoChange, tokenInSymbol, tokenOutSymbol }: Props) {
  const [custom, setCustom] = useState('')
  const autoValue = calculateAutoSlippage(tokenInSymbol, tokenOutSymbol)

  function selectPreset(p: number) {
    onAutoChange(false)
    onChange(p)
    onClose()
  }

  function selectAuto() {
    onAutoChange(true)
    onChange(autoValue)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div
        className="w-full max-w-xs rounded-t-2xl border border-cream-08 bg-surface-secondary p-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold text-cream">Max slippage</h3>

        {/* Auto button */}
        <button
          onClick={selectAuto}
          className={`mb-3 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-xs font-medium transition ${
            isAuto
              ? 'border border-cream bg-cream text-black'
              : 'border border-cream-08 bg-surface-tertiary text-cream-65 hover:border-cream-35'
          }`}
        >
          <span className="flex items-center gap-2">
            <span className="text-sm">&#9881;</span>
            Auto
          </span>
          <span className={isAuto ? 'font-semibold' : 'text-cream-35'}>{autoValue}%</span>
        </button>

        <div className="mb-3 flex gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => selectPreset(p)}
              className={`flex-1 rounded-lg py-2.5 text-xs font-medium transition sm:py-2 ${
                !isAuto && value === p
                  ? 'border border-cream bg-cream text-black'
                  : 'border border-cream-08 bg-surface-tertiary text-cream-65 hover:border-cream-35'
              }`}
            >
              {p}%
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="number" step="0.1" min="0.01" max="15" placeholder="Custom" value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="flex-1 rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2 text-sm text-cream outline-none focus:border-cream-35"
          />
          <button
            onClick={() => {
              const val = Math.min(Math.max(Number(custom), 0.01), 15)
              if (val > 0 && val <= 15) { onAutoChange(false); onChange(val); onClose() }
            }}
            className="rounded-lg border border-cream bg-transparent px-3 py-2 text-sm font-medium text-cream transition hover:bg-cream hover:text-black"
          >
            OK
          </button>
        </div>

        {!isAuto && value > 5 && (
          <p className="mt-2 text-xs text-warning">High slippage may result in significant losses.</p>
        )}

        {isAuto && (
          <p className="mt-2 text-[11px] text-cream-35">
            Auto-slippage adjusts based on token pair volatility.
            {tokenInSymbol && tokenOutSymbol && (
              <span className="block mt-0.5">{tokenInSymbol}/{tokenOutSymbol}: {autoValue}% recommended</span>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
