import { getAdapterApiUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('balancer', chainId)
  const res = await fetch(`${base}/order/${chainId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: src,
      buyToken: dst,
      orderKind: 'sell',
      amount: amount,
      gasPrice: '30000000000',
    }),
  })
  if (!res.ok) throw new Error(`Balancer ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Balancer')

  if (!data.buyAmount && !data.returnAmount) throw new Error('Balancer: no route')
  const outAmount = data.buyAmount || data.returnAmount || '0'

  return {
    source: 'balancer',
    toAmount: outAmount,
    estimatedGas: Number(data.gasEstimate || data.gas || 0),
    gasUsd: 0,
    routes: data.swaps?.map((s: any) => `Balancer Pool ${String(s.poolId).slice(0, 10)}...`) ?? ['Balancer SOR'],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('balancer', chainId)
  const res = await fetch(`${base}/order/${chainId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: src,
      buyToken: dst,
      orderKind: 'sell',
      amount: amount,
      sender: from,
      // [P101] Recipient defaults to sender when not provided.
      receiver: recipient ?? from,
      gasPrice: '30000000000',
      slippagePercentage: String(clampSlippage(slippage) / 100),
    }),
  })
  if (!res.ok) throw new Error(`Balancer swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Balancer')

  if (!data.buyAmount && !data.returnAmount) throw new Error('Balancer: no route')
  const outAmount = data.buyAmount || data.returnAmount || '0'

  return {
    source: 'balancer',
    toAmount: outAmount,
    estimatedGas: Number(data.gasEstimate || data.gas || 0),
    gasUsd: 0,
    routes: data.swaps?.map((s: any) => `Balancer Pool ${String(s.poolId).slice(0, 10)}...`) ?? ['Balancer SOR'],
    tx: data.to ? {
      to: data.to as `0x${string}`,
      data: data.data as `0x${string}`,
      value: data.value || '0',
      gas: Number(data.gasEstimate || data.gas || 300_000),
    } : undefined,
  }
}

const adapter: DEXAdapter = {
  name: 'balancer' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
