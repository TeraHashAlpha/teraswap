'use client'

/**
 * Transaction preview modal — "clear signing" for DeFi.
 *
 * Decodes swap calldata and displays human-readable transaction details
 * before the user signs. Shows: source DEX, function name, recipient,
 * token amounts, minimum output, deadline, and validation status.
 *
 * Graceful degradation: if decoding fails, shows raw calldata with a
 * warning. Never blocks the swap — the user can always proceed.
 */

import { useState, useMemo } from 'react'
import { formatUnits } from 'viem'
import { decodeTransactionPreview, type TransactionPreview as Preview } from '@/lib/calldata-decoder'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'
import type { Token } from '@/lib/tokens'

// ── Props ──────────────────────────────────────────────

interface TransactionPreviewProps {
  calldata: string
  routerAddress: string
  source: string
  userAddress: string
  tokenIn: Token | null
  tokenOut: Token | null
  amountInDisplay: string
  expectedOutput: string
  routeViaFeeCollector: boolean
  /** [H-04] FeeCollector-enforced minimum output in raw wei. Only meaningful when routeViaFeeCollector. */
  minimumOutput?: bigint
  onConfirm: () => void
  onCancel: () => void
}

// ── Helpers ────────────────────────────────────────────

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function formatDeadline(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = timestamp - now
  if (diff <= 0) return 'Expired'
  if (diff < 60) return `${diff}s remaining`
  if (diff < 3600) return `${Math.floor(diff / 60)}m remaining`
  return `${Math.floor(diff / 3600)}h remaining`
}

function formatDecodedAmount(
  raw: string | undefined,
  token: Token | null,
  decodedAddr: string | undefined,
): string | null {
  if (!raw || !token) return null
  // Only format if the decoded token address matches (or no decoded address)
  if (decodedAddr && decodedAddr.toLowerCase() !== token.address.toLowerCase()) return null
  try {
    const val = formatUnits(BigInt(raw), token.decimals)
    const num = parseFloat(val)
    if (num === 0) return null
    return num < 0.001
      ? `<0.001 ${token.symbol}`
      : `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token.symbol}`
  } catch {
    return null
  }
}

// ── Component ──────────────────────────────────────────

