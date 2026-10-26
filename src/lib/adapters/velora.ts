import { getAdapterApiUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

/**
 * [chore/copy-leftovers] Display names for the venues Velora's `swapExchanges[].exchange` reports. That field is
 * a Velora-internal venue id, not a name: the recorded response (src/lib/__fixtures__/velora-prices-mainnet.ts)
 * carries `metric-v1` (a market maker) beside `uniswapv4`, and the old code rendered the id as the Route.
 * Same approach as kyberHopLabel (#591): a name only when the response gives a venue we can name, else 'Velora'.
 * Keys are matched case-insensitively with separators stripped, so `UniswapV3` / `uniswap-v3` / `uniswapv3` agree.
 */
const VELORA_VENUE_NAMES: ReadonlyMap<string, string> = new Map([
  ['uniswapv2', 'Uniswap V2'],
  ['uniswapv3', 'Uniswap V3'],
  ['uniswapv4', 'Uniswap V4'],
  ['sushiswap', 'SushiSwap'],
  ['sushiswapv3', 'SushiSwap V3'],
  ['pancakeswapv2', 'PancakeSwap V2'],
  ['pancakeswapv3', 'PancakeSwap V3'],
  ['curve', 'Curve'],
  ['curvev1', 'Curve'],
  ['curvev2', 'Curve'],
  ['balancerv1', 'Balancer'],
  ['balancerv2', 'Balancer'],
  ['balancerv3', 'Balancer'],
  ['aerodrome', 'Aerodrome'],
  ['aerodromeslipstream', 'Aerodrome Slipstream'],
  ['camelotv3', 'Camelot V3'],
])

export function veloraHopLabel(exchange: unknown): string {
  if (typeof exchange !== 'string') return 'Velora'
  return VELORA_VENUE_NAMES.get(exchange.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? 'Velora'
}

/** One label per distinct venue, in route order (two `metric-v1` hops read as one "Velora", not "Velora + Velora"). */
export function veloraRouteLabels(priceRoute: any): string[] {
  const labels: string[] = []
  for (const r of priceRoute?.bestRoute ?? []) {
    for (const s of r?.swaps ?? []) {
      for (const e of s?.swapExchanges ?? []) {
        const label = veloraHopLabel(e?.exchange)
        if (!labels.includes(label)) labels.push(label)
      }
    }
  }
  return labels
}

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, srcDecimals = 18, dstDecimals = 18, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('velora', chainId)
  const qs = new URLSearchParams({
    srcToken: src,
    destToken: dst,
    amount,
    srcDecimals: srcDecimals.toString(),
    destDecimals: dstDecimals.toString(),
    side: 'SELL',
    network: chainId.toString(),
    version: '6.2',
  })
  const res = await fetch(`${base}/prices?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Velora ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Velora')
  const best = data.priceRoute

  return {
    source: 'velora',
    toAmount: best.destAmount,
    estimatedGas: Number(best.gasCost || 0),
    gasUsd: Number(best.gasCostUSD || 0),
    routes: veloraRouteLabels(best),
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient, srcDecimals = 18, dstDecimals = 18, chainId = DEFAULT_CHAIN_ID, signal } = params
  const base = getAdapterApiUrl('velora', chainId)

  // Step 1: get price route
  const priceParams = new URLSearchParams({
    srcToken: src, destToken: dst, amount,
    srcDecimals: srcDecimals.toString(),
    destDecimals: dstDecimals.toString(),
    side: 'SELL',
    network: chainId.toString(),
    version: '6.2',
  })
  // [SPRINT-9J J2] Thread the build abort signal so a slow Velora upstream is
  // cancelled when withSwapBuildRetry's timeout fires (the reported HTML-504 path).
  const priceRes = await fetch(`${base}/prices?${priceParams}`, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!priceRes.ok) throw new Error(`Velora price ${priceRes.status}`)
  const priceData = await parseJsonOrThrow<any>(priceRes, 'Velora')

  // Step 2: build tx
  const txBody = {
    srcToken: src,
    destToken: dst,
    srcAmount: amount,
    slippage: Math.round(clampSlippage(slippage) * 100), // bps (integer)
    priceRoute: priceData.priceRoute,
    userAddress: from,
    // [P101] Recipient defaults to sender when not provided.
    receiver: recipient ?? from,
    txOrigin: from,
    deadline: Math.floor(Date.now() / 1000) + 600,
  }
  const txRes = await fetch(`${base}/transactions/${chainId}?ignoreChecks=true&ignoreGasEstimate=true&onlyParams=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(txBody),
    signal,
  })
  if (!txRes.ok) {
    let errMsg = `Velora tx ${txRes.status}`
    try { const e = await txRes.json(); errMsg = e?.error || e?.message || errMsg } catch {}
    throw new Error(errMsg)
  }
  const txData = await parseJsonOrThrow<any>(txRes, 'Velora')

  return {
    source: 'velora',
    toAmount: priceData.priceRoute.destAmount,
    estimatedGas: Number(txData.gas || priceData.priceRoute.gasCost || 0),
    gasUsd: Number(priceData.priceRoute.gasCostUSD || 0),
    routes: veloraRouteLabels(priceData.priceRoute),
    tx: {
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      gas: Number(txData.gas || 0),
    },
  }
}

const adapter: DEXAdapter = {
  name: 'velora' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
