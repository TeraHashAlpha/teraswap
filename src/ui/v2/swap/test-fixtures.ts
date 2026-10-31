/**
 * Test data for the Swap card (shared by swap-card.test.tsx and content-parity.swap.test.tsx). Mainnet, ETH → USDC, the five
 * sources of round7 frame 20, with the pack's numbers where the frame has them: best 2 487.6842, runner-up 2 487.0295.
 */
import { parseUnits } from 'viem'
import type { MetaQuoteResult, NormalizedQuote } from '@/lib/adapters/types'
import { findToken, type Token } from '@/lib/tokens'
import type { TaggedMetaQuote } from '@/hooks/useQuote'

export const ETH = findToken('ETH') as Token
export const USDC = findToken('USDC') as Token

const q = (source: NormalizedQuote['source'], usdc: string, extra: Partial<NormalizedQuote> = {}): NormalizedQuote => ({
  source,
  toAmount: parseUnits(usdc, 6).toString(),
  estimatedGas: 210_000,
  gasUsd: 0.03,
  routes: [],
  ...extra,
})

export function fixtureMeta(overrides: Partial<MetaQuoteResult> = {}): MetaQuoteResult {
  const all = [
    q('velora', '2487.6842', { routes: ['Dexalot', 'PancakeSwap V3', 'Dexalot'] }),
    q('kyberswap', '2487.0295'),
    q('sushiswap', '2485.7878'),
    q('uniswapv3', '2485.4736', {
      meta: { uniswapV3Fee: 500, uniswapV3Reason: 'single_pool', uniswapV3Candidates: [{ fee: 500, amountOut: '1', gasEstimate: 1, ticksCrossed: 0, ok: true }] },
    }),
    q('0x', '2480.9321'),
  ]
  return { best: all[0], all, fetchedAt: 1_700_000_000_000, ...overrides }
}

/** A quote tagged with the identity useQuote would echo for `amount` of ETH → USDC on `chainId`. */
export function taggedFixture(meta: MetaQuoteResult = fixtureMeta(), amount = '1', chainId = 1, tokenIn: Token = ETH, tokenOut: Token = USDC): TaggedMetaQuote {
  return {
    ...meta,
    identity: {
      chainId,
      tokenIn: tokenIn.address.toLowerCase(),
      tokenOut: tokenOut.address.toLowerCase(),
      amountRaw: parseUnits(amount, tokenIn.decimals).toString(),
      decimalsIn: tokenIn.decimals,
      decimalsOut: tokenOut.decimals,
      fetchedAt: meta.fetchedAt,
    },
  }
}

export const NO_ORACLE = { chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as const
