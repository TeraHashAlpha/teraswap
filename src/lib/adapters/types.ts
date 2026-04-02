import type { AggregatorName } from '@/lib/constants'

// Re-export for convenience
export type { AggregatorName } from '@/lib/constants'

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
  /** CoW Protocol: order parameters for EIP-712 signing (dynamic fields from CoW API) */
  cowOrderParams?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
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
}

export interface QuoteParams {
  src: string
  dst: string
  amount: string
  srcDecimals?: number
  dstDecimals?: number
}

export interface SwapParams extends QuoteParams {
  from: string
  slippage: number
  quoteMeta?: Record<string, any>
  chainId?: number
}

export interface DEXAdapter {
  name: AggregatorName
  fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null>
  fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null>
}
