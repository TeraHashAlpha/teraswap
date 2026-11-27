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
  /** [P104 / 13A-L-02] Raw adapter gas USD estimate on the best non-CoW
   *  quote for the same pair. The server uses this (clamped) to derive
   *  gas_savings_usd — clients can no longer set the value directly.
   *  Only meaningful for CoW swaps; ignored for non-CoW sources. */
  bestNonCowGasUsd?: number
  /** [P118 / Sprint 16B] Quoted output (meta.best.toAmount) in raw token
   *  wei, BEFORE slippage tolerance is applied. Used for ADR-006 positive
   *  slippage instrumentation: surplus = actual_output - expected_output. */
  expectedOutput?: string
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
        bestNonCowGasUsd: params.bestNonCowGasUsd,
        expectedOutput: params.expectedOutput,
      }),
    }).catch((err) => {
      console.warn('[analytics] logSwap failed:', err)
    })
  } catch {
    // silently ignore
  }
}

/**
 * [P122 / 16B-I-04] Options-object signature so callers don't need
 * positional `undefined` placeholders to reach the trailing MEV-savings
 * fields.
 */
export interface UpdateSwapStatusParams {
  txHash: string
  status: 'confirmed' | 'failed'
  gasUsed?: string
  gasPrice?: string
  wallet?: string
  /**
   * [ADR-029, goal 133b I.1] The chain the transaction was SENT on (the swap's own chain, captured when it was sent;
   * never the wallet's chain at receipt time). The server reads the transaction there.
   */
  chainId?: number
  /** [LP-05] Pre-swap CoW-vs-non-CoW-median delta, output-token wei. */
  mevSavingsEstimate?: string
  /** [LP-05] Realised solver surplus, output-token wei. */
  mevSavingsActual?: string
}

/**
 * [ADR-029 section 7.3, goal 133b I.5] When the server answers 202 (its node has not got the transaction yet; it kept
 * the hash), the same confirmation is sent again after these pauses, then no more. Quiet: no prompt, nothing on the
 * page, nothing in the console.
 */
export const UPDATE_SWAP_STATUS_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const

export function updateSwapStatus(params: UpdateSwapStatusParams): void {
  const {
    txHash, status, gasUsed, gasPrice, wallet, chainId,
    mevSavingsEstimate, mevSavingsActual,
  } = params
  const body = JSON.stringify({
    txHash, status, gasUsed, gasPrice, wallet, chainId,
    mevSavingsEstimate, mevSavingsActual,
  })
  const send = (attempt: number): void => {
    try {
      fetch('/api/log-swap', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then((res) => {
        const delay = UPDATE_SWAP_STATUS_RETRY_DELAYS_MS[attempt]
        if (res?.status === 202 && delay !== undefined) setTimeout(() => send(attempt + 1), delay)
      }).catch((err) => {
        // The one warning there was before: a request that could not be sent. It ends the confirmation.
        console.warn('[analytics] updateSwapStatus failed:', err)
      })
    } catch {
      // silently ignore
    }
  }
  send(0)
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
