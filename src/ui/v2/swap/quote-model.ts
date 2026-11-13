/**
 * [ADR-025] Swap card display model (B3, commit 1). Pure: v1's QuoteBreakdown numbers, derived once, formatted ONLY by
 * `@/lib/format` (pack README §3). Nothing here is signed or sent — the exact on-chain floor is rebuilt by useSwap /
 * the B4 review from its own frozen quote; this is what the card SHOWS.
 *
 * Differences from v1's QuoteBreakdown, each deliberate and recorded in docs/feedback/feat-ui-v2-swap-card.md:
 *  - Min. output: v1 multiplies a float (`out * (1 - slippage/100)`). Here it is `deriveMinimumOutput` (bigint, bps) — the
 *    same derivation useSwap uses for the FeeCollector floor and SwapBox uses for the unpriced dialog's {minOut}.
 *  - Route: a hop is a NAME from an allow-list of venues (route-names.ts), else the source's own label. v1 prints whatever string
 *    the adapter forwards — KyberSwap's `fermi` / `metric-v1`, a hash, a pool id ("Pool 0xabc…" passed v1's address check).
 *  - Est. gas: the native amount FIRST (ETH at 2 significant digits, never "~0"), the fiat value second, `~0.00011 ETH ($0.21)`
 *    [feat/ui-v2-fiat-value, owner decision C]; the fiat figure comes from either the live estimate or the quote's own `gasUsd`
 *    (see formatGas: KyberSwap quotes arrive with `estimatedGas: 0` and the cost in `gasUsd`). It follows the visitor's currency.
 */
import { formatUnits, parseUnits } from 'viem'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/adapters/types'
import type { Token } from '@/lib/tokens'
import type { PriceCheck } from '@/lib/chainlink'
import { AGGREGATOR_META, FEE_PERCENT, PRICE_DEVIATION_BLOCK, PRICE_DEVIATION_WARN, type AggregatorName } from '@/lib/constants'
import { INTEGRATED_DEX_SOURCE_COUNT } from '@/config/product-claims'
import { deriveMinimumOutput } from '@/lib/minimum-output'
import { feeMode, isFeeCollected, type FeeMode } from '@/lib/fee-mode'
import { feeUsd, swapNotionalUsd } from '@/lib/fee-usd'
import { isExecutableSource } from '@/lib/executable-sources'
import { estimateMevSavings } from '@/lib/mev-savings'
import { fmtGas, fmtPct, fmtToken, fmtUsd, formatWithSeparator } from '@/lib/format'
import { safeBigInt } from '@/lib/utils'
import { knownDexName } from './route-names'
import { convertUsd, fmtFiat, type FiatCurrency } from '../fiat/fiat-format'

export function sourceLabel(source: AggregatorName): string {
  return AGGREGATOR_META[source]?.label || source
}

/**
 * One route hop as a name: a venue from the allow-list (route-names.ts), else the SOURCE's own label. An internal id
 * (`fermi`, `metric-v1`), a pool address or hash, free text, an empty hop — none of them is ever shown.
 */
export function routeHopLabel(hop: string, source: AggregatorName): string {
  return knownDexName(hop) ?? sourceLabel(source)
}

/**
 * "Dexalot + PancakeSwap V3 + Dexalot": the hops by name; an empty route is the source's own label. Consecutive hops that fell back
 * to the source label read once ("KyberSwap", not "KyberSwap + KyberSwap + KyberSwap"); named venues are never merged.
 */
export function routeText(quote: NormalizedQuote): string {
  const fallback = sourceLabel(quote.source)
  const names: string[] = []
  let prevWasFallback = false
  for (const hop of quote.routes) {
    const named = knownDexName(hop)
    if (named === null && prevWasFallback) continue
    names.push(named ?? fallback)
    prevWasFallback = named === null
  }
  return names.join(' + ') || fallback
}

export interface CompareRow {
  source: AggregatorName
  label: string
  /** `2 487.6842 USDC`, or `—` for a malformed amount (v1's 10-L-01 guard). */
  amount: string
  isBest: boolean
  direct: boolean
  quoteOnly: boolean
  /** Uniswap V3 pool fee, `0.05%`. */
  poolFee: string | null
  mev: boolean
  /** Intent-based sources: `~30s`. */
  time: string | null
}

