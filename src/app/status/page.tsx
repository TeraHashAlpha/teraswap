'use client'

/**
 * /status — Public monitoring dashboard.
 *
 * Shows real-time health of all monitored DEX sources.
 * Fetches from /api/monitor/status every 60s (client-side polling).
 * Gracefully degrades on KV failure or network error.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

// ── Types ──────────────────────────────────────────────

interface SourceStatus {
  id: string
  status: 'active' | 'degraded' | 'disabled'
  p95LatencyMs: number | null
  uptimePercent: number | null
  lastChecked: string | null
}

interface StatusData {
  healthy: boolean
  sources: SourceStatus[]
  lastTick: string | null
  tickFresh: boolean
}

// ── Friendly source labels ─────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  '1inch': '1inch',
  '0x': '0x / Matcha',
  velora: 'Velora',
  odos: 'Odos',
  kyberswap: 'KyberSwap',
  cowswap: 'CoW Protocol',
  uniswap: 'Uniswap V3',
  uniswapv3: 'Uniswap V3',
  openocean: 'OpenOcean',
  sushiswap: 'SushiSwap',
  balancer: 'Balancer',
  curve: 'Curve Finance',
  teraswap_order_engine: 'Order Engine',
}

// ── Helpers ────────────────────────────────────────────

function statusBadge(status: string): { dot: string; label: string; classes: string } {
  switch (status) {
    case 'active':
      return { dot: 'bg-success', label: 'Operational', classes: 'text-success bg-success/10 border-success/20' }
    case 'degraded':
      return { dot: 'bg-warning', label: 'Degraded', classes: 'text-warning bg-warning/10 border-warning/20' }
    case 'disabled':
      return { dot: 'bg-danger', label: 'Disabled', classes: 'text-danger bg-danger/10 border-danger/20' }
    default:
      return { dot: 'bg-cream-50', label: 'Unknown', classes: 'text-cream-50 bg-cream-08 border-cream-08' }
  }
}

function overallIndicator(data: StatusData | null, error: boolean): { label: string; classes: string; dotClass: string } {
  if (error || !data) {
    return { label: 'Unable to fetch status', classes: 'text-cream-50', dotClass: 'bg-cream-50' }
  }
  if (data.healthy) {
    return { label: 'All Systems Operational', classes: 'text-success', dotClass: 'bg-success' }
  }
  const hasDisabled = data.sources.some(s => s.status === 'disabled')
  if (hasDisabled) {
    return { label: 'Partial Outage', classes: 'text-danger', dotClass: 'bg-danger' }
  }
  return { label: 'Degraded Performance', classes: 'text-warning', dotClass: 'bg-warning' }
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '\u2014'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatUptime(pct: number | null): string {
  if (pct === null) return '\u2014'
  return `${pct.toFixed(1)}%`
}

function timeAgo(iso: string | null): string {
  if (!iso) return '\u2014'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

// ── Component ──────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60_000

export default function StatusPage() {
  const [data, setData] = useState<StatusData | null>(null)
  const [error, setError] = useState(false)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/monitor/status', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: StatusData = await res.json()
      setData(json)
      setError(false)
    } catch {
      setError(true)
    }
    setLastFetch(new Date())
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const overall = overallIndicator(data, error)

  // Source counts for summary
  const counts = data ? {
    active: data.sources.filter(s => s.status === 'active').length,
    degraded: data.sources.filter(s => s.status === 'degraded').length,
    disabled: data.sources.filter(s => s.status === 'disabled').length,
    total: data.sources.length,
  } : null

  return (
    <div className="min-h-screen bg-surface text-cream font-sans">
      {/* ── Header ──────────────────────────────────── */}
      <header className="border-b border-border px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-display font-semibold tracking-tight sm:text-2xl">
                TeraSwap Monitor
              </h1>
              <p className="mt-1 text-sm text-cream-50">
                Real-time source health status
              </p>
            </div>
            <Link
              href="/"
              className="text-sm text-cream-50 hover:text-cream transition-colors"
            >
              Back to app
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        {/* ── Overall status ────────────────────────── */}
        <div className="rounded-xl border border-border bg-surface-secondary p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <span className={`inline-block h-3 w-3 rounded-full ${overall.dotClass} ${data?.healthy ? 'animate-pulse-slow' : ''}`} />
            <span className={`text-lg font-semibold ${overall.classes}`}>
              {overall.label}
            </span>
          </div>

          {counts && (
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-success" />
                <span className="text-cream-75">{counts.active} active</span>
              </div>
              {counts.degraded > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-warning" />
                  <span className="text-cream-75">{counts.degraded} degraded</span>
                </div>
              )}
              {counts.disabled > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-danger" />
                  <span className="text-cream-75">{counts.disabled} disabled</span>
                </div>
              )}
              <div className="text-cream-35">
                {counts.total} sources monitored
              </div>
            </div>
          )}
        </div>

        {/* ── Error state ───────────────────────────── */}
        {error && !data && (
          <div className="mt-6 rounded-xl border border-danger/20 bg-danger/5 p-5 text-center">
            <p className="text-danger font-medium">Status data temporarily unavailable</p>
            <p className="mt-1 text-sm text-cream-50">Retrying every 60 seconds...</p>
          </div>
        )}

        {/* ── Source table ──────────────────────────── */}
        {data && (
          <div className="mt-6 overflow-hidden rounded-xl border border-border bg-surface-secondary">
            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-cream-50">
                    <th className="px-5 py-3 font-medium">Source</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium text-right">P95 Latency</th>
                    <th className="px-5 py-3 font-medium text-right">Uptime</th>
                    <th className="px-5 py-3 font-medium text-right">Last Checked</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.sources.map(source => {
                    const badge = statusBadge(source.status)
                    return (
                      <tr key={source.id} className="transition-colors hover:bg-surface-hover/50">
                        <td className="px-5 py-3.5 font-medium text-cream">
                          {SOURCE_LABELS[source.id] ?? source.id}
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.classes}`}>
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${badge.dot}`} />
                            {badge.label}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-cream-75">
                          {formatLatency(source.p95LatencyMs)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-mono text-cream-75">
                          {formatUptime(source.uptimePercent)}
                        </td>
                        <td className="px-5 py-3.5 text-right text-cream-50">
                          {timeAgo(source.lastChecked)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="divide-y divide-border sm:hidden">
              {data.sources.map(source => {
                const badge = statusBadge(source.status)
                return (
                  <div key={source.id} className="px-4 py-4">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-cream">
                        {SOURCE_LABELS[source.id] ?? source.id}
                      </span>
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.classes}`}>
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${badge.dot}`} />
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-2 flex gap-4 text-xs text-cream-50">
                      <span>
                        P95: <span className="font-mono text-cream-75">{formatLatency(source.p95LatencyMs)}</span>
                      </span>
                      <span>
                        Uptime: <span className="font-mono text-cream-75">{formatUptime(source.uptimePercent)}</span>
                      </span>
                      <span>
                        {timeAgo(source.lastChecked)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Loading state ─────────────────────────── */}
        {!data && !error && (
          <div className="mt-6 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-lg bg-surface-secondary"
              />
            ))}
          </div>
        )}
      </main>

      {/* ── Footer ──────────────────────────────────── */}
      <footer className="border-t border-border px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 text-xs text-cream-35">
          <div className="flex items-center gap-3">
            {data?.lastTick && (
              <span>
                Last tick: {timeAgo(data.lastTick)}
                {!data.tickFresh && (
                  <span className="ml-1 text-warning">(stale)</span>
                )}
              </span>
            )}
            {lastFetch && (
              <span>
                Refreshed: {lastFetch.toLocaleTimeString()}
              </span>
            )}
          </div>
          <span>Auto-refresh every 60s</span>
        </div>
      </footer>
    </div>
  )
}
