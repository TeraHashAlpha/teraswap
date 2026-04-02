import { AGGREGATOR_APIS } from '@/lib/constants'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount } = params
  const { base } = AGGREGATOR_APIS.openocean
  const qs = new URLSearchParams({
    inTokenAddress: src,
    outTokenAddress: dst,
    amount: amount,
    gasPrice: '30',
    slippage: '1',
  })
  const res = await fetch(`${base}/quote?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OpenOcean ${res.status}`)
  const data = await res.json()
  if (data.code !== 200 || !data.data) throw new Error(data.message || 'OpenOcean: no quote')

  return {
    source: 'openocean',
    toAmount: data.data.outAmount,
    estimatedGas: Number(data.data.estimatedGas || 0),
    gasUsd: 0,
    routes: data.data.path?.routes?.[0]?.subRoutes?.map((r: any) =>
      r.dexes?.[0]?.dex || 'OpenOcean'
    ) ?? ['OpenOcean'],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage } = params
  const { base } = AGGREGATOR_APIS.openocean
  const qs = new URLSearchParams({
    inTokenAddress: src,
    outTokenAddress: dst,
    amount: amount,
    gasPrice: '30',
    slippage: String(slippage),
    account: from,
  })
  const res = await fetch(`${base}/swap?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OpenOcean swap ${res.status}`)
  const data = await res.json()
  if (data.code !== 200 || !data.data) throw new Error(data.message || 'OpenOcean: no swap')

  return {
    source: 'openocean',
    toAmount: data.data.outAmount,
    estimatedGas: Number(data.data.estimatedGas || 0),
    gasUsd: 0,
    routes: data.data.path?.routes?.[0]?.subRoutes?.map((r: any) =>
      r.dexes?.[0]?.dex || 'OpenOcean'
    ) ?? ['OpenOcean'],
    tx: {
      to: data.data.to as `0x${string}`,
      data: data.data.data as `0x${string}`,
      value: data.data.value || '0',
      gas: Number(data.data.estimatedGas || 0),
    },
  }
}

const adapter: DEXAdapter = {
  name: 'openocean' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
