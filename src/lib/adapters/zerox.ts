import { AGGREGATOR_APIS } from '@/lib/constants'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount } = params
  const { base, key } = AGGREGATOR_APIS['0x']
  const qs = new URLSearchParams({
    sellToken: src,
    buyToken: dst,
    sellAmount: amount,
  })
  const res = await fetch(`${base}/swap/permit2/quote?${qs}`, {
    headers: {
      '0x-api-key': key,
      '0x-version': 'v2',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`0x ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, '0x')

  return {
    source: '0x',
    toAmount: data.buyAmount,
    estimatedGas: Number(data.transaction?.gas || data.gas || 0),
    gasUsd: 0,
    routes: data.route?.fills?.map((f: any) => f.source) ?? [],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient } = params
  // [P101] 0x v2 permit2 swap doesn't expose a separate recipient field —
  // `taker` is both signer and destination. The /v1/swap route already
  // rejects this source (FEE_INCOMPATIBLE_SOURCES), so this branch is
  // mostly defensive: log when an upstream caller threads recipient.
  if (recipient && recipient !== from) {
    console.warn(
      `[0x] recipient (${recipient}) differs from sender (${from}) — `
        + '0x v2 has no recipient parameter; output will route to sender.',
    )
  }
  const { base, key } = AGGREGATOR_APIS['0x']
  const qs = new URLSearchParams({
    sellToken: src,
    buyToken: dst,
    sellAmount: amount,
    taker: from,
    slippageBps: Math.round(clampSlippage(slippage) * 100).toString(),
  })
  const res = await fetch(`${base}/swap/permit2/quote?${qs}`, {
    headers: {
      '0x-api-key': key,
      '0x-version': 'v2',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`0x swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, '0x')

  return {
    source: '0x',
    toAmount: data.buyAmount,
    estimatedGas: Number(data.transaction?.gas || data.gas || 0),
    gasUsd: 0,
    routes: data.route?.fills?.map((f: any) => f.source) ?? [],
    tx: {
      to: data.transaction.to,
      data: data.transaction.data,
      value: data.transaction.value || '0',
      gas: Number(data.transaction.gas || 0),
    },
  }
}

const adapter: DEXAdapter = {
  name: '0x' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
