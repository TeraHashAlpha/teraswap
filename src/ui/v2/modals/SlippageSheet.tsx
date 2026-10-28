'use client'

import { useState } from 'react'
import { calculateAutoSlippage } from '@/components/SlippageModal'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { Button, Chip, Input } from '../primitives'
import { Sheet } from './Sheet'

/** v1's presets and custom bounds, unchanged (SlippageModal.tsx). */
export const SLIPPAGE_PRESETS = [0.1, 0.5, 1.0, 3.0]
export const SLIPPAGE_MIN = 0.01
export const SLIPPAGE_MAX = 15

interface Props {
  value: number
  onChange: (val: number) => void
  onClose: () => void
  isAuto: boolean
  onAutoChange: (auto: boolean) => void
  tokenInSymbol?: string
  tokenOutSymbol?: string
  chainId?: number
}

/**
 * [ADR-025] Round 7 frame 22 — the max-slippage editor. Same contract as v1's SlippageModal (same props, same calls in the same
 * order: onAutoChange then onChange then onClose), same presets, same 0.01–15 clamp, same two notes. Display and wiring only:
 * what the value MEANS (the on-chain floor) is decided where it is consumed, exactly as in v1.
 */
export function SlippageSheet({ value, onChange, onClose, isAuto, onAutoChange, tokenInSymbol, tokenOutSymbol, chainId = DEFAULT_CHAIN_ID }: Props) {
  const [custom, setCustom] = useState('')
  const autoValue = calculateAutoSlippage(tokenInSymbol, tokenOutSymbol, chainId)
  // v1 would turn an empty field into 0.01 %. An empty / non-numeric field is "nothing typed", not a request for the minimum.
  const customNumber = custom.trim() === '' ? NaN : Number(custom)
  const customValid = Number.isFinite(customNumber)

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
  function applyCustom() {
    if (!customValid) return
    const val = Math.min(Math.max(customNumber, SLIPPAGE_MIN), SLIPPAGE_MAX)
    if (val > 0 && val <= SLIPPAGE_MAX) {
      onAutoChange(false)
      onChange(val)
      onClose()
    }
  }

  return (
    <Sheet name="slippage" size="sm" title="Max slippage" onClose={onClose}>
      <div className="mt-5">
        <Chip selected={isAuto} onClick={selectAuto} className="w-full justify-between !px-0" data-slippage="auto">
          <span className="flex items-center gap-2">
            <span aria-hidden="true">&#9881;</span>
            Auto
          </span>
          <span>{autoValue}%</span>
        </Chip>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1">
        {SLIPPAGE_PRESETS.map((p) => (
          <Chip key={p} selected={!isAuto && value === p} onClick={() => selectPreset(p)} className="justify-center" data-slippage={p}>
            {p}%
          </Chip>
        ))}
      </div>

      <div className="mt-4 flex items-end gap-4">
        <Input
          type="number"
          step="0.1"
          min={SLIPPAGE_MIN}
          max={SLIPPAGE_MAX}
          placeholder="Custom"
          aria-label="Custom slippage"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyCustom()
          }}
        />
        <Button variant="text" onClick={applyCustom} disabled={!customValid}>
          OK
        </Button>
      </div>

      {!isAuto && value > 5 && <p className="mt-3 text-[13px] text-v2-amber">High slippage may result in significant losses.</p>}

      {isAuto && (
        <p className="mt-3 text-[12px] leading-relaxed text-v2-muted">
          Auto-slippage adjusts based on token pair volatility.
          {tokenInSymbol && tokenOutSymbol && (
            <span className="mt-0.5 block text-v2-teal">
              {tokenInSymbol}/{tokenOutSymbol}: {autoValue}% recommended
            </span>
          )}
        </p>
      )}
    </Sheet>
  )
}
