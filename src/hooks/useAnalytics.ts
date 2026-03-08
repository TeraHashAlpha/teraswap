import { useState, useEffect, useCallback, useRef } from 'react'
import { exportWalletSnapshot } from '@/lib/analytics-tracker'
import type { DashboardData } from '@/lib/analytics-types'

const REFRESH_INTERVAL_MS = 30_000 // refresh dashboard every 30s

interface UseAnalyticsResult {
  dashboard: DashboardData | null
  loading: boolean
  refresh: () => void
  exportSnapshot: () => ReturnType<typeof exportWalletSnapshot>
}

/**
 * Fetches analytics dashboard data from the server-side API.
 *
 * The /api/analytics endpoint queries the Supabase `swaps` table directly
 * and computes all dashboard metrics server-side. This replaces the previous
 * localStorage-based approach which couldn't see other users' trades.
 */
export function useAnalytics(): UseAnalyticsResult {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const fetchingRef = useRef(false)

  const refresh = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true

    try {
      const res = await fetch('/api/analytics')
      if (!res.ok) {
        console.warn('[useAnalytics] Failed to fetch:', res.status)
        return
      }

      const json = await res.json()

      if (json.dashboard) {
        // The server returns DashboardData without wallets array
        // (we don't expose wallet profiles in the public dashboard).
        // Fill in missing fields so the type is satisfied.
        const d = json.dashboard
        setDashboard({
          ...d,
          wallets: d.wallets ?? [],
          totalWallets: d.totalWallets ?? 0,
        })
      }
    } catch (err) {
      console.warn('[useAnalytics] Error fetching analytics:', err)
    } finally {
      fetchingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  return {
    dashboard,
    loading,
    refresh,
    exportSnapshot: exportWalletSnapshot,
  }
}
