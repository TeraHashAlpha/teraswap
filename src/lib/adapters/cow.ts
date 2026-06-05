import {
  CHAIN_ID,
  FEE_RECIPIENT,
  FEE_BPS,
  NATIVE_ETH,
  getCowApiBase,
} from '@/lib/constants'
import { getWrappedNative } from '@/lib/chains/registry'
import { clampSlippage } from './shared'
import { safeBigInt } from '@/lib/utils'
import type {
  DEXAdapter,
  NormalizedQuote,
  QuoteParams,
  SwapParams,
  CowOrderParams,
  CowOrderKind,
  CowSigningScheme,
  CowTokenBalanceSell,
  CowTokenBalanceBuy,
} from './types'

// ── CoW order params runtime validator [10-L-02] ─────────────
//
// The static interface lives in ./types so NormalizedQuote can reference
// it without a circular import. This module owns the runtime validator
// that asserts a /quote response actually matches the interface before
// it gets handed to the EIP-712 signer downstream.

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const HEX32_RE = /^0x[a-fA-F0-9]{64}$/
const DECIMAL_UINT_RE = /^\d+$/

/**
 * [10-L-02] Runtime validator for the CoW /quote response shape.
 *
 * Called at the boundary in fetchCowSwapOrder before we tag on our
 * local fields and return. Returns null if any required field is
 * missing or malformed; the caller throws a tagged Error rather than
 * crashing. Logs a single warn naming the first failure so production
 * log search can spot the API contract drift.
 */
function parseCowOrderParams(
  raw: unknown,
  ctx: { from: `0x${string}`; quoteId: unknown; signingScheme: CowSigningScheme },
): CowOrderParams | null {
  if (typeof raw !== 'object' || raw === null) {
    console.warn('[CoW] orderParams validation failed: not an object')
    return null
  }
  const r = raw as Record<string, unknown>

  const fail = (field: string, why: string): null => {
    console.warn(`[CoW] orderParams validation failed: ${field} ${why}`)
    return null
  }

  if (typeof r.sellToken !== 'string' || !ADDRESS_RE.test(r.sellToken)) return fail('sellToken', 'not a 0x-prefixed 20-byte address')
  if (typeof r.buyToken !== 'string' || !ADDRESS_RE.test(r.buyToken)) return fail('buyToken', 'not a 0x-prefixed 20-byte address')
  if (typeof r.sellAmount !== 'string' || !DECIMAL_UINT_RE.test(r.sellAmount)) return fail('sellAmount', 'not a decimal-integer string')
  // [11-L-02] Validate buyAmount shape before the caller converts it via safeBigInt.
  if (typeof r.buyAmount !== 'string' || !DECIMAL_UINT_RE.test(r.buyAmount)) return fail('buyAmount', 'not a decimal-integer string')
  if (typeof r.validTo !== 'number' || !Number.isInteger(r.validTo) || r.validTo <= 0) return fail('validTo', 'not a positive integer')
  if (typeof r.appData !== 'string' || r.appData.length === 0) return fail('appData', 'missing')
  if (typeof r.appDataHash !== 'string' || !HEX32_RE.test(r.appDataHash)) return fail('appDataHash', 'not a 32-byte hex')
  if (typeof r.feeAmount !== 'string' || !DECIMAL_UINT_RE.test(r.feeAmount)) return fail('feeAmount', 'not a decimal-integer string')
  if (r.kind !== 'sell' && r.kind !== 'buy') return fail('kind', `unexpected value: ${String(r.kind)}`)
  if (typeof r.partiallyFillable !== 'boolean') return fail('partiallyFillable', 'not a boolean')
  if (r.sellTokenBalance !== 'erc20' && r.sellTokenBalance !== 'external' && r.sellTokenBalance !== 'internal') {
    return fail('sellTokenBalance', `unexpected value: ${String(r.sellTokenBalance)}`)
  }
  if (r.buyTokenBalance !== 'erc20' && r.buyTokenBalance !== 'internal') {
    return fail('buyTokenBalance', `unexpected value: ${String(r.buyTokenBalance)}`)
  }
  if (r.receiver != null && (typeof r.receiver !== 'string' || !ADDRESS_RE.test(r.receiver))) {
    return fail('receiver', 'not a 0x-prefixed 20-byte address')
  }
  if (typeof ctx.quoteId !== 'number' || !Number.isInteger(ctx.quoteId)) {
    return fail('quoteId', 'not an integer')
  }

  return {
    sellToken: r.sellToken as `0x${string}`,
    buyToken: r.buyToken as `0x${string}`,
    sellAmount: r.sellAmount,
    // Validated above; caller overrides with the slippage-adjusted minBuyAmount.
    buyAmount: r.buyAmount,
    validTo: r.validTo,
    appData: r.appData,
    appDataHash: r.appDataHash as `0x${string}`,
    feeAmount: r.feeAmount,
    kind: r.kind as CowOrderKind,
    partiallyFillable: r.partiallyFillable,
    receiver: r.receiver == null ? null : (r.receiver as `0x${string}`),
    sellTokenBalance: r.sellTokenBalance as CowTokenBalanceSell,
    buyTokenBalance: r.buyTokenBalance as CowTokenBalanceBuy,
    from: ctx.from,
    quoteId: ctx.quoteId,
    signingScheme: ctx.signingScheme,
  }
}

