import type { AggregatorName } from '@/lib/constants'

// Re-export for convenience
export type { AggregatorName } from '@/lib/constants'

// ── CoW order params [10-L-02] ──────────────────────────────────
//
// Shape of the signed-order parameters the CoW Protocol orderbook expects.
// Mirrors the public CoW API contract (https://api.cow.fi/docs) plus three
// fields tagged on locally during fetchCowSwapOrder: `from`, `quoteId`,
// `signingScheme`. NormalizedQuote.cowOrderParams uses this exact type so
// the boundary between fetchCowSwapOrder → useSwap → submitCowOrder is
// fully typed end-to-end. Address strings use `0x${string}` so the EIP-712
// message in useSwap can pass them through without a cast. Amounts are
// decimal-integer strings (raw wei) per the API.

export type CowSigningScheme = 'eip712' | 'ethsign' | 'presign' | 'eip1271'
export type CowOrderKind = 'sell' | 'buy'
export type CowTokenBalanceSell = 'erc20' | 'external' | 'internal'
export type CowTokenBalanceBuy = 'erc20' | 'internal'

export interface CowOrderParams {
  /** Sell-side ERC-20 (wrapped if input was native ETH). */
  sellToken: `0x${string}`
  /** Buy-side ERC-20. */
  buyToken: `0x${string}`
  /** Raw wei amount of sellToken, AFTER CoW's solver fee. */
  sellAmount: string
  /** Raw wei minimum amount of buyToken (= solver-quoted buy * (1 - slippage)). */
  buyAmount: string
  /** Unix-seconds expiry; uint32 in the EIP-712 type. */
  validTo: number
  /** JSON-serialised app-data payload signed alongside the order. */
  appData: string
  /** keccak256 of appData; used as the `appData` field in the EIP-712 message. */
  appDataHash: `0x${string}`
  /** Raw wei solver fee. */
  feeAmount: string
  /** Order kind — TeraSwap only issues `sell`-kind orders today. */
  kind: CowOrderKind
  /** True permits the solver to fill the order in multiple slices. */
  partiallyFillable: boolean
  /** Optional override; nullish → fall back to `from`. */
  receiver?: `0x${string}` | null
  sellTokenBalance: CowTokenBalanceSell
  buyTokenBalance: CowTokenBalanceBuy
  /** Submitting wallet — tagged on locally by fetchCowSwapOrder. */
  from: `0x${string}`
  /** Quote ID returned by /quote; reused on /orders submit. */
  quoteId: number
  /** Signing scheme — always 'eip712' for TeraSwap-issued orders. */
  signingScheme: CowSigningScheme
}

/** Individual fee tier candidate from Uniswap V3 auto-detection */
export interface FeeTierCandidate {
  fee: number
  amountOut: string         // raw bigint string
  gasEstimate: number
  ticksCrossed: number
  ok: boolean
  error?: string
}

/** Result of auto fee tier detection */
export interface FeeTierDetection {
  bestFee: number
  candidates: FeeTierCandidate[]
  reason: 'best_output' | 'best_net_output' | 'single_pool'
}

export interface NormalizedQuote {
  source: AggregatorName
  toAmount: string          // raw bigint string
  estimatedGas: number
  gasUsd: number            // estimated gas in USD (for net comparison)
  routes: string[]          // human-readable route names
  tx?: {
    to: `0x${string}`
    data: `0x${string}`
    value: string
    gas: number
  }
  /** CoW Protocol: order UID returned after submission (intent-based) */
  cowOrderUid?: string
  /** CoW Protocol: order parameters for EIP-712 signing. Strictly typed via
   *  CowOrderParams [10-L-02]; the previous untyped record was the
   *  weakest link in the adapter boundary and is what this finding addresses. */
  cowOrderParams?: CowOrderParams
  /** Extra metadata per source (e.g. Uniswap V3 fee tier info) */
  meta?: {
    uniswapV3Fee?: number
    uniswapV3Candidates?: FeeTierCandidate[]
    uniswapV3Reason?: string
  }
}

export interface MetaQuoteResult {
  best: NormalizedQuote
  all: NormalizedQuote[]     // sorted by netOutput desc
  fetchedAt: number          // timestamp
  /** Cross-quote validation: deviation of best quote vs median of all quotes */
  crossQuoteDeviation?: number   // e.g. 0.05 = best is 5% above median
  /** True if best quote was flagged as suspicious vs the consensus */
  crossQuoteWarning?: boolean
  /** [P94] Gasless recommendation overlay. Populated client-side after
   *  quotes return so the engine can use the freshest gas/ETH price.
   *  Server-side responses (e.g. v1/quote) populate it inline. */
  gasless?: GaslessQuoteOverlay
}

/** [P94] Gasless recommendation overlay shipped with a MetaQuoteResult.
 *  Mirrors GaslessRecommendation from src/lib/gasless-engine.ts — duplicated
 *  here to avoid a cycle between the adapter types and the engine. */
export interface GaslessQuoteOverlay {
  available: boolean
  recommended: boolean
  reason: string
  gasSavingsUsd: number
  priceDifferencePercent: number
  bestNonCowSource: string
}

export interface QuoteParams {
  src: string
  dst: string
  amount: string
  srcDecimals?: number
  dstDecimals?: number
}

// [11-L-03] Per-adapter quoteMeta interfaces — discriminated by `source`.
//
// Previously quoteMeta was an unconstrained record of any-typed fields, which
// let adapters inject untyped data through the swap pipeline. The discriminator
// forces consumers to narrow before reading adapter-specific fields, eliminating
// an entire class of "what shape does this actually have" bugs at compile time.

export interface CowQuoteMeta {
  source: 'cow'
  orderId?: string
  quoteId?: string | number
}

export interface UniswapV3QuoteMeta {
  source: 'uniswapv3'
  uniswapV3Fee?: number
}

/** Fallback for adapters that don't have a dedicated meta type yet.
 *  `unknown` (not `any`) forces type-checking at the use site. */
export interface GenericQuoteMeta {
  source: string
  [key: string]: unknown
}

export type QuoteMeta = CowQuoteMeta | UniswapV3QuoteMeta | GenericQuoteMeta

export interface SwapParams extends QuoteParams {
  from: string
  slippage: number
  quoteMeta?: QuoteMeta
  chainId?: number
}

export interface DEXAdapter {
  name: AggregatorName
  fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null>
  fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null>
}
