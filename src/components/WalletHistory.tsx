'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { ETHERSCAN_TX } from '@/lib/constants'

interface AlchemyTransfer {
  hash: string
  from: string
  to: string
  value: number | null
  asset: string | null
  category: string
  blockNum: string
  metadata: { blockTimestamp: string }
  direction: 'sent' | 'received'
}

interface ParsedTx {
  hash: string
  direction: 'sent' | 'received'
  value: string
  asset: string
  timestamp: number
  to: string
  from: string
  category: string
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    external: 'Transfer',
    erc20: 'Token Transfer',
    erc721: 'NFT Transfer',
    erc1155: 'NFT Transfer',
  }
  return labels[cat] || cat
}

export default function WalletHistory() {
  const { address, isConnected } = useAccount()
  const [transactions, setTransactions] = useState<ParsedTx[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchHistory = useCallback(async () => {
    if (!address) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/wallet-history?address=${address}`)
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      const json = await res.json()

      if (json.error) {
        setError(json.error)
        setLoading(false)
        return
      }

      if (!json.transfers || json.transfers.length === 0) {
        setTransactions([])
        setLoading(false)
        return
      }

      // Deduplicate by hash (same tx can appear in sent + received)
      const seen = new Set<string>()
      const parsed: ParsedTx[] = []

      for (const t of json.transfers as AlchemyTransfer[]) {
        const key = `${t.hash}-${t.direction}`
        if (seen.has(key)) continue
        seen.add(key)

        const isSent = t.from.toLowerCase() === address.toLowerCase()

        parsed.push({
          hash: t.hash,
          direction: isSent ? 'sent' : 'received',
          value: t.value != null ? (t.value < 0.0001 ? '<0.0001' : t.value.toFixed(4)) : '0',
          asset: t.asset || 'ETH',
          timestamp: new Date(t.metadata.blockTimestamp).getTime(),
          to: t.to || '',
          from: t.from || '',
          category: t.category,
        })
      }

      setTransactions(parsed)
    } catch {
      setError('Could not fetch transaction history')
    }
    setLoading(false)
  }, [address])

  useEffect(() => {
    if (isConnected && address) fetchHistory()
  }, [isConnected, address, fetchHistory])

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-6 text-center">
        <p className="text-sm text-cream-35">Connect your wallet to see transaction history</p>
      </div>
    )
  }

  return (
    <div className="w-full space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cream-65">Wallet History</h3>
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
      {loading && transactions.length === 0 && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-tertiary" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && transactions.length === 0 && !error && (
        <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-6 text-center">
          <p className="text-sm text-cream-35">No transactions found</p>
        </div>
      )}

      {/* Transaction list */}
      {transactions.length > 0 && (
        <div className="space-y-1.5">
          {transactions.map((tx, idx) => (
            <div
              key={`${tx.hash}-${tx.direction}-${idx}`}
              className="flex items-center justify-between rounded-xl border border-cream-08 bg-surface-tertiary px-3 py-2.5 transition hover:border-cream-15"
            >
              <div className="flex items-center gap-3">
                {/* Direction icon */}
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${
                  tx.direction === 'sent'
                    ? 'bg-cream-08 text-cream-50'
                    : 'bg-success/15 text-success'
                }`}>
                  {tx.direction === 'sent' ? '↑' : '↓'}
                </div>

                <div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-cream-65">{categoryLabel(tx.category)}</span>
                  </div>
                  <div className="text-[11px] text-cream-35">
                    {tx.direction === 'sent' ? 'To' : 'From'}: {shortenAddress(tx.direction === 'sent' ? tx.to : tx.from)}
                  </div>
                </div>
              </div>

              <div className="text-right">
                {tx.value !== '0' && (
                  <div className={`text-xs font-medium tabular-nums ${
                    tx.direction === 'received' ? 'text-success' : 'text-cream-65'
                  }`}>
                    {tx.direction === 'sent' ? '-' : '+'}{tx.value} {tx.asset}
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-[10px] text-cream-35">
                  <span>{timeAgo(tx.timestamp)}</span>
                  <a
                    href={`${ETHERSCAN_TX}${tx.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="transition hover:text-cream"
                    title="View on Etherscan"
                  >
                    ↗
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Attribution */}
      {transactions.length > 0 && (
        <p className="text-center text-[10px] text-cream-20">
          Showing recent transactions via Alchemy
        </p>
      )}
    </div>
  )
}
