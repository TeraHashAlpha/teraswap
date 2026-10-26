import { useEffect, useState } from 'react'
import { parseSwapPriceTierResponse, type SwapPriceTierResponse } from '@/lib/swap-price-tier'

/**
 * [feat/swap-price-tiers D1] The SERVER's price tier for a swap pair — GET /api/swap-price-tier (the
 * ADR-024 quorum per leg: Chainlink → DefiLlama → CoinGecko). The browser never calls a price source.
 *
 *   data  the parsed answer, or null = UNKNOWN (not asked, in flight, non-2xx, network error, malformed).
 *         Unknown shows nothing: the client never applies a stricter rule than the server, and /api/swap
 *         still decides (its 409 `unpriced_ack_required` reopens the consent dialog).
 *
 * The answer is stored WITH the pair key it was fetched for and only read back while the pair still
 * matches, so a tier never carries over to a different pair and no state is written synchronously in
 * the effect (the loading / reset transitions are derived). The server caches 30 s per pair.
 */
export interface SwapPriceTierState {
  data: SwapPriceTierResponse | null
  loading: boolean
}

export function useSwapPriceTier(
  chainId: number,
  tokenIn: string | undefined,
  tokenOut: string | undefined,
  enabled = true,
): SwapPriceTierState {
  const key = enabled && tokenIn && tokenOut ? `${chainId}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}` : null
  const [answer, setAnswer] = useState<{ key: string; data: SwapPriceTierResponse | null } | null>(null)

  useEffect(() => {
    if (!key || !tokenIn || !tokenOut) return
    let cancelled = false
    const url = `/api/swap-price-tier?chainId=${chainId}&tokenIn=${encodeURIComponent(tokenIn)}&tokenOut=${encodeURIComponent(tokenOut)}`
    fetch(url)
      .then(r => (r.ok ? r.json() : null))
      .then(json => { if (!cancelled) setAnswer({ key, data: parseSwapPriceTierResponse(json) }) })
      .catch(() => { if (!cancelled) setAnswer({ key, data: null }) })
    return () => { cancelled = true }
  }, [key, chainId, tokenIn, tokenOut])

  const settled = key !== null && answer !== null && answer.key === key
  return { data: settled ? answer.data : null, loading: key !== null && !settled }
}
