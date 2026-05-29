import { getAdapterApiUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('sushiswap', chainId)
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
  const data = await parseJsonOrThrow<any>(res, 'SushiSwap')

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
  const { src, dst, amount, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('sushiswap', chainId)
  const qs = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amount: amount,
    maxSlippage: String(clampSlippage(slippage) / 100),
    // [P101] `to` is the RouteProcessor's output destination — defaults to sender.
    to: recipient ?? from,
    preferSushi: 'true',
  })
  const res = await fetch(`${base}?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`SushiSwap swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'SushiSwap')
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
