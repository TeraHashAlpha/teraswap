'use client'

/**
 * [P98] usePersonalAnalytics — read-only React hook around
 * /api/analytics/personal. Pins to the connected wallet (Wagmi) and
 * refetches on wallet change. We deliberately skip refetch-on-focus —
 * analytics is read-mostly, the API caches for 5 min, and a stale
 * dashboard is preferable to N requests every time the user tabs back.
 */

import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import type { PersonalAnalytics } from '@/lib/personal-analytics'

interface UsePersonalAnalyticsResult {
  data: PersonalAnalytics | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export function usePersonalAnalytics(): UsePersonalAnalyticsResult {
  const { address } = useAccount()
  const [data, setData] = useState<PersonalAnalytics | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const load = (wallet?: string) => {
    if (!wallet) {
      setData(null)
      setIsLoading(false)
      setError(null)
      return
    }

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setIsLoading(true)
    setError(null)
    fetch(`/api/analytics/personal?wallet=${wallet}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        return res.json() as Promise<PersonalAnalytics>
      })
      .then((json) => {
        if (ctrl.signal.aborted) return
        setData(json)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        setError(err instanceof Error ? err.message : 'Failed to load analytics')
        setIsLoading(false)
      })
  }

  useEffect(() => {
    load(address)
    return () => abortRef.current?.abort()
  }, [address])

  return {
    data,
    isLoading,
    error,
    refetch: () => load(address),
  }
}
