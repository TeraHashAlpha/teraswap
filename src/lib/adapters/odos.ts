import { AGGREGATOR_APIS, CHAIN_ID, DEFAULT_SLIPPAGE } from '@/lib/constants'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount } = params
  const { base } = AGGREGATOR_APIS.odos
  const res = await fetch(`${base}/sor/quote/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: CHAIN_ID,
      inputTokens: [{ tokenAddress: src, amount }],
      outputTokens: [{ tokenAddress: dst, proportion: 1 }],
      userAddr: '0x0000000000000000000000000000000000000000',
      slippageLimitPercent: DEFAULT_SLIPPAGE,
      referralCode: 0,
      compact: true,
      simple: false,
      disableRFQs: false,
    }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Odos ${res.status}${errBody ? `: ${errBody.slice(0, 100)}` : ''}`)
  }
  const data = await res.json()

  return {
    source: 'odos',
    toAmount: data.outAmounts?.[0] ?? '0',
    estimatedGas: Number(data.gasEstimate || 0),
    gasUsd: Number(data.gasEstimateValue || 0),
    routes: data.pathViz?.map((p: any) => p.name) ?? ['Odos Smart Router v3'],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage } = params
  const { base } = AGGREGATOR_APIS.odos

  // Step 1: quote via v3
  const quoteRes = await fetch(`${base}/sor/quote/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: CHAIN_ID,
      inputTokens: [{ tokenAddress: src, amount }],
      outputTokens: [{ tokenAddress: dst, proportion: 1 }],
      userAddr: from,
      slippageLimitPercent: slippage,
      referralCode: 0,
      compact: true,
      simple: false,
      disableRFQs: false,
    }),
  })
  if (!quoteRes.ok) {
    const errBody = await quoteRes.text().catch(() => '')
    throw new Error(`Odos quote ${quoteRes.status}${errBody ? `: ${errBody.slice(0, 100)}` : ''}`)
  }
  const quoteData = await quoteRes.json()

  // Step 2: assemble tx
  const assembleRes = await fetch(`${base}/sor/assemble`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userAddr: from,
      pathId: quoteData.pathId,
    }),
  })
  if (!assembleRes.ok) {
    const errBody = await assembleRes.text().catch(() => '')
    throw new Error(`Odos assemble ${assembleRes.status}${errBody ? `: ${errBody.slice(0, 100)}` : ''}`)
  }
  const assembleData = await assembleRes.json()

  return {
    source: 'odos',
    toAmount: quoteData.outAmounts?.[0] ?? '0',
    estimatedGas: Number(assembleData.gasEstimate || quoteData.gasEstimate || 0),
    gasUsd: Number(quoteData.gasEstimateValue || 0),
    routes: quoteData.pathViz?.map((p: any) => p.name) ?? ['Odos Smart Router v3'],
    tx: {
      to: assembleData.transaction.to,
      data: assembleData.transaction.data,
      value: assembleData.transaction.value || '0',
      gas: Number(assembleData.transaction.gas || assembleData.gasEstimate || 0),
    },
  }
}

const adapter: DEXAdapter = {
  name: 'odos' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
