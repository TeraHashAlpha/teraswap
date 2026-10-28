/**
 * [ADR-025] What the review sheet SHOWS, derived once from the objects the Swap card already holds (B3's QuoteView + v1's
 * MetaQuoteResult + the server's price tier). Pure and display-only: nothing here is signed or sent. The frozen, signable values
 * (calldata, the FeeCollector minimum, the CoW order) are B5's and arrive as props on the sheets, never from here.
 */
import { parseUnits } from 'viem'
import type { MetaQuoteResult } from '@/lib/adapters/types'
import type { AggregatorName } from '@/lib/constants'
import type { Token } from '@/lib/tokens'
import type { SwapPriceTierResponse } from '@/lib/swap-price-tier'
import { deriveMinimumOutput } from '@/lib/minimum-output'
import { fmtToken } from '@/lib/format'
import { safeBigInt } from '@/lib/utils'
import type { QuoteView } from '../swap/quote-model'

/** The three placeholders of the unpriced consent copy, as SwapBox computes them (`unpricedDialogValues`). */
export interface ConsentValues {
  symbolIn: string
  symbolOut: string
  /** {N} — aggregator quotes that answered with a usable amount. */
  quoteSourceCount: number
  /** {d} — (max − min) / min of those quotes, in percent. */
  quoteSpreadPct: number
  /** {minOut} — the on-chain minimum output in `symbolOut` units. */
  minOut: string
}

/**
 * SwapBox's `unpricedDialogValues`, verbatim in logic: {N} counts quotes with a positive bigint amount; {d} is the integer-exact
 * (hi − lo) / lo in percent (needs ≥ 2 quotes, else 0); {minOut} is `deriveMinimumOutput` (the same derivation useSwap floors with).
 */
export function unpricedConsentValues(meta: MetaQuoteResult, tokenIn: Token, tokenOut: Token, slippage: number, decimalsOut = tokenOut.decimals): ConsentValues {
  const amounts = meta.all.map((q) => safeBigInt(q.toAmount)).filter((v): v is bigint => v !== null && v > 0n)
  let quoteSpreadPct = 0
  if (amounts.length >= 2) {
    const lo = amounts.reduce((a, b) => (b < a ? b : a))
    const hi = amounts.reduce((a, b) => (b > a ? b : a))
    quoteSpreadPct = Number(((hi - lo) * 1_000_000n) / lo) / 10_000
  }
  let minOut = '—'
  try {
    minOut = fmtToken(deriveMinimumOutput(meta.best.toAmount, slippage), decimalsOut)
  } catch {
    /* unusable quote → no number */
  }
  return { symbolIn: tokenIn.symbol, symbolOut: tokenOut.symbol, quoteSourceCount: amounts.length, quoteSpreadPct, minOut }
}

export interface ReviewModel {
  source: AggregatorName
  sourceLabel: string
  /** CoW intent order: v1's TransactionPreview adds the Gasless chip and a "$0.00 (paid by solver)" gas line. */
  intent: boolean
  symbolIn: string
  symbolOut: string
  /** `0.0007` — v1: fmtToken(rawAmountBn, decimals). */
  send: string
  /** `2 487.6842`, or `—` for a malformed amount. */
  receive: string
  /** `1 ETH = 2 487.6842 USDC`. */
  rate: string
  route: string
  /** `0.3%`. */
  slippage: string
  /** The displayed floor (bigint bps), without the symbol. NOT the signed value — the frozen one comes from `pending`. */
  minOutput: string
  feeLabel: string
  /** null when no fee is collected (the row reads Free, as in the quote panel). */
  feeValue: string | null
  gas: string
  gasFree: boolean
  /** The server's tier; null = unknown → nothing shown. */
  tier: SwapPriceTierResponse | null
  consent: ConsentValues
}

export function buildReviewModel(i: {
  view: QuoteView
  meta: MetaQuoteResult
  tokenIn: Token
  tokenOut: Token
  amountIn: string
  slippage: number
  tier: SwapPriceTierResponse | null | undefined
}): ReviewModel {
  const { view: v, meta, tokenIn, tokenOut } = i
  let send = '—'
  try {
    send = fmtToken(parseUnits(i.amountIn, tokenIn.decimals), tokenIn.decimals)
  } catch {
    /* malformed amount → no number */
  }
  const out = safeBigInt(meta.best.toAmount)
  return {
    source: v.bestSource,
    sourceLabel: v.bestLabel,
    intent: v.intentBased,
    symbolIn: tokenIn.symbol,
    symbolOut: tokenOut.symbol,
    send,
    receive: out !== null ? fmtToken(out, tokenOut.decimals) : '—',
    rate: `1 ${tokenIn.symbol} = ${v.rate} ${tokenOut.symbol}`,
    route: v.route,
    slippage: v.slippage,
    minOutput: v.minOutput,
    feeLabel: v.feeLabel,
    feeValue: v.feeCollected ? v.feeValue : null,
    gas: v.gas,
    gasFree: v.gasFree,
    tier: i.tier ?? null,
    consent: unpricedConsentValues(meta, tokenIn, tokenOut, i.slippage),
  }
}

/** v1's `unpricedConsentOpen = requested || unpricedAckRequired || splitUnpricedAckRequired`: a server 409 reopens the consent even after Cancel. */
export function reviewOpen(i: { requested: boolean; ackRequired: boolean }): boolean {
  return i.requested || i.ackRequired
}

/** The consent applies when the server's tier is `unpriced` OR the server asked for it (409 `unpriced_ack_required`). */
export function consentRequired(model: Pick<ReviewModel, 'tier'>, ackRequired: boolean): boolean {
  return model.tier?.tier === 'unpriced' || ackRequired
}

/**
 * B5: once the hook has frozen the transaction (`useSwap.pendingSwap`), Send / Receive / Source come from THAT snapshot — v1's
 * TransactionPreview renders them from `pendingSwap`, never from live quote state, so the sheet always matches the calldata being
 * signed (including after a 9O source fallback). Pure display: `fmtToken` over the frozen raw amounts.
 */
export function withFrozenSwap(
  model: ReviewModel,
  frozen: { source: AggregatorName; rawAmountBn: bigint; swapToAmount: string; tokenIn: Token; tokenOut: Token },
  sourceLabel: string,
): ReviewModel {
  const out = safeBigInt(frozen.swapToAmount)
  return {
    ...model,
    source: frozen.source,
    sourceLabel,
    symbolIn: frozen.tokenIn.symbol,
    symbolOut: frozen.tokenOut.symbol,
    send: fmtToken(frozen.rawAmountBn, frozen.tokenIn.decimals),
    receive: out !== null ? fmtToken(out, frozen.tokenOut.decimals) : '—',
  }
}
