'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] DCAFillsTimeline — presentational per-fill list, fed by the shared
 * useOrderExecutions hook (no self-fetch, so OrderDashboard's ExecutionTimeline stays untouched).
 * Newest first. Each fill: amountIn→amountOut (REAL decimals), per-fill USD via fillUsd ("—" when the
 * token has no known price — never a fabricated $0), a SUCCESS/FAILED pill, a chain-aware BaseScan
 * link, and a relative timestamp.
 */

import { formatUnits } from 'viem'
import { fillUsd } from '@/lib/order-engine/usd'
import { explorerTxUrl } from '@/lib/chains/tokens'
import type { FillRow } from '@/hooks/useOrderExecutions'

const AMOUNT_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })
const USD_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

function fmtAmount(raw: string | null | undefined, decimals: number, symbol: string): string {
  if (raw == null || raw === '') return '—'
  try {
    const n = Number(formatUnits(BigInt(String(raw).split('.')[0]), decimals))
    return Number.isFinite(n) ? `${AMOUNT_FMT.format(n)} ${symbol}` : '—'
  } catch {
    return '—'
  }
}

function fmtUsd(raw: string | null | undefined, decimals: number, symbol: string): string {
  const v = fillUsd(raw, decimals, symbol)
  if (v == null) return '—'
  if (v > 0 && v < 0.01) return '<$0.01'
  return `~$${USD_FMT.format(v)}`
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

interface Props {
  fills: FillRow[]
  tokenInSymbol: string
  tokenInDecimals: number
  tokenOutSymbol: string
  tokenOutDecimals: number
  chainId: number
}

export default function DCAFillsTimeline({
  fills, tokenInSymbol, tokenInDecimals, tokenOutSymbol, tokenOutDecimals, chainId,
}: Props) {
  if (!fills.length) return null
  // Newest first (rows arrive ascending by execution_number).
  const ordered = [...fills].sort((a, b) => b.execution_number - a.execution_number)

  return (
    <div className="mt-3 border-t border-cream-08 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-cream-50">Fills</span>
        <span className="text-[10px] text-cream-35">newest first</span>
      </div>
      <ul className="space-y-2">
        {ordered.map((f) => {
          const success = f.status === 'success' || f.status === 'executed' || f.status === 'confirmed'
          return (
            <li key={f.id} data-testid="fill-row" className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-cream">#{f.execution_number}</span>
                  <span className={`rounded px-1 py-0.5 text-[11px] font-bold ${success ? 'bg-emerald-400/10 text-emerald-300' : 'bg-red-400/10 text-red-400'}`}>
                    {success ? 'SUCCESS' : 'FAILED'}
                  </span>
                  <span className="text-cream-35" data-testid="fill-usd">{fmtUsd(f.amount_in, tokenInDecimals, tokenInSymbol)}</span>
                </div>
                <p className="mt-0.5 text-cream-65">
                  {fmtAmount(f.amount_in, tokenInDecimals, tokenInSymbol)} <span className="text-cream-35">→</span>{' '}
                  <span className="text-cream">{fmtAmount(f.amount_out, tokenOutDecimals, tokenOutSymbol)}</span>
                </p>
                {f.error && <p className="mt-0.5 text-[11px] text-red-400/80 line-clamp-1">{f.error}</p>}
                {f.tx_hash && (
                  <a
                    href={explorerTxUrl(f.tx_hash, chainId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex min-h-[44px] items-center gap-0.5 py-2 text-[11px] text-cream-35 transition-colors hover:text-cream-gold"
                  >
                    <span className="font-mono">{f.tx_hash.slice(0, 8)}…{f.tx_hash.slice(-6)}</span>
                    <span aria-hidden="true">↗</span>
                  </a>
                )}
              </div>
              <span className="shrink-0 text-[10px] text-cream-35">{relTime(f.created_at)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
