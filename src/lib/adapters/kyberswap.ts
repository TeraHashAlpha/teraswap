import { getAdapterApiUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

const EMBEDDED_ADDRESS = /0x[0-9a-fA-F]{40}/

/**
 * [fix/functional-chain-ui F2] Display name for one route hop. A hop's `pool` is a pool ADDRESS
 * (or a PMM / v4 id built from hex), never a name — it used to be rendered verbatim as the Route.
 * The recorded response names the venue in `exchange` ("uniswapv3", "pmm-1/uniswapv3"), with
 * `poolType` as the coarser fallback (src/lib/__fixtures__/kyberswap-routes-mainnet.ts). Anything
 * missing or carrying a 0x address/id falls back to 'KyberSwap'.
 */
export function kyberHopLabel(hop: unknown): string {
  const { exchange, poolType } = (hop ?? {}) as { exchange?: unknown; poolType?: unknown }
  for (const name of [exchange, poolType]) {
    if (typeof name === 'string' && name.trim() !== '' && !EMBEDDED_ADDRESS.test(name)) return name
  }
  return 'KyberSwap'
}

function kyberRouteLabels(routeSummary: any): string[] {
  return routeSummary.route?.[0]?.map((hop: unknown) => kyberHopLabel(hop)) ?? ['KyberSwap']
}

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('kyberswap', chainId)
  const qs = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amountIn: amount,
    saveGas: '0',
    gasInclude: 'true',
    clientData: JSON.stringify({ source: 'TeraSwap' }),
  })
  const res = await fetch(`${base}/api/v1/routes?${qs}`, {
    headers: {
      Accept: 'application/json',
      'x-client-id': 'teraswap',
    },
  })
  if (!res.ok) throw new Error(`KyberSwap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'KyberSwap')
  const route = data.data?.routeSummary

  if (!route) throw new Error('KyberSwap: no route found')

  return {
    source: 'kyberswap',
    toAmount: route.amountOut,
    estimatedGas: Number(route.gasUsd ? 0 : route.gas || 0),
    gasUsd: Number(route.gasUsd || 0),
    routes: kyberRouteLabels(route),
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('kyberswap', chainId)

  // Step 1: get route
  const routeParams = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amountIn: amount,
    saveGas: '0',
    gasInclude: 'true',
    clientData: JSON.stringify({ source: 'TeraSwap' }),
  })
  const routeRes = await fetch(`${base}/api/v1/routes?${routeParams}`, {
    headers: {
      Accept: 'application/json',
      'x-client-id': 'teraswap',
    },
  })
  if (!routeRes.ok) throw new Error(`KyberSwap route ${routeRes.status}`)
  const routeData = await parseJsonOrThrow<any>(routeRes, 'KyberSwap')
  const routeSummary = routeData.data?.routeSummary

  if (!routeSummary) throw new Error('KyberSwap: no route')

  // Step 2: build tx
  const buildRes = await fetch(`${base}/api/v1/route/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-client-id': 'teraswap',
    },
    body: JSON.stringify({
      routeSummary,
      sender: from,
      // [P101] Recipient defaults to sender when not provided.
      recipient: recipient ?? from,
      slippageTolerance: Math.round(clampSlippage(slippage) * 100),
      source: 'TeraSwap',
    }),
  })
  if (!buildRes.ok) throw new Error(`KyberSwap build ${buildRes.status}`)
  const buildData = await parseJsonOrThrow<any>(buildRes, 'KyberSwap')
  const txData = buildData.data

  return {
    source: 'kyberswap',
    toAmount: routeSummary.amountOut,
    estimatedGas: Number(txData.gas || routeSummary.gas || 0),
    gasUsd: Number(routeSummary.gasUsd || 0),
    routes: kyberRouteLabels(routeSummary),
    tx: {
      to: txData.routerAddress,
      data: txData.data,
      value: txData.value || '0',
      gas: Number(txData.gas || 0),
    },
  }
}

const adapter: DEXAdapter = {
  name: 'kyberswap' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
