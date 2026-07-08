/**
 * [CHORE-ORACLE-VALUE-FAILCLOSED / TM-P2] Client-side trade-value estimate for the
 * unverified-swap gate — extracted pure so the fail-closed policy is directly unit-tested
 * (same pattern as mev-preference.ts).
 *
 * The old SwapBox estimate priced the INPUT side only (stable → $1, Chainlink, ETH≈$2k);
 * an unpriced input yielded 0 and the >$10k oracle block silently never fired (threat
 * model PR #277, P2 MED). The estimate is now max(inputUsd, outputUsd) with an explicit
 * `priced` flag — `priced: false` (neither side priceable) must be treated as HIGH-RISK
 * by the caller (block), never as "$0".
 */

import { describe, it, expect } from 'vitest'
import { estimateSwapUsd } from './swap-usd-estimate'
import type { Token } from '@/lib/tokens'

const NATIVE_ETH_ADDR = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

function tok(symbol: string, over: Partial<Token> = {}): Token {
  return {
    address: '0x0000000000000000000000000000000000001234',
    symbol,
    name: symbol,
    decimals: 18,
    logoURI: '',
    category: 'Other',
    ...over,
  }
}

const EXOTIC_IN = tok('XIN')
const EXOTIC_OUT = tok('XOUT', { address: '0x0000000000000000000000000000000000005678' })

function base(over: Partial<Parameters<typeof estimateSwapUsd>[0]> = {}) {
  return {
    tokenIn: EXOTIC_IN,
    tokenOut: EXOTIC_OUT,
    amountIn: 1,
    amountOut: null as number | null,
    chainlinkPriceIn: null as number | null,
    chainlinkPriceOut: null as number | null,
    chainId: 1,
    ...over,
  }
}

describe('estimateSwapUsd — per-side pricing', () => {
  it('prices a stablecoin INPUT at ~$1 (chain-keyed)', () => {
    expect(estimateSwapUsd(base({ tokenIn: tok('USDC'), amountIn: 12_000 })))
      .toEqual({ usd: 12_000, priced: true })
  })

  it('prices a stablecoin OUTPUT at ~$1 — the P2 fix: an exotic input no longer hides a measurable trade', () => {
    expect(estimateSwapUsd(base({ tokenOut: tok('USDC'), amountOut: 12_000 })))
      .toEqual({ usd: 12_000, priced: true })
  })

  it('uses the Chainlink price for the input side when present', () => {
    expect(estimateSwapUsd(base({ amountIn: 4, chainlinkPriceIn: 3_000 })))
      .toEqual({ usd: 12_000, priced: true })
  })

  it('uses the Chainlink price for the output side when present', () => {
    expect(estimateSwapUsd(base({ amountOut: 5_000, chainlinkPriceOut: 3 })))
      .toEqual({ usd: 15_000, priced: true })
  })

  it('keeps the conservative ETH≈$2k input fallback', () => {
    expect(estimateSwapUsd(base({ tokenIn: tok('ETH', { address: NATIVE_ETH_ADDR }), amountIn: 2 })))
      .toEqual({ usd: 4_000, priced: true })
  })

  it('applies the ETH≈$2k fallback to a WETH OUTPUT too', () => {
    expect(estimateSwapUsd(base({ tokenOut: tok('WETH'), amountOut: 2 })))
      .toEqual({ usd: 4_000, priced: true })
  })
})

describe('estimateSwapUsd — max(inputUsd, outputUsd)', () => {
  it('takes the larger side (output wins)', () => {
    const r = estimateSwapUsd(base({
      amountIn: 1, chainlinkPriceIn: 5_000,
      tokenOut: tok('USDT'), amountOut: 15_000,
    }))
    expect(r).toEqual({ usd: 15_000, priced: true })
  })

  it('takes the larger side (input wins)', () => {
    const r = estimateSwapUsd(base({
      amountIn: 1, chainlinkPriceIn: 20_000,
      tokenOut: tok('USDT'), amountOut: 15_000,
    }))
    expect(r).toEqual({ usd: 20_000, priced: true })
  })
})

describe('estimateSwapUsd — chain-keyed stable membership ([[stablecoins]] canon)', () => {
  it('prices USDbC output on Base (8453)', () => {
    expect(estimateSwapUsd(base({ tokenOut: tok('USDbC'), amountOut: 11_000, chainId: 8453 })))
      .toEqual({ usd: 11_000, priced: true })
  })

  it('does NOT price USDbC on mainnet (no such mainnet token → no $1 trust)', () => {
    expect(estimateSwapUsd(base({ tokenOut: tok('USDbC'), amountOut: 11_000, chainId: 1 })))
      .toEqual({ usd: 0, priced: false })
  })
})

describe('estimateSwapUsd — fail-closed contract', () => {
  it('neither side priceable → { usd: 0, priced: false } (caller must treat as high-risk, never $0)', () => {
    expect(estimateSwapUsd(base({ amountOut: 5_000 })))
      .toEqual({ usd: 0, priced: false })
  })

  it('no quote yet (amountOut null) + unpriced input → not priced', () => {
    expect(estimateSwapUsd(base()))
      .toEqual({ usd: 0, priced: false })
  })

  it('non-positive amountIn → not priced (caller guards, helper stays safe)', () => {
    expect(estimateSwapUsd(base({ tokenIn: tok('USDC'), amountIn: 0 })))
      .toEqual({ usd: 0, priced: false })
  })

  it('missing tokens → not priced', () => {
    expect(estimateSwapUsd(base({ tokenIn: null, tokenOut: null })))
      .toEqual({ usd: 0, priced: false })
  })
})
