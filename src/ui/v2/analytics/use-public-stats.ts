'use client'

import { useEffect, useState } from 'react'
import type { PublicStatsPayload } from '@/lib/public-stats-display'

export interface PublicStatsState {
  payload: PublicStatsPayload | null
  loading: boolean
  failed: boolean
}

/**
 * v1 reads `/api/stats` twice — `/analytics` (page.tsx: the Protocol performance block) and the Analytics tab
 * (AnalyticsDashboard: only the `gasless` block, "fire-and-forget"). v2 puts both on one page, so ONE read, same URL, same
 * once-on-mount (no polling), feeds both: a failure leaves the Gasless Adoption block hidden (as v1) and Protocol
 * performance "unavailable" (as v1). No hook of v1's is involved: the page's read is inline in page.tsx.
 */
export function usePublicStats(): PublicStatsState {
  const [state, setState] = useState<PublicStatsState>({ payload: null, loading: true, failed: false })
  useEffect(() => {
    let alive = true
    fetch('/api/stats')
      .then((r) => {
        if (!r.ok) throw new Error('stats_http')
        return r.json() as Promise<PublicStatsPayload>
      })
      .then((data) => {
        if (alive) setState({ payload: data, loading: false, failed: false })
      })
      .catch(() => {
        if (alive) setState({ payload: null, loading: false, failed: true })
      })
    return () => {
      alive = false
    }
  }, [])
  return state
}