// ── [SPRINT-9T T2] CoW partner fee in appData ────────────────
//
// CoW is FEE_INCOMPATIBLE (intent-based — no on-chain tx to wrap via the FeeCollector), so its
// 0.1% is collected through CoW's NATIVE partnerFee mechanism in the order's appData. The appData
// v1.1.0 schema references partnerFee/v0.1.0.json = { bps, recipient } (both required) — exactly
// this shape, with the SAME FEE_BPS the FeeCollector/Bebop/0x use (no new magic number). Quote-time
// and order-time appData are IDENTICAL so the quoted buyAmount (Compare) matches the signed order.
//
// appData ⇄ appDataHash consistency: we send the appData STRING in the /quote request; CoW hashes
// it and echoes back { appData, appDataHash }; parseCowOrderParams validates that pair and
// submitCowOrder signs/submits exactly it — so the hash always matches the string actually used,
// fee or fail-soft no-fee.
function buildCowAppData(withPartnerFee: boolean): string {
  const metadata: Record<string, unknown> = { referrer: { address: FEE_RECIPIENT, version: '1.0.0' } }
  if (withPartnerFee) metadata.partnerFee = { bps: FEE_BPS, recipient: FEE_RECIPIENT }
  return JSON.stringify({ version: '1.1.0', appCode: 'TeraSwap', metadata })
}

/** True ONLY for a CoW 400 that specifically rejects the appData / partnerFee schema. */
function isAppDataRejection(status: number, desc: string): boolean {
  if (status !== 400) return false
  const d = desc.toLowerCase()
  return d.includes('appdata') || d.includes('app data') || d.includes('partnerfee') || d.includes('partner fee')
}

/**
 * POST /quote with the partner-fee appData. FAIL-SOFT: if (and ONLY if) CoW rejects the partnerFee
 * appData schema, retry ONCE with the fee-free appData so quoting never breaks over the fee — and
 * log a structured warning. Every other error (NoLiquidity, SellAmountDoesNotCoverFee, 5xx, …)
 * propagates unchanged via a tagged Error the callers map to their existing messages.
 */
