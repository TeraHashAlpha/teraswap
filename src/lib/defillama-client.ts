/**
 * [fix/functional-chain-ui C8] Browser-side DefiLlama price lookup, routed through
 * /api/price/defillama so the visitor's IP never reaches DefiLlama directly. Same contract as
 * `fetchDefiLlamaPrice` in ./defillama (server-only): the price, or null on any miss or failure.
 */
import type { DefiLlamaPrice } from './defillama'

export async function fetchDefiLlamaPriceViaApi(
  tokenAddress: string,
  chainId: number,
): Promise<DefiLlamaPrice | null> {
  try {
    const qs = new URLSearchParams({ chainId: String(chainId), address: tokenAddress })
    const res = await fetch(`/api/price/defillama?${qs}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { price?: DefiLlamaPrice | null }
    return body.price ?? null
  } catch {
    return null
  }
}
