'use client'

import { useState, useEffect } from 'react'
import { useAccount } from 'wagmi'

interface Execution {
  id: string
  execution_number: number
  tx_hash: string | null
  amount_in: string | null
  amount_out: string | null
  gas_used: string | null
  status: string
  error: string | null
  executed_at: string
}

/**
 * Timeline showing individual DCA fills for an order.
 * Fetches from /api/orders/:id/executions.
 */
export default function ExecutionTimeline({ orderId, wallet }: { orderId: string; wallet: string }) {
  const [executions, setExecutions] = useState<Execution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!orderId || !wallet) return

    setLoading(true)
    fetch(`/api/orders/${orderId}/executions?wallet=${wallet}`)
      .then(res => res.json())
      .then(data => {
        setExecutions(data.executions || [])
        setError(data.error || null)
      })
      .catch(() => setError('Failed to load executions'))
      .finally(() => setLoading(false))
  }, [orderId, wallet])

  if (loading) {
    return (
      <div className="mb-3 flex items-center gap-2 text-[11px] text-cream-40">
        <div className="h-3 w-3 animate-spin rounded-full border border-cream-20 border-t-cream" />
        Loading fills...
      </div>
    )
  }

  if (error || executions.length === 0) return null

  return (
    <div className="mb-3">
      <p className="mb-2 text-[11px] font-semibold text-cream-50">Execution History</p>
      <div className="relative ml-2 border-l border-cream-08 pl-4">
        {executions.map((exec, i) => {
          const isSuccess = exec.status === 'success' || exec.status === 'executed'
          const isLast = i === executions.length - 1
          const time = new Date(exec.executed_at)

          return (
            <div key={exec.id || i} className={`relative pb-3 ${isLast ? 'pb-0' : ''}`}>
              {/* Timeline dot */}
              <div className={`absolute -left-[calc(1rem+3px)] top-1 h-1.5 w-1.5 rounded-full ${
                isSuccess ? 'bg-emerald-400' : 'bg-red-400'
              }`} />

              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-semibold text-cream">
                      Fill #{exec.execution_number}
                    </span>
                    <span className={`rounded px-1 py-0.5 text-[9px] font-bold ${
                      isSuccess
                        ? 'bg-emerald-400/10 text-emerald-300'
                        : 'bg-red-400/10 text-red-400'
                    }`}>
                      {isSuccess ? 'SUCCESS' : 'FAILED'}
                    </span>
                  </div>

                  {exec.error && (
                    <p className="mt-0.5 text-[10px] text-red-400/80 line-clamp-1">{exec.error}</p>
                  )}

                  {exec.tx_hash && (
                    <a
                      href={`https://etherscan.io/tx/${exec.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 flex items-center gap-0.5 text-[10px] text-cream-30 hover:text-cream transition-colors"
                    >
                      <span className="font-mono">{exec.tx_hash.slice(0, 10)}...{exec.tx_hash.slice(-6)}</span>
                      <span>↗</span>
                    </a>
                  )}
                </div>

                <span className="shrink-0 text-[10px] text-cream-30">
                  {time.toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
                  {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
