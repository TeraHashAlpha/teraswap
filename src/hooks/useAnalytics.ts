import { useState, useEffect, useCallback, useRef } from 'react'
import { computeDashboard, trackTrade, exportWalletSnapshot, syncFromSupabase, type TrackTradeParams } from '@/lib/analytics-tracker'
import { isSupabaseEnabled } from '@/lib/supabase'
import type { DashboardData } from '@/lib/analytics-types'

const REFRESH_INTERVAL_MS = 30_000 // refresh dashboard every 30s

interface UseAnalyticsResult {
  dashboard: DashboardData | null
  loading: boolean
  track: (params: TrackTradeParams) => void
  refresh: () => void
  exportSnapshot: () => ReturnType<typeof exportWalletSnapshot>
}

export function useAnalytics(): UseAnalyticsResult {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const syncedRef = useRef(false)

  const refresh = useCallback(() => {
    setLoading(true)
    try {
      const data = computeDashboard()
      setDashboard(data)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  const track = useCallback((params: TrackTradeParams) => {
    trackTrade(params)
    // Auto-refresh dashboard after tracking
    setTimeout(refresh, 100)
  }, [refresh])

  // Initial load: sync from Supabase first (if configured), then compute
  useEffect(() => {
    let cancelled = false

    async function init() {
      if (isSupabaseEnabled() && !syncedRef.current) {
        syncedRef.current = true
        await syncFromSupabase() // updates localStorage cache
      }
      if (!cancelled) refresh()
    }

    init()
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [refresh])

  return {
    dashboard,
    loading,
    track,
    refresh,
    exportSnapshot: exportWalletSnapshot,
  }
}
