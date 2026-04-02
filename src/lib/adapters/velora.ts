import { AGGREGATOR_APIS, CHAIN_ID } from '@/lib/constants'
import { clampSlippage } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, srcDecimals = 18, dstDecimals = 18 } = params
  const { base } = AGGREGATOR_APIS.velora
  const qs = new URLSearchParams({
    srcToken: src,
    destToken: dst,
    amount,
    srcDecimals: srcDecimals.toString(),
    destDecimals: dstDecimals.toString(),
    side: 'SELL',
    network: CHAIN_ID.toString(),
    version: '6.2',
  })
  const res = await fetch(`${base}/prices?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Velora ${res.status}`)
  const data = await res.json()
  const best = data.priceRoute

  return {
    source: 'velora',
    toAmount: best.destAmount,
    estimatedGas: Number(best.gasCost || 0),
    gasUsd: Number(best.gasCostUSD || 0),
    routes: best.bestRoute?.flatMap((r: any) =>
      r.swaps?.flatMap((s: any) =>
        s.swapExchanges?.map((e: any) => e.exchange)
      )
    ) ?? [],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, srcDecimals = 18, dstDecimals = 18 } = params
  const { base } = AGGREGATOR_APIS.velora

  // Step 1: get price route
  const priceParams = new URLSearchParams({
    srcToken: src, destToken: dst, amount,
    srcDecimals: srcDecimals.toString(),
    destDecimals: dstDecimals.toString(),
    side: 'SELL',
    network: CHAIN_ID.toString(),
    version: '6.2',
  })
  const priceRes = await fetch(`${base}/prices?${priceParams}`, {
    headers: { Accept: 'application/json' },
  })
  if (!priceRes.ok) throw new Error(`Velora price ${priceRes.status}`)
  const priceData = await priceRes.json()

  // Step 2: build tx
  const txBody = {
    srcToken: src,
    destToken: dst,
    srcAmount: amount,
    slippage: Math.round(clampSlippage(slippage) * 100), // bps (integer)
    priceRoute: priceData.priceRoute,
    userAddress: from,
    receiver: from,
    txOrigin: from,
    deadline: Math.floor(Date.now() / 1000) + 600,
  }
  const txRes = await fetch(`${base}/transactions/${CHAIN_ID}?ignoreChecks=true&ignoreGasEstimate=true&onlyParams=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(txBody),
  })
  if (!txRes.ok) {
    let errMsg = `Velora tx ${txRes.status}`
    try { const e = await txRes.json(); errMsg = e?.error || e?.message || errMsg } catch {}
    throw new Error(errMsg)
  }
  const txData = await txRes.json()

  return {
    source: 'velora',
    toAmount: priceData.priceRoute.destAmount,
    estimatedGas: Number(txData.gas || priceData.priceRoute.gasCost || 0),
    gasUsd: Number(priceData.priceRoute.gasCostUSD || 0),
    routes: priceData.priceRoute.bestRoute?.flatMap((r: any) =>
      r.swaps?.flatMap((s: any) =>
        s.swapExchanges?.map((e: any) => e.exchange)
      )
    ) ?? [],
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
