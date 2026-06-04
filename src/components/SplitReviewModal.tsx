'use client'

/**
 * [SPRINT-9R R1] Split-swap "Review Split Plan" modal — clear-signing for split routes.
 *
 * Before ANY split leg is signed, useSplitSwap freezes a PlannedLeg per route leg (Phase A:
 * fetch + validate + simulate + freeze the exact tx). This modal renders every leg's trust
 * surface — the SAME fields as the single-swap TransactionPreview (source, send/receive, min
 * output, router, validated selector, recipient) — by reusing the shared decodeTransactionPreview.
 * Confirming calls confirmPlan(), which signs the frozen legs 1:1 (no re-fetch). It does not
 * decode/validate anything itself beyond display — the gates already ran in Phase A.
 */

import { useMemo } from 'react'
import { formatUnits } from 'viem'
import { decodeTransactionPreview } from '@/lib/calldata-decoder'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'
import type { Token } from '@/lib/tokens'
import type { PlannedLeg } from '@/hooks/useSplitSwap'

function truncAddr(addr: string): string {
  if (!addr || addr.length <= 12) return addr || '—'
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function fmtAmount(raw: string | bigint | undefined, token: Token | null): string {
  if (raw == null || !token) return '—'
  try {
    const num = parseFloat(formatUnits(typeof raw === 'bigint' ? raw : BigInt(raw), token.decimals))
    if (!isFinite(num)) return '—'
    if (num === 0) return `0 ${token.symbol}`
    return num < 0.001
      ? `<0.001 ${token.symbol}`
      : `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token.symbol}`
  } catch {
    return '—'
  }
}

interface Props {
  plannedLegs: PlannedLeg[]
  tokenIn: Token | null
  tokenOut: Token | null
  userAddress: string
  onConfirm: () => void
  onCancel: () => void
}

function LegRow({
  leg, index, tokenIn, tokenOut, userAddress,
}: { leg: PlannedLeg; index: number; tokenIn: Token | null; tokenOut: Token | null; userAddress: string }) {
  const preview = useMemo(
    () => (leg.routerCalldata ? decodeTransactionPreview(leg.routerCalldata, leg.routerAddress, leg.source) : null),
    [leg.routerCalldata, leg.routerAddress, leg.source],
  )
  const skipped = leg.status === 'skipped'

  const recipient = preview?.recipient ?? null
  const recipBadge: 'match' | 'implicit' | 'feecollector' | 'other' = !recipient
    ? 'implicit'
    : recipient.toLowerCase() === userAddress.toLowerCase()
      ? 'match'
      : recipient.toLowerCase() === FEE_COLLECTOR_ADDRESS.toLowerCase()
        ? 'feecollector'
        : 'other'

  return (
    <div
      data-testid={`split-leg-${index}`}
      className={`rounded-xl border p-3 ${skipped ? 'border-cream-08 bg-surface opacity-60' : 'border-cream-08 bg-surface-tertiary'}`}
    >
      {/* Leg header: source + function + percent */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium text-cream">
          Leg {index + 1}: {preview?.sourceDex ?? leg.source}
          <span className="font-mono text-xs text-cream-50">
            {preview && preview.functionName !== 'unknown' ? `${preview.functionName}()` : ''}
          </span>
        </span>
        <span className="text-xs text-cream-50">{leg.percent}%</span>
      </div>

      {skipped ? (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          &#9888; Skipped — will NOT be signed. {leg.error ?? 'Failed pre-flight checks.'}
        </div>
      ) : (
        <>
          {/* Amounts */}
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-cream-50">Send</span>
            <span className="font-medium text-cream">{fmtAmount(leg.legAmount, tokenIn)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-cream-50">Receive (est.)</span>
            <span className="font-medium text-cream">{fmtAmount(leg.expectedOut, tokenOut)}</span>
          </div>
          {/* Minimum output — FeeCollector-enforced when routed via the FeeCollector */}
          {leg.routeViaFeeCollector && leg.legMinOutput > 0n && (
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 text-cream-50">
                Minimum output
                <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success">Enforced on-chain</span>
              </span>
              <span className="font-mono text-cream">{fmtAmount(leg.legMinOutput, tokenOut)}</span>
            </div>
          )}
          {/* Router */}
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-cream-50">Router</span>
            <span className="font-mono text-cream-65">{truncAddr(leg.routerAddress)}</span>
          </div>
          {/* Recipient */}
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-cream-50">Recipient</span>
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-cream">{recipient ? truncAddr(recipient) : 'msg.sender'}</span>
              {recipBadge === 'match' && <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">Your wallet</span>}
              {recipBadge === 'implicit' && <span className="rounded-full bg-cream-08 px-2 py-0.5 text-[10px] font-medium text-cream-50">Implicit</span>}
              {recipBadge === 'feecollector' && <span className="rounded-full bg-cream-gold/10 px-2 py-0.5 text-[10px] font-medium text-cream-gold">FeeCollector</span>}
              {recipBadge === 'other' && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">Unknown</span>}
            </span>
          </div>
          {/* Validation + selector */}
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-cream-50">Validation</span>
            {preview?.validated ? (
              <span className="flex items-center gap-1 text-success">&#10003; Validated selector <span className="font-mono text-cream-35">{preview.selector}</span></span>
            ) : (
              <span className="flex items-center gap-1 text-warning">&#9888; {preview?.validationReason ?? 'Unvalidated'}</span>
            )}
          </div>
          {/* [P209] Fail-open flag — leg simulated inconclusively */}
          {leg.simulated === false && (
            <div className="mt-1 text-[11px] text-warning">&#9888; Simulation unavailable — protected only by the on-chain minimum output.</div>
          )}
          {leg.routeViaFeeCollector && (
            <div className="mt-1 text-[11px] text-cream-gold">Via TeraSwap FeeCollector (0.1% fee)</div>
          )}
        </>
      )}
    </div>
  )
}

export default function SplitReviewModal({
  plannedLegs, tokenIn, tokenOut, userAddress, onConfirm, onCancel,
}: Props) {
  const signableCount = plannedLegs.filter(p => p.status === 'reviewed').length

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Review split swap">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative flex max-h-[85vh] w-full animate-slide-up flex-col overflow-hidden rounded-t-2xl border border-cream-08 bg-surface-secondary shadow-2xl shadow-black/40 sm:max-h-[85vh] sm:max-w-md sm:animate-fade-slide-in sm:rounded-2xl">
        <div className="mx-auto mt-3 mb-1 h-1 w-10 shrink-0 rounded-full bg-cream-15 sm:hidden" />

        <div className="shrink-0 border-b border-cream-08 px-5 py-4">
          <h2 className="text-base font-display font-semibold text-cream">Review Split Swap</h2>
          <p className="mt-0.5 text-xs text-cream-50">
            This routes across {plannedLegs.length} {plannedLegs.length === 1 ? 'leg' : 'legs'}.
            Verify each before signing — you&apos;ll approve {signableCount} wallet {signableCount === 1 ? 'prompt' : 'prompts'}, one per leg.
          </p>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {plannedLegs.map((leg, i) => (
            <LegRow key={i} leg={leg} index={i} tokenIn={tokenIn} tokenOut={tokenOut} userAddress={userAddress} />
          ))}
        </div>

        <div className="shrink-0 border-t border-cream-08 bg-surface-secondary px-5 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:pb-4">
          <button
            onClick={onConfirm}
            disabled={signableCount === 0}
            className="flex h-12 w-full items-center justify-center rounded-full border-2 border-cream-80 bg-transparent text-[14px] font-bold uppercase tracking-[1.5px] text-cream transition-all hover:bg-cream hover:text-black disabled:cursor-not-allowed disabled:opacity-40 sm:h-auto sm:py-3"
          >
            Confirm &amp; Sign {signableCount} {signableCount === 1 ? 'leg' : 'legs'}
          </button>
          <button
            onClick={onCancel}
            className="mt-2 flex h-12 w-full items-center justify-center text-center text-xs text-cream-35 transition hover:text-cream-50 sm:h-auto sm:py-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
