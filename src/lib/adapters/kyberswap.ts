import { AGGREGATOR_APIS } from '@/lib/constants'
import { clampSlippage } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount } = params
  const { base } = AGGREGATOR_APIS.kyberswap
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
  const data = await res.json()
  const route = data.data?.routeSummary

  if (!route) throw new Error('KyberSwap: no route found')

  return {
    source: 'kyberswap',
    toAmount: route.amountOut,
    estimatedGas: Number(route.gasUsd ? 0 : route.gas || 0),
    gasUsd: Number(route.gasUsd || 0),
    routes: route.route?.[0]?.map((r: any) =>
      r.pool ? `${r.pool}` : 'KyberSwap'
    ) ?? ['KyberSwap'],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage } = params
  const { base } = AGGREGATOR_APIS.kyberswap

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
  const routeData = await routeRes.json()
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
      recipient: from,
      slippageTolerance: Math.round(clampSlippage(slippage) * 100),
      source: 'TeraSwap',
    }),
  })
  if (!buildRes.ok) throw new Error(`KyberSwap build ${buildRes.status}`)
  const buildData = await buildRes.json()
  const txData = buildData.data

  return {
    source: 'kyberswap',
    toAmount: routeSummary.amountOut,
    estimatedGas: Number(txData.gas || routeSummary.gas || 0),
    gasUsd: Number(routeSummary.gasUsd || 0),
    routes: routeSummary.route?.[0]?.map((r: any) =>
      r.pool ? `${r.pool}` : 'KyberSwap'
    ) ?? ['KyberSwap'],
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