export default function TransactionPreview({
  calldata,
  routerAddress,
  source,
  userAddress,
  tokenIn,
  tokenOut,
  amountInDisplay,
  expectedOutput,
  routeViaFeeCollector,
  minimumOutput,
  onConfirm,
  onCancel,
}: TransactionPreviewProps) {
  const [showRaw, setShowRaw] = useState(false)

  const preview: Preview = useMemo(
    () => decodeTransactionPreview(calldata, routerAddress, source),
    [calldata, routerAddress, source],
  )

  const decodeFailed = preview.functionName === 'unknown'

  // Recipient badge
  const recipientLabel = useMemo(() => {
    if (!preview.recipient) {
      return { text: 'Your wallet (implicit)', badge: 'implicit' as const }
    }
    const lower = preview.recipient.toLowerCase()
    if (lower === userAddress.toLowerCase()) {
      return { text: 'Your wallet', badge: 'match' as const }
    }
    if (lower === FEE_COLLECTOR_ADDRESS.toLowerCase()) {
      return { text: 'FeeCollector', badge: 'feecollector' as const }
    }
    return { text: truncAddr(preview.recipient), badge: 'other' as const }
  }, [preview.recipient, userAddress])

  // Formatted decoded amounts
  const _decodedAmountIn = formatDecodedAmount(preview.amountIn, tokenIn, preview.tokenIn)
  const decodedMinOut = formatDecodedAmount(preview.amountOutMin, tokenOut, preview.tokenOut)

  // [H-04] FeeCollector-enforced minimum output — reverts with InsufficientOutput if not met.
  // Takes precedence over the router-internal minOut decoded from calldata, because this is
  // the value the FeeCollector contract actually checks against the user's balance delta.
  const enforcedMinOutDisplay = useMemo(() => {
    if (!routeViaFeeCollector || minimumOutput == null || minimumOutput <= 0n || !tokenOut) return null
    try {
      const val = formatUnits(minimumOutput, tokenOut.decimals)
      const num = parseFloat(val)
      if (num === 0) return null
      return num < 0.001
        ? `<0.001 ${tokenOut.symbol}`
        : `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tokenOut.symbol}`
    } catch {
      return null
    }
  }, [routeViaFeeCollector, minimumOutput, tokenOut])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Review transaction">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Modal */}
      <div className="relative w-full max-w-md rounded-2xl border border-cream-08 bg-surface-secondary shadow-2xl shadow-black/40">
        {/* Header */}
        <div className="border-b border-cream-08 px-5 py-4">
          <h2 className="text-base font-display font-semibold text-cream">Review Transaction</h2>
          <p className="mt-0.5 text-xs text-cream-50">Verify the details before signing</p>
        </div>

        {/* Body */}
        <div className="space-y-3 px-5 py-4">
          {/* Decode failure warning */}
          {decodeFailed && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              Could not decode transaction details. Verify in your wallet before signing.
            </div>
          )}

          {/* Source + Function */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-cream-50">Source</span>
            <span className="text-sm font-medium text-cream">
              {preview.sourceDex}
              <span className="ml-1.5 font-mono text-xs text-cream-50">
                {preview.functionName !== 'unknown' ? preview.functionName + '()' : ''}
              </span>
            </span>
          </div>

          {/* Amounts */}
          <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-cream-50">Send</span>
              <span className="font-medium text-cream">
                {amountInDisplay} {tokenIn?.symbol ?? ''}
              </span>
            </div>
            <div className="my-2 flex justify-center text-cream-35">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="rotate-90">
                <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-cream-50">Receive (est.)</span>
              <span className="font-medium text-cream">
                {expectedOutput} {tokenOut?.symbol ?? ''}
              </span>
            </div>
            {enforcedMinOutDisplay ? (
              // [H-04] FeeCollector-enforced minimum takes precedence — this is the value
              // that triggers an on-chain revert if the user's balance delta is below it.
              <div className="mt-2 flex items-center justify-between border-t border-cream-08 pt-2 text-xs">
                <span className="flex items-center gap-1 text-cream-50">
                  Minimum output
                  <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success">Enforced on-chain</span>
                </span>
                <span className="font-mono text-cream">{enforcedMinOutDisplay}</span>
              </div>
            ) : decodedMinOut ? (
              <div className="mt-2 flex items-center justify-between border-t border-cream-08 pt-2 text-xs">
                <span className="text-cream-35">Minimum output</span>
                <span className="font-mono text-cream-50">{decodedMinOut}</span>
              </div>
            ) : null}
          </div>

          {/* Recipient */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-cream-50">Recipient</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-sm text-cream">
                {preview.recipient ? truncAddr(preview.recipient) : 'msg.sender'}
              </span>
              {recipientLabel.badge === 'match' && (
                <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">Your wallet</span>
              )}
              {recipientLabel.badge === 'implicit' && (
                <span className="rounded-full bg-cream-08 px-2 py-0.5 text-[10px] font-medium text-cream-50">Implicit</span>
              )}
              {recipientLabel.badge === 'feecollector' && (
                <span className="rounded-full bg-cream-gold/10 px-2 py-0.5 text-[10px] font-medium text-cream-gold">FeeCollector</span>
              )}
              {recipientLabel.badge === 'other' && (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">Unknown</span>
              )}
            </div>
          </div>

          {/* Route */}
          {routeViaFeeCollector && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-cream-50">Route</span>
              <span className="text-xs text-cream-gold">Via TeraSwap FeeCollector (0.1% fee)</span>
            </div>
          )}

          {/* Deadline */}
          {preview.deadline != null && preview.deadline > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-cream-50">Deadline</span>
              <span className="text-xs text-cream-65">{formatDeadline(preview.deadline)}</span>
            </div>
          )}

          {/* Validation status */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-cream-50">Validation</span>
            {preview.validated ? (
              <span className="flex items-center gap-1 text-xs text-success">
                <span>&#10003;</span> Validated selector
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-warning">
                <span>&#9888;</span> {preview.validationReason ?? 'Unvalidated'}
              </span>
            )}
          </div>

          {/* Selector */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-cream-50">Selector</span>
            <span className="font-mono text-xs text-cream-35">{preview.selector}</span>
          </div>

          {/* Collapsible raw calldata */}
          <div className="border-t border-cream-08 pt-2">
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="flex w-full items-center justify-between text-xs text-cream-35 transition hover:text-cream-50"
            >
              <span>Raw calldata ({Math.floor(calldata.length / 2)} bytes)</span>
              <span className="text-[10px]">{showRaw ? '&#9650;' : '&#9660;'}</span>
            </button>
            {showRaw && (
              <div className="mt-2 max-h-24 overflow-auto rounded-lg bg-surface p-2 font-mono text-[10px] leading-relaxed text-cream-35 break-all">
                {calldata}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-cream-08 px-5 py-4">
          <button
            onClick={onConfirm}
            className="w-full rounded-full border-2 border-cream-80 bg-transparent py-3 text-[14px] font-bold uppercase tracking-[1.5px] text-cream transition-all hover:bg-cream hover:text-black"
          >
            Confirm &amp; Sign
          </button>
          <button
            onClick={onCancel}
            className="mt-2 w-full py-2 text-center text-xs text-cream-35 transition hover:text-cream-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
