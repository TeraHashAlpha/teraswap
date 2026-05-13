/**
 * Client-side analytics helpers.
 *
 * Fire-and-forget calls to the server-side logging API routes.
 * Never throw — silently swallow errors so analytics
 * never interfere with the swap/quote flow.
 */

import type { MetaQuoteResult } from './api'
import type { Token } from './tokens'

// ── Swap logging ────────────────────────────────────────────

interface LogSwapParams {
  wallet: string
  txHash?: string
  chainId?: number   // [FIX] Send actual chain ID (was defaulting to 1)
  source: string
  tokenIn: Token
  tokenOut: Token
  amountIn: string   // raw wei
  amountOut: string   // raw wei
  slippage: number
  mevProtected: boolean
  feeCollected: boolean
  feeAmount?: string
  status?: 'pending' | 'confirmed' | 'failed'
  // Security metadata for server-side tracking
  oracleUnavailable?: boolean
  priceDeviation?: number
  amountInUsd?: number
  /** [LP-05] Pre-swap MEV-savings estimate in output-token wei (raw). Computed
   *  from CoW vs non-CoW median; only populated for CoW-routed swaps where
   *  CoW's quote strictly beat the non-CoW median. */
  mevSavingsEstimate?: string
  /** [LP-05] Post-swap realised MEV surplus in output-token wei (raw):
   *  executedBuyAmount − quotedBuyAmount. Only populated on confirmed CoW
   *  swaps where the trades endpoint returned an executed amount. */
  mevSavingsActual?: string
  /** [P96] Dollar value of the gas the user avoided by going gasless.
   *  Sourced from analyzeGasless().gasSavingsUsd on the winning quote.
   *  Always 0 for non-CoW swaps. */
  gasSavingsUsd?: number
}

export function logSwapToSupabase(params: LogSwapParams): void {
  try {
    fetch('/api/log-swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: params.wallet,
        txHash: params.txHash,
        chainId: params.chainId,
        source: params.source,
        tokenIn: params.tokenIn.address,
        tokenInSymbol: params.tokenIn.symbol,
        tokenOut: params.tokenOut.address,
        tokenOutSymbol: params.tokenOut.symbol,
        amountIn: params.amountIn,
        amountOut: params.amountOut,
        slippage: params.slippage,
        mevProtected: params.mevProtected,
        feeCollected: params.feeCollected,
        feeAmount: params.feeAmount,
        status: params.status ?? 'pending',
        amountInUsd: params.amountInUsd,
        oracleUnavailable: params.oracleUnavailable ?? false,
        priceDeviation: params.priceDeviation ?? 0,
        mevSavingsEstimate: params.mevSavingsEstimate,
        mevSavingsActual: params.mevSavingsActual,
        gasSavingsUsd: params.gasSavingsUsd ?? 0,
      }),
    }).catch((err) => {
      console.warn('[analytics] logSwap failed:', err)
    })
  } catch {
    // silently ignore
  }
}

export function updateSwapStatus(
  txHash: string,
  status: 'confirmed' | 'failed',
  gasUsed?: string,
  gasPrice?: string,
  wallet?: string,
  /** [LP-05] Both fields are output-token wei strings; nullable in the row.
   *  estimate is the pre-swap CoW-vs-non-CoW-median delta (computed at the
   *  moment the swap was confirmed); actual is the realised solver surplus. */
  mevSavingsEstimate?: string,
  mevSavingsActual?: string,
): void {
  try {
    fetch('/api/log-swap', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        txHash, status, gasUsed, gasPrice, wallet,
        mevSavingsEstimate, mevSavingsActual,
      }),
    }).catch((err) => {
      console.warn('[analytics] updateSwapStatus failed:', err)
    })
  } catch {
    // silently ignore
  }
}

// ── Quote logging ───────────────────────────────────────────

interface LogQuoteParams {
  tokenIn: Token
  tokenOut: Token
  amountIn: string   // raw wei
  meta: MetaQuoteResult
  responseTimeMs: number
  wallet?: string
}

export function logQuoteToSupabase(params: LogQuoteParams): void {
  try {
    const { meta } = params
    const allQuotes: Record<string, string> = {}
    for (const q of meta.all) {
      allQuotes[q.source] = q.toAmount
    }

    fetch('/api/log-quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenIn: params.tokenIn.address,
        tokenInSymbol: params.tokenIn.symbol,
        tokenOut: params.tokenOut.address,
        tokenOutSymbol: params.tokenOut.symbol,
        amountIn: params.amountIn,
        sourcesQueried: meta.all.map((q) => q.source), // all sources that responded
        sourcesResponded: meta.all.map((q) => q.source),
        bestSource: meta.best?.source ?? null,
        bestAmountOut: meta.best?.toAmount ?? null,
        allQuotes,
        responseTimeMs: params.responseTimeMs,
        wallet: params.wallet,
      }),
    }).catch(() => {})
  } catch {
    // silently ignore
  }
}
