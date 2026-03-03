'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { formatUnits } from 'viem'
import { ETHERSCAN_TX } from '@/lib/constants'

interface EtherscanTx {
  hash: string
  from: string
  to: string
  value: string
  timeStamp: string
  gasUsed: string
  gasPrice: string
  isError: string
  functionName: string
  methodId: string
  blockNumber: string
}

interface ParsedTx {
  hash: string
  direction: 'sent' | 'received'
  value: string // ETH
  gasCost: string // ETH
  timestamp: number
  to: string
  from: string
  status: 'success' | 'failed'
  method: string
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts * 1000
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function parseMethodName(fn: string): string {
  if (!fn) return 'Transfer'
  const match = fn.match(/^(\w+)\(/)
  if (match) {
    const name = match[1]
    // Common DeFi methods
    const labels: Record<string, string> = {
      swap: 'Swap',
      swapExactTokensForTokens: 'Swap',
      swapExactETHForTokens: 'Swap',
      swapTokensForExactETH: 'Swap',
      multicall: 'Multicall',
      execute: 'Execute',
      approve: 'Approve',
      transfer: 'Transfer',
      deposit: 'Deposit',
      withdraw: 'Withdraw',
      claim: 'Claim',
      stake: 'Stake',
      unstake: 'Unstake',
    }
    return labels[name] || name.charAt(0).toUpperCase() + name.slice(1)
  }
  return 'Contract Call'
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
      // Use Etherscan API (free tier, no key needed for basic calls)
      const res = await fetch(
        `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=25&sort=desc`
      )
      if (!res.ok) throw new Error(`Etherscan returned ${res.status}`)
      const json = await res.json()

      if (json.status !== '1' || !json.result || !Array.isArray(json.result)) {
        if (json.message === 'No transactions found') {
          setTransactions([])
        } else {
          setError('Could not fetch transaction history')
        }
        setLoading(false)
        return
      }

      const parsed: ParsedTx[] = json.result.map((tx: EtherscanTx) => {
        const isSent = tx.from.toLowerCase() === address.toLowerCase()
        const value = formatUnits(BigInt(tx.value || '0'), 18)
        const gasCost = formatUnits(BigInt(tx.gasUsed || '0') * BigInt(tx.gasPrice || '0'), 18)

        return {
          hash: tx.hash,
          direction: isSent ? 'sent' : 'received',
          value: Number(value).toFixed(4),
          gasCost: Number(gasCost).toFixed(5),
          timestamp: Number(tx.timeStamp),
          to: tx.to,
          from: tx.from,
          status: tx.isError === '0' ? 'success' : 'failed',
          method: parseMethodName(tx.functionName),
        }
      })

      setTransactions(parsed)
    } catch {
      setError('Network error fetching history')
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

      {/* Transaction list */}
      {!loading && transactions.length === 0 && !error && (
        <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-6 text-center">
          <p className="text-sm text-cream-35">No transactions found</p>
        </div>
      )}

      {transactions.length > 0 && (
        <div className="space-y-1.5">
          {transactions.map((tx) => (
            <div
              key={tx.hash}
              className="flex items-center justify-between rounded-xl border border-cream-08 bg-surface-tertiary px-3 py-2.5 transition hover:border-cream-15"
            >
              <div className="flex items-center gap-3">
                {/* Direction icon */}
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${
                  tx.status === 'failed'
                    ? 'bg-danger/15 text-danger'
                    : tx.direction === 'sent'
                    ? 'bg-cream-08 text-cream-50'
                    : 'bg-success/15 text-success'
                }`}>
                  {tx.status === 'failed' ? '✕' : tx.direction === 'sent' ? '↑' : '↓'}
                </div>

                <div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-cream-65">{tx.method}</span>
                    {tx.status === 'failed' && (
                      <span className="rounded bg-danger/20 px-1 py-0.5 text-[9px] font-bold text-danger">FAILED</span>
                    )}
                  </div>
                  <div className="text-[11px] text-cream-35">
                    {tx.direction === 'sent' ? 'To' : 'From'}: {shortenAddress(tx.direction === 'sent' ? tx.to : tx.from)}
                  </div>
                </div>
              </div>

              <div className="text-right">
                {Number(tx.value) > 0 && (
                  <div className={`text-xs font-medium tabular-nums ${
                    tx.direction === 'received' ? 'text-success' : 'text-cream-65'
                  }`}>
                    {tx.direction === 'sent' ? '-' : '+'}{tx.value} ETH
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

      {/* Etherscan attribution */}
      {transactions.length > 0 && (
        <p className="text-center text-[10px] text-cream-20">
          Showing last 25 transactions via Etherscan
        </p>
      )}
    </div>
  )
}