async function postCowQuoteWithFeeFallback(
  base: string,
  makeBody: (appData: string) => Record<string, unknown>,
) {
  const post = (appData: string) => fetch(`${base}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(makeBody(appData)),
  })

  let res = await post(buildCowAppData(true))
  if (res.ok) return res.json()

  let err = await res.json().catch(() => ({}))
  let desc = String(err.description || err.errorType || '')
  if (isAppDataRejection(res.status, desc)) {
    // Never break CoW quoting over the fee — drop the partnerFee and retry once.
    console.warn(JSON.stringify({ event: 'cow_partner_fee_failsoft', status: res.status, reason: desc.slice(0, 200) }))
    res = await post(buildCowAppData(false))
    if (res.ok) return res.json()
    err = await res.json().catch(() => ({}))
    desc = String(err.description || err.errorType || '')
  }
  const e = new Error(desc || 'quote failed') as Error & { cowStatus?: number }
  e.cowStatus = res.status
  throw e
}

/**
 * CoW Protocol works differently from other aggregators:
 * - Quote: standard price/fee estimation
 * - Swap: user signs an off-chain order -> solvers compete to fill it
 * - The user does NOT submit an on-chain tx; the solver does
 * - Execution takes ~30s (batch auction interval)
 */
async function fetchCowSwapQuote(
  src: string, dst: string, amount: string,
  chainId: number = CHAIN_ID,
): Promise<NormalizedQuote> {
  const base = getCowApiBase(chainId)
  // [SPRINT-9W] Map native ETH to the wrapped-native of the CALL's chain (Base → 0x4200…0006, NOT
  // mainnet WETH) so the chain-aware orderbook (api.cow.fi/<slug>) is asked for an address that
  // exists there. Asking the Base book for mainnet WETH → no quote (the Force-MEV-on-Base bug).
  const wrapped = getWrappedNative(chainId)
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? wrapped : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? wrapped : dst

  const data = await postCowQuoteWithFeeFallback(base, (appData) => ({
    sellToken,
    buyToken,
    sellAmountBeforeFee: amount,
    kind: 'sell',
    from: FEE_RECIPIENT,
    appData,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    signingScheme: 'eip712',
  })).catch((e: unknown) => {
    const desc = e instanceof Error ? e.message : 'quote failed'
    if (desc.includes('SellAmountDoesNotCoverFee') || desc.includes('NoLiquidity')) {
      throw new Error(`CoW: Amount too small or no liquidity for this pair`)
    }
    throw new Error(`CoW ${(e as { cowStatus?: number }).cowStatus ?? ''}: ${desc}`)
  })
  const quote = data.quote

  return {
    source: 'cowswap',
    toAmount: quote.buyAmount,
    estimatedGas: 0,
    gasUsd: 0,
    routes: ['CoW Protocol (MEV Protected)'],
  }
}

/**
 * CoW "swap" returns the order parameters for the user to sign.
 * The actual execution is handled by useSwap which detects CoW
 * and uses EIP-712 signing instead of sendTransaction.
 */
async function fetchCowSwapOrder(
  src: string, dst: string, amount: string, from: string, slippage: number,
  chainId: number = CHAIN_ID,
  // [P101] Output destination — defaults to sender when not provided. CoW
  // already supports a split sender/receiver natively (the order's
  // `receiver` field), so threading through is just passing the value
  // into the /quote request body.
  recipient?: string,
): Promise<NormalizedQuote> {
  const base = getCowApiBase(chainId)
  // [SPRINT-9W] Map native ETH to the wrapped-native of the CALL's chain (Base → 0x4200…0006, NOT
  // mainnet WETH) so the chain-aware orderbook (api.cow.fi/<slug>) is asked for an address that
  // exists there. Asking the Base book for mainnet WETH → no quote (the Force-MEV-on-Base bug).
  const wrapped = getWrappedNative(chainId)
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? wrapped : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? wrapped : dst

  // [SPRINT-9T T2] appData now carries the partnerFee (same builder as the quote path → identical
  // quote/order appData). FAIL-SOFT to the fee-free appData only if CoW rejects the partnerFee
  // schema, so signing/quoting never breaks over the fee. The order is signed/submitted over the
  // { appData, appDataHash } CoW echoes back (parseCowOrderParams), so the hash stays consistent.
  const quoteData = await postCowQuoteWithFeeFallback(base, (appData) => ({
    sellToken,
    buyToken,
    sellAmountBeforeFee: amount,
    kind: 'sell',
    from,
    // [P101] Receiver = address that gets the buyToken once the order is
    // settled. Defaults to sender; parseCowOrderParams validates whatever
    // the API echoes back.
    receiver: recipient ?? from,
    appData,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    signingScheme: 'eip712',
  })).catch((e: unknown) => {
    const desc = e instanceof Error ? e.message : 'failed'
    throw new Error(`CoW quote ${(e as { cowStatus?: number }).cowStatus ?? ''}: ${desc}`)
  })
  const quote = quoteData.quote

  // [11-L-02] Validate CoW response BEFORE BigInt conversion. parseCowOrderParams
  // checks shape, types, and ranges (including buyAmount being a decimal integer).
  // [10-L-02] If CoW returns an unexpected shape we throw a tagged Error here so
  // the meta-quote engine falls through to the other adapters rather than producing
  // a typed result that lies about its contents.
  const cowOrderParams = parseCowOrderParams(quote, {
    from: from as `0x${string}`,
    quoteId: quoteData.id,
    signingScheme: 'eip712',
  })
  if (!cowOrderParams) {
    throw new Error('CoW: malformed /quote response — see console for the offending field')
  }

  // [11-L-02] Convert + compute happen only after validation.
  const buyAmountBig = safeBigInt(quote.buyAmount)
  if (buyAmountBig === null) {
    throw new Error('CoW: buyAmount is not a valid integer')
  }
  const slippageFactor = BigInt(Math.round((1 - clampSlippage(slippage) / 100) * 10000))
  const minBuyAmount = (buyAmountBig * slippageFactor / 10000n).toString()

  return {
    source: 'cowswap',
    toAmount: quote.buyAmount,
    estimatedGas: 0,
    gasUsd: 0,
    routes: ['CoW Protocol (MEV Protected)'],
    cowOrderParams: { ...cowOrderParams, buyAmount: minBuyAmount },
  }
}

/**
 * Submit a signed CoW order to the CoW Protocol orderbook.
 *
 * [10-L-02] orderParams is typed via CowOrderParams so any caller passing
 * a misshapen object fails at compile time. The validator in
 * fetchCowSwapOrder guarantees the runtime shape for the happy path.
 */
export async function submitCowOrder(
  orderParams: CowOrderParams,
  signature: string,
  chainId: number = CHAIN_ID,
): Promise<string> {
  const base = getCowApiBase(chainId)

  const res = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: orderParams.sellToken,
      buyToken: orderParams.buyToken,
      sellAmount: orderParams.sellAmount,
      buyAmount: orderParams.buyAmount,
      validTo: orderParams.validTo,
      appData: orderParams.appData,
      appDataHash: orderParams.appDataHash,
      feeAmount: orderParams.feeAmount,
      kind: orderParams.kind,
      partiallyFillable: orderParams.partiallyFillable,
      receiver: orderParams.receiver || orderParams.from,
      sellTokenBalance: orderParams.sellTokenBalance,
      buyTokenBalance: orderParams.buyTokenBalance,
      signingScheme: orderParams.signingScheme,
      signature,
      from: orderParams.from,
      quoteId: orderParams.quoteId,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`CoW order submit ${res.status}: ${err.description || 'failed'}`)
  }
  const orderUid = await res.json()
  return orderUid
}

/**
 * Poll CoW order status until filled or expired.
 */
export async function pollCowOrderStatus(
  orderUid: string,
  maxWaitMs: number = 120_000,
  chainId: number = CHAIN_ID,
): Promise<{
  status: 'fulfilled' | 'expired' | 'cancelled'
  txHash?: string
  /** [LP-05] Raw output amount the solver actually delivered (wei). Lets the
   *  UI compute MEV-savings surplus client-side (executedBuy − quotedBuy)
   *  without touching the post-execution validator. */
  executedBuyAmount?: string
}> {
  const base = getCowApiBase(chainId)
  const start = Date.now()
  const pollInterval = 3000

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${base}/orders/${orderUid}`)
    if (res.ok) {
      const order = await res.json()
      if (order.status === 'fulfilled') {
        const tradesRes = await fetch(`${base}/trades?orderUid=${orderUid}`)
        const trades = tradesRes.ok ? await tradesRes.json() : []
        return {
          status: 'fulfilled',
          txHash: trades[0]?.txHash,
          executedBuyAmount: trades[0]?.executedBuyAmount,
        }
      }
      if (order.status === 'cancelled' || order.status === 'expired') {
        return { status: order.status }
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }
  return { status: 'expired' }
}

// Adapter: fetchQuote uses fetchCowSwapQuote, fetchSwapData uses fetchCowSwapOrder
async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  // [P217] Thread chainId so Base quotes hit the Base CoW orderbook.
  // Undefined → fetchCowSwapQuote defaults to CHAIN_ID (mainnet), unchanged.
  return fetchCowSwapQuote(params.src, params.dst, params.amount, params.chainId)
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  return fetchCowSwapOrder(
    params.src, params.dst, params.amount, params.from, params.slippage,
    params.chainId,
    params.recipient,
  )
}

const adapter: DEXAdapter = {
  name: 'cowswap' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
