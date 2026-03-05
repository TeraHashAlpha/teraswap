'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { ETHERSCAN_TX } from '@/lib/constants'

interface SwapRecord {
  id: string
  wallet: string
  tx_hash: string | null
  source: string
  token_in_symbol: string
  token_out_symbol: string
  amount_in: string
  amount_out: string
  amount_in_usd: number | null
  amount_out_usd: number | null
  status: string
  fee_collected: boolean
  fee_amount: string | null
  slippage: number
  mev_protected: boolean
  created_at: string
  chain_id: number
}

function shortenHash(hash: string): string {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function formatAmount(val: string): string {
  const n = Number(val)
  if (isNaN(n)) return val
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  if (n >= 1) return n.toFixed(2)
  if (n >= 0.0001) return n.toFixed(4)
  return '<0.0001'
}

function sourceLabel(s: string): string {
  const map: Record<string, string> = {
    '1inch': '1inch',
    '0x': '0x',
    paraswap: 'ParaSwap',
    kyberswap: 'KyberSwap',
    odos: 'Odos',
    openocean: 'OpenOcean',
    uniswap: 'Uniswap',
  }
  return map[s?.toLowerCase()] || s || 'Unknown'
}

function statusBadge(status: string) {
  if (status === 'confirmed' || status === 'success') {
    return <span className="rounded bg-success/20 px-1 py-0.5 text-[9px] font-bold uppercase text-success">confirmed</span>
  }
  if (status === 'failed' || status === 'reverted') {
    return <span className="rounded bg-danger/20 px-1 py-0.5 text-[9px] font-bold uppercase text-danger">failed</span>
  }
  return <span className="rounded bg-cream-15/40 px-1 py-0.5 text-[9px] font-bold uppercase text-cream-35">pending</span>
}

export default function WalletHistory() {
  const { address, isConnected } = useAccount()
  const [swaps, setSwaps] = useState<SwapRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchHistory = useCallback(async () => {
    if (!address) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/history?wallet=${address}&limit=50`)
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      const json = await res.json()

      if (json.error) {
        setError(json.error)
        setLoading(false)
        return
      }

      setSwaps(json.swaps ?? [])
      setTotal(json.total ?? 0)
    } catch {
      setError('Could not fetch swap history')
    }
    setLoading(false)
  }, [address])

  useEffect(() => {
    if (isConnected && address) fetchHistory()
  }, [isConnected, address, fetchHistory])

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-6 text-center">
        <p className="text-sm text-cream-35">Connect your wallet to see swap history</p>
      </div>
    )
  }

  return (
    <div className="w-full space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cream-65">
          Swap History
          {total > 0 && <span className="ml-1.5 text-xs font-normal text-cream-35">({total})</span>}
        </h3>
        <button
          onClick={fetchHistory}
          disabled={loading}
          className="rounded-lg border border-cream-08 px-2.5 py-1 text-[11px] font-medium text-cream-50 transition hover:border-cream-35 hover:text-cream disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
      )}

      {/* Loading skeleton */}
      {loading && swaps.length === 0 && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-surface-tertiary" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && swaps.length === 0 && !error && (
        <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-6 text-center">
          <p className="text-sm text-cream-35">No swaps yet — your trades will appear here</p>
        </div>
      )}

      {/* Swap list */}
      {swaps.length > 0 && (
        <div className="space-y-1.5">
          {swaps.map((swap) => (
            <div
              key={swap.id || swap.tx_hash || swap.created_at}
              className="flex items-center justify-between rounded-xl border border-cream-08 bg-surface-tertiary px-3 py-2.5 transition hover:border-cream-15"
            >
              {/* Left: swap info */}
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cream-08 text-xs font-bold text-cream-50">
                  ⇄
                </div>
                <div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-cream-65">
                      {formatAmount(swap.amount_in)} {swap.token_in_symbol}
                    </span>
                    <span className="text-cream-35">→</span>
                    <span className="font-semibold text-cream-65">
                      {formatAmount(swap.amount_out)} {swap.token_out_symbol}
                    </span>
                    {statusBadge(swap.status)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-cream-35">
                    <span>via {sourceLabel(swap.source)}</span>
                    {swap.amount_in_usd != null && (
                      <span>≈ ${Number(swap.amount_in_usd).toFixed(2)}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Right: time + link */}
              <div className="text-right">
                <div className="text-[11px] text-cream-35">{timeAgo(swap.created_at)}</div>
                {swap.tx_hash && (
                  <a
                    href={`${ETHERSCAN_TX}${swap.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-cream-35 transition hover:text-cream"
                    title="View on Etherscan"
                  >
                    {shortenHash(swap.tx_hash)} ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      {swaps.length > 0 && (
        <p className="text-center text-[10px] text-cream-20">
          Showing {swaps.length} of {total} swaps on TeraSwap
        </p>
      )}
    </div>
  )
}