export interface QuoteView {
  bestSource: AggregatorName
  bestLabel: string
  direct: boolean
  mevProtected: boolean
  intentBased: boolean
  gaslessBadge: boolean
  /** Intent-based best: `~30` (seconds). */
  executionSeconds: number | null
  rate: string
  inverseRate: string
  route: string
  uniswapFee: {
    tier: string
    reason: 'only pool' | 'gas tie-break' | null
    candidates: { fee: string; ok: boolean; best: boolean }[]
  } | null
  mevSavings: string | null
  slippage: string
  /** `Free (solver-paid)` | `~0.000012 ETH ($0.03)` | `$0.03` | `~0.000012 ETH` | `~210 000 gas` (v1's fallback). Native amount first. */
  gas: string
  gasFree: boolean
  feeMode: FeeMode
  feeCollected: boolean
  /** `Platform fee (0.1%)` | `Platform fee`. */
  feeLabel: string
  /** `0.001 ETH ($2.49)` | `0.001 ETH` when no price exists | null when no fee is collected (the row then reads Free). */
  feeValue: string | null
  minOutput: string
  /** `+0.6547 USDC vs KyberSwap`, only when the runner-up is strictly worse. */
  delta: string | null
  compare: CompareRow[]
}

/**
 * [feat/ui-v2-fiat-value] How the fiat part of the gas and fee lines reads. DISPLAY ONLY: plain data, no hook, no price source here.
 * `currency` is the EFFECTIVE one (a euro choice without a usable rate arrives as 'USD'); omitted → dollars.
 */
export interface QuoteFiat {
  currency: FiatCurrency
  /** USD per 1 EUR; read only for EUR. */
  usdPerEur: number | null
  /** The sell token's approximate USD price (the Portfolio's source): the fee line's fallback when no Chainlink price exists. */
  tokenInApproxUsd?: number | null
  /** The chain's native token's approximate USD price: the gas line's fallback to derive its native amount when no oracle price exists. */
  nativeApproxUsd?: number | null
}

