import { AGGREGATOR_APIS } from '@/lib/constants'
import { clampSlippage } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount } = params
  const { base, key } = AGGREGATOR_APIS['1inch']
  if (!key) throw new Error('1inch API key not configured')
  const qs = new URLSearchParams({
    src, dst, amount,
    includeProtocols: 'true',
  })
  const res = await fetch(`${base}/quote?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`1inch ${res.status}`)
  const data = await res.json()

  return {
    source: '1inch',
    toAmount: data.toAmount,
    estimatedGas: Number(data.estimatedGas || 0),
    gasUsd: 0,
    routes: data.protocols?.flat(2)?.map((p: any) => p.name) ?? [],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage } = params
  const { base, key } = AGGREGATOR_APIS['1inch']
  if (!key) throw new Error('1inch API key not configured')
  const qs = new URLSearchParams({
    src, dst, amount, from,
    slippage: slippage.toString(),
    includeProtocols: 'true',
    disableEstimate: 'false',
    allowPartialFill: 'false',
  })
  const res = await fetch(`${base}/swap?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`1inch swap ${res.status}`)
  const data = await res.json()

  return {
    source: '1inch',
    toAmount: data.toAmount,
    estimatedGas: Number(data.tx?.gas || data.estimatedGas || 0),
    gasUsd: 0,
    routes: data.protocols?.flat(2)?.map((p: any) => p.name) ?? [],
    tx: {
      to: data.tx.to,
      data: data.tx.data,
      value: data.tx.value || '0',
      gas: Number(data.tx.gas || 0),
    },
  }
}

const adapter: DEXAdapter = {
  name: '1inch' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
