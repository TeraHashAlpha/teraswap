import { getAdapterApiUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, srcDecimals = 18, dstDecimals = 18, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('velora', chainId)
  const qs = new URLSearchParams({
    srcToken: src,
    destToken: dst,
    amount,
    srcDecimals: srcDecimals.toString(),
    destDecimals: dstDecimals.toString(),
    side: 'SELL',
    network: chainId.toString(),
    version: '6.2',
  })
  const res = await fetch(`${base}/prices?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Velora ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Velora')
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
  const { src, dst, amount, from, slippage, recipient, srcDecimals = 18, dstDecimals = 18, chainId = DEFAULT_CHAIN_ID, signal } = params
  const base = getAdapterApiUrl('velora', chainId)

  // Step 1: get price route
  const priceParams = new URLSearchParams({
    srcToken: src, destToken: dst, amount,
    srcDecimals: srcDecimals.toString(),
    destDecimals: dstDecimals.toString(),
    side: 'SELL',
    network: chainId.toString(),
    version: '6.2',
  })
  // [SPRINT-9J J2] Thread the build abort signal so a slow Velora upstream is
  // cancelled when withSwapBuildRetry's timeout fires (the reported HTML-504 path).
  const priceRes = await fetch(`${base}/prices?${priceParams}`, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!priceRes.ok) throw new Error(`Velora price ${priceRes.status}`)
  const priceData = await parseJsonOrThrow<any>(priceRes, 'Velora')

  // Step 2: build tx
  const txBody = {
    srcToken: src,
    destToken: dst,
    srcAmount: amount,
    slippage: Math.round(clampSlippage(slippage) * 100), // bps (integer)
    priceRoute: priceData.priceRoute,
    userAddress: from,
    // [P101] Recipient defaults to sender when not provided.
    receiver: recipient ?? from,
    txOrigin: from,
    deadline: Math.floor(Date.now() / 1000) + 600,
  }
  const txRes = await fetch(`${base}/transactions/${chainId}?ignoreChecks=true&ignoreGasEstimate=true&onlyParams=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(txBody),
    signal,
  })
  if (!txRes.ok) {
    let errMsg = `Velora tx ${txRes.status}`
    try { const e = await txRes.json(); errMsg = e?.error || e?.message || errMsg } catch {}
    throw new Error(errMsg)
  }
  const txData = await parseJsonOrThrow<any>(txRes, 'Velora')

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
