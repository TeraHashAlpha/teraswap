import { AGGREGATOR_APIS } from '@/lib/constants'
import { clampSlippage } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount } = params
  const { base } = AGGREGATOR_APIS.sushiswap
  const qs = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amount: amount,
    maxSlippage: '0.01',
    preferSushi: 'true',
  })
  const res = await fetch(`${base}?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`SushiSwap ${res.status}`)
  const data = await res.json()

  if (!data.assumedAmountOut) throw new Error('SushiSwap: no route')

  return {
    source: 'sushiswap',
    toAmount: data.assumedAmountOut,
    estimatedGas: Number(data.gasSpent || 0),
    gasUsd: 0,
    routes: data.routeProcessorArgs?.routeCode
      ? ['SushiSwap RouteProcessor']
      : ['SushiSwap'],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage } = params
  const { base } = AGGREGATOR_APIS.sushiswap
  const qs = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amount: amount,
    maxSlippage: String(clampSlippage(slippage) / 100),
    to: from,
    preferSushi: 'true',
  })
  const res = await fetch(`${base}?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`SushiSwap swap ${res.status}`)
  const data = await res.json()
  if (!data.assumedAmountOut) throw new Error('SushiSwap: no route')

  const rpArgs = data.routeProcessorArgs
  return {
    source: 'sushiswap',
    toAmount: data.assumedAmountOut,
    estimatedGas: Number(data.gasSpent || 0),
    gasUsd: 0,
    routes: ['SushiSwap RouteProcessor'],
    tx: rpArgs ? {
      to: rpArgs.to as `0x${string}`,
      data: rpArgs.data as `0x${string}`,
      value: rpArgs.value || '0',
      gas: Number(data.gasSpent || 300_000),
    } : undefined,
  }
}

const adapter: DEXAdapter = {
  name: 'sushiswap' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
