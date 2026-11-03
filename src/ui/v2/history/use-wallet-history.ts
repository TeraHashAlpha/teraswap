'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { ordersReadHeaders } from '@/lib/order-engine/read-auth'
import type { SwapRecord } from './history-model'

/**
 * [B7 C3] v1 WalletHistory's read, restated (v1 keeps it inside the component, so there is no hook to import): the SAME request —
 * `GET /api/history?wallet=<address>&limit=50` with the session's orders read signature when one is cached (`ordersReadHeaders`, v1's
 * helper: present → the server merges the wallet's DCA fills; never prompts from here) — the same state (records, total, loading, error),
 * the same error words, a fetch on connect and on Refresh. One page of 50, as v1: no pagination, no infinite scroll.
 */
export function useWalletHistory() {
  const { address, isConnected } = useAccount()
  const [swaps, setSwaps] = useState<SwapRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The instant the records arrived: "time ago" is measured from it (v1 reads Date.now() while rendering).
  const [fetchedAt, setFetchedAt] = useState(0)

  const fetchHistory = useCallback(async () => {
    if (!address) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/history?wallet=${address}&limit=50`, { headers: ordersReadHeaders(address) ?? undefined })
      if (!res.ok) throw new Error(`API returned ${res.status}`)
      const json = await res.json()
      if (json.error) {
        setError(json.error)
        setLoading(false)
        return
      }
      setSwaps(json.swaps ?? [])
      setTotal(json.total ?? 0)
      setFetchedAt(Date.now())
    } catch {
      setError('Could not fetch swap history')
    }
    setLoading(false)
  }, [address])

  useEffect(() => {
    if (!isConnected || !address) return
    let live = true
    // v1 calls fetchHistory() from this effect; deferred one microtask here so no state is set synchronously in the effect body.
    void Promise.resolve().then(() => { if (live) void fetchHistory() })
    return () => { live = false }
  }, [isConnected, address, fetchHistory])

  return { address, isConnected, swaps, total, loading, error, fetchedAt, fetchHistory }
}