export interface QuoteViewInput {
  meta: MetaQuoteResult
  tokenIn: Token
  tokenOut: Token
  /** The sell amount as typed, separators stripped. */
  amountIn: string
  /** Percent, e.g. 0.3. */
  slippage: number
  chainId: number
  tokenInUsdPrice?: number | null
  tokenOutUsdPrice?: number | null
  gasEstimate?: (gasUnits: number) => { eth: number; usd: number } | null
  /** ETH/USD (Chainlink, useEthGasCost.ethPrice): lets a USD-only gas cost (KyberSwap's `gasUsd`) also show its ETH amount. */
  ethUsdPrice?: number | null
  fiat?: QuoteFiat
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** USD → the visitor's currency as text; a euro request without a rate falls back to the dollar figure rather than inventing one. */
function money(usd: number, fiat?: QuoteFiat): string {
  const cur = fiat?.currency ?? 'USD'
  const v = convertUsd(usd, cur, fiat?.usdPerEur ?? null)
  return (v !== null ? fmtFiat(v, cur) : null) ?? fmtUsd(usd)
}

/**
 * The Est. gas line. The native amount FIRST (ETH at 2 significant digits), the fiat value second: `~0.00011 ETH ($0.21)`. The fiat part
 * comes from the live estimate, else the quote's own `gasUsd`, and follows the visitor's currency. Fiat alone when the ETH amount cannot be
 * derived; ETH alone when no price exists (no fiat part, never `$0`); v1's `~N gas` when only units are known; `n/a` when nothing is: never "~0 ETH".
 *
 * Why v1 (and the first v2 build) showed "~0 ETH" on Ethereum: the KyberSwap adapter reports `estimatedGas: route.gasUsd ? 0 : route.gas`
 * and the cost in `gasUsd`, so the units are 0, `useEthGasCost.estimate(0)` is { eth: 0, usd: 0 } (not null), the USD branch fails
 * its `> 0` test and `fmtGas(0)` prints "0". The USD was never absent — it was in `gasUsd`, which nothing read.
 */
export function formatGas(best: Pick<NormalizedQuote, 'estimatedGas' | 'gasUsd'>, intentBased: boolean, gasEstimate: QuoteViewInput['gasEstimate'], ethUsdPrice?: number | null, fiat?: QuoteFiat): string {
  if (best.estimatedGas === 0 && intentBased) return 'Free (solver-paid)'
  const cost = gasEstimate?.(best.estimatedGas) ?? null
  const usd = positive(cost?.usd) ? cost.usd : positive(best.gasUsd) ? best.gasUsd : null
  let eth = positive(cost?.eth) ? cost.eth : null
  if (eth === null && usd !== null && positive(ethUsdPrice)) eth = usd / ethUsdPrice
  if (eth === null && usd !== null && positive(fiat?.nativeApproxUsd)) eth = usd / fiat.nativeApproxUsd // display-only estimate, only when no oracle price exists
  if (usd !== null) return eth !== null ? `~${fmtGas(eth)} ETH (${money(usd, fiat)})` : money(usd, fiat)
  if (eth !== null) return `~${fmtGas(eth)} ETH`
  if (best.estimatedGas > 0) return `~${formatWithSeparator(best.estimatedGas.toString()).replace(/\s/g, '\u2009')} gas`
  return 'n/a'
}

/** v1's `outputAmountValid` / `Number(formatUnits(...))`, kept so a malformed `toAmount` renders `—`, not a crash. */
function outAmount(toAmount: string, decimals: number): number | null {
  const bn = safeBigInt(toAmount)
  return bn === null ? null : Number(formatUnits(bn, decimals))
}

export function buildQuoteView(i: QuoteViewInput): QuoteView {
  const { meta, tokenIn, tokenOut, amountIn, slippage, chainId } = i
  const best = meta.best
  const bestMeta = AGGREGATOR_META[best.source]
  const out = outAmount(best.toAmount, tokenOut.decimals)
  const inAmt = Number(amountIn)
  const intentBased = bestMeta?.intentBased ?? false

  const rate = out !== null && inAmt > 0 ? fmtToken(out / inAmt) : 'n/a'
  const inverseRate = out !== null && out > 0 && inAmt > 0 ? fmtToken(inAmt / out) : 'n/a'

  const mode = feeMode(best.source, chainId)
  const collected = isFeeCollected(best.source, chainId)
  const feeAbsolute = collected ? (inAmt * FEE_PERCENT) / 100 : 0
  const notional = collected
    ? swapNotionalUsd({ inputAmount: inAmt, inputPrice: i.tokenInUsdPrice ?? null, outputAmount: out ?? 0, outputPrice: i.tokenOutUsdPrice ?? null })
    : null
  // The fiat part of the fee: the Chainlink-based notional when there is one, else the sell token's approximate price (display only).
  const approxIn = i.fiat?.tokenInApproxUsd
  const feeUsdValue = collected ? (feeUsd(notional, FEE_PERCENT) ?? (positive(approxIn) && feeAbsolute > 0 ? feeAbsolute * approxIn : null)) : null

  const gasFree = best.estimatedGas === 0 && intentBased
  const gas = formatGas(best, intentBased, i.gasEstimate, i.ethUsdPrice, i.fiat)

  let minOutput = 'n/a'
  try {
    minOutput = fmtToken(deriveMinimumOutput(best.toAmount, slippage), tokenOut.decimals)
  } catch {
    /* unusable quote → no number (never a fabricated floor) */
  }

  let delta: string | null = null
  const second = meta.all[1]
  if (second && out !== null) {
    const s = outAmount(second.toAmount, tokenOut.decimals)
    if (s !== null && out - s > 0) delta = `${fmtToken(out - s, 18, { sign: true })} ${tokenOut.symbol} vs ${sourceLabel(second.source)}`
  }

  const v3 = best.source === 'uniswapv3' && best.meta?.uniswapV3Fee != null ? best.meta : null
  const uniswapFee = v3
    ? {
        tier: fmtPct((v3.uniswapV3Fee as number) / 10000),
        reason: v3.uniswapV3Reason === 'single_pool' ? ('only pool' as const) : v3.uniswapV3Reason === 'best_net_output' ? ('gas tie-break' as const) : null,
        candidates:
          (v3.uniswapV3Candidates ?? []).filter((c) => c.ok).length > 1
            ? (v3.uniswapV3Candidates ?? []).map((c) => ({ fee: fmtPct(c.fee / 10000), ok: c.ok, best: c.fee === v3.uniswapV3Fee }))
            : [],
      }
    : null

  const sav = estimateMevSavings(meta)
  const mevSavings = sav ? `${fmtToken(Number(formatUnits(sav.amountWei, tokenOut.decimals)), 18, { sign: true })} ${tokenOut.symbol} (${fmtPct(sav.pct)})` : null

  return {
    bestSource: best.source,
    bestLabel: sourceLabel(best.source),
    direct: bestMeta?.isDirect ?? false,
    mevProtected: bestMeta?.mevProtected ?? false,
    intentBased,
    gaslessBadge: gasFree,
    executionSeconds: intentBased ? bestMeta?.estimatedTime ?? null : null,
    rate,
    inverseRate,
    route: routeText(best),
    uniswapFee,
    mevSavings,
    slippage: fmtPct(slippage),
    gas,
    gasFree,
    feeMode: mode,
    feeCollected: collected,
    feeLabel: collected ? `Platform fee (${fmtPct(FEE_PERCENT)})` : 'Platform fee',
    feeValue: collected ? `${fmtToken(feeAbsolute)} ${tokenIn.symbol}${feeUsdValue != null ? ` (${money(feeUsdValue, i.fiat)})` : ''}` : null,
    minOutput,
    delta,
    compare: meta.all.map((q, idx) => {
      const m = AGGREGATOR_META[q.source]
      const o = outAmount(q.toAmount, tokenOut.decimals)
      return {
        source: q.source,
        label: sourceLabel(q.source),
        amount: o !== null ? `${fmtToken(o)} ${tokenOut.symbol}` : 'n/a',
        isBest: idx === 0,
        direct: m?.isDirect ?? false,
        quoteOnly: !isExecutableSource(q.source, chainId),
        poolFee: q.source === 'uniswapv3' && q.meta?.uniswapV3Fee != null ? fmtPct(q.meta.uniswapV3Fee / 10000) : null,
        mev: m?.mevProtected ?? false,
        time: m?.intentBased && m.estimatedTime ? `~${m.estimatedTime}s` : null,
      }
    }),
  }
}

/** Price-impact row: shown only when the oracle gave a reference AND the deviation clears 0.5 % (v1's rule). */
export function priceImpact(check: PriceCheck): { text: string; tone: 'danger' | 'warn' | 'plain' } | null {
  if (check.chainlinkPrice == null || check.executionPrice == null || !(check.deviation > 0.005)) return null
  const tone = check.deviation > PRICE_DEVIATION_BLOCK ? 'danger' : check.deviation > PRICE_DEVIATION_WARN ? 'warn' : 'plain'
  return { text: `~${fmtPct(check.deviation * 100)}`, tone }
}

/**
 * [fix/stale-quote-pair-flip, extended for the amount] v1 keeps a pair's quote on screen while a NEW amount is typed
 * ("unchanged UX") and still divides its output by the new typed amount. The v2 card shows a quote only while its own
 * echoed `amountRaw` is the amount in the field; until the re-quote lands the card is "quoting" (skeleton, CTA disabled),
 * so the receive amount, rate, fee and Min. output can never describe a different sell amount than the one on screen.
 */
export interface ShareText {
  /** The tweet-intent body (URL-encoded by the caller). */
  text: string
  /** v1's button label: "Share — saved X%" when the claim applies, else "Share swap". */
  label: string
}

/**
 * [L-1, owner decision: BUILD Share in v2] v1's Share-button tweet text (SwapBox.tsx), verbatim, as pure data instead
 * of inline JSX: a comparison across > 1 source gets the "saved %" claim (worst → best of `meta.all`, [11-L-01]'s
 * `safeBigInt` guard against a malformed `toAmount` hiding the claim rather than crashing); one source (or a tie) gets
 * the plain line. Null whenever v1 would render nothing — no meta/tokenIn/tokenOut, or exactly one source.
 */
export function buildShareText(meta: MetaQuoteResult | null, tokenIn: Token | null, tokenOut: Token | null): ShareText | null {
  if (!meta || !tokenIn || !tokenOut || meta.all.length <= 1) return null
  const bestBig = safeBigInt(meta.best.toAmount)
  const worstBig = safeBigInt(meta.all[meta.all.length - 1].toAmount)
  if (bestBig === null || worstBig === null) return null
  const bestOut = Number(formatUnits(bestBig, tokenOut.decimals))
  const worstOut = Number(formatUnits(worstBig, tokenOut.decimals))
  const savedPercent = worstOut > 0 ? ((bestOut - worstOut) / worstOut) * 100 : 0
  const savedDisplay = savedPercent > 0.01 ? fmtPct(savedPercent) : null
  return savedDisplay
    ? {
        text: `I just saved ${savedDisplay} on my ${tokenIn.symbol} → ${tokenOut.symbol} swap by comparing ${meta.all.length} DEX sources with @TeraSwapDEX 🔥\n\nTeraSwap meta-aggregates ${INTEGRATED_DEX_SOURCE_COUNT} DEX sources for the best price.\nhttps://www.teraswap.app`,
        label: `Share: saved ${savedDisplay}`,
      }
    : {
        text: `Just swapped ${tokenIn.symbol} → ${tokenOut.symbol} via @TeraSwapDEX: compared ${meta.all.length} sources for the best price 🔥\n\nhttps://www.teraswap.app`,
        label: 'Share swap',
      }
}

export function quoteIsForAmount(identityAmountRaw: string | undefined, amountIn: string, decimalsIn: number): boolean {
  if (identityAmountRaw === undefined || !amountIn) return false
  try {
    return parseUnits(amountIn, decimalsIn).toString() === identityAmountRaw
  } catch {
    return false
  }
}
