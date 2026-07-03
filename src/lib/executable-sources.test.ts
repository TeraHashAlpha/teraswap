/**
 * [CHORE-SUSHI-V7-REDSNWAPPER-QUOTE-FIX] Per-chain executable-source scoping.
 *
 * A source may quote without being able to SETTLE on a chain. Execution
 * requires the full wiring: (a) its swap selector in SC-04
 * KNOWN_SWAP_SELECTORS, (b) an R1 recipient decoder in VALIDATED_SELECTORS,
 * and (c) the router whitelisted on the chain's deployed FeeCollector /
 * OrderExecutor. A source failing any of those is QUOTE-ONLY on that chain:
 * its price is informational and it must never win the executable path
 * (primary or fallback) — SC-04 fail-closed remains the terminal backstop.
 *
 * Matrix behind the current map (probed on-chain + code-audited 2026-07-03):
 *   sushiswap (RedSnwapper 0xAC4c…0b75, snwap 0x5f3bd1c8): (a) ❌ (b) ❌ both
 *     chains; (c) mainnet FC+OE ❌ / Base FC+OE ✅ → quote-only EVERYWHERE
 *     until the fund-flow-gated decoder task lands (W7-L-02-decoder class).
 *   openocean / native-curve: (a) ❌ (b) ❌ (W7-L-02, APPROVED verdict:
 *     leave quote-only) → quote-only on both chains.
 *   balancer: DISABLED outright (dead endpoint) — never quotes at all.
 */
import { describe, it, expect } from 'vitest'
import {
  isExecutableSource,
  scopeToExecutable,
  orderExecutableFallbacks,
  QUOTE_ONLY_SOURCES_BY_CHAIN,
} from './executable-sources'
import { KNOWN_SWAP_SELECTORS } from './swap-selectors'
import { VALIDATED_SELECTORS } from './calldata-recipient'
import type { MetaQuoteResult } from './adapters'

const REDSNWAPPER_SNWAP = '0x5f3bd1c8' // snwap(address,uint256,address,address,uint256,address,bytes)

function quote(source: string, toAmount: string) {
  return { source, toAmount, estimatedGas: 0, gasUsd: 0, routes: [] } as MetaQuoteResult['best']
}

function meta(...quotes: ReturnType<typeof quote>[]): MetaQuoteResult {
  return { best: quotes[0], all: quotes, fetchedAt: 0 } as MetaQuoteResult
}

describe('isExecutableSource — per-chain quote-only scoping [CHORE-SUSHI-V7]', () => {
  it('sushiswap is quote-only on BOTH chains (RedSnwapper not execution-wired)', () => {
    expect(isExecutableSource('sushiswap', 1)).toBe(false)
    expect(isExecutableSource('sushiswap', 8453)).toBe(false)
  })

  it('openocean and native-curve are quote-only on both chains (W7-L-02)', () => {
    for (const chainId of [1, 8453]) {
      expect(isExecutableSource('openocean', chainId)).toBe(false)
      expect(isExecutableSource('curve', chainId)).toBe(false)
    }
  })

  it('the wired sources stay executable on both chains', () => {
    for (const chainId of [1, 8453]) {
      for (const source of ['1inch', '0x', 'velora', 'odos', 'kyberswap', 'uniswapv3', 'cowswap', 'bebop']) {
        expect(isExecutableSource(source, chainId)).toBe(true)
      }
    }
  })

  it('defaults to executable on chains without an explicit map (quote-open coming-soon chains)', () => {
    expect(isExecutableSource('sushiswap', 137)).toBe(true)
  })

  it('INVARIANT: sushiswap stays quote-only while RedSnwapper is not execution-wired — if you added its selector to SC-04 AND an R1 decoder, update QUOTE_ONLY_SOURCES_BY_CHAIN (and re-check the on-chain FC/OE whitelist per chain) instead of deleting this test', () => {
    const sc04 = KNOWN_SWAP_SELECTORS.has(REDSNWAPPER_SNWAP)
    const r1 = VALIDATED_SELECTORS.has(REDSNWAPPER_SNWAP)
    if (!sc04 || !r1) {
      // Not execution-wired → the scoping map MUST keep sushi quote-only.
      expect(QUOTE_ONLY_SOURCES_BY_CHAIN[1].has('sushiswap')).toBe(true)
      expect(QUOTE_ONLY_SOURCES_BY_CHAIN[8453].has('sushiswap')).toBe(true)
    }
  })
})

describe('scopeToExecutable — the displayed winner must be settleable', () => {
  it('rebases best onto the first executable quote and moves it to all[0] (mev-preference contract)', () => {
    const m = meta(quote('sushiswap', '1000'), quote('kyberswap', '990'), quote('cowswap', '980'))
    const scoped = scopeToExecutable(m, 1)!
    expect(scoped.best.source).toBe('kyberswap')
    expect(scoped.all[0].source).toBe('kyberswap')
    // The quote-only winner stays visible (informational), after the winner.
    expect(scoped.all.map((q) => q.source)).toEqual(['kyberswap', 'sushiswap', 'cowswap'])
  })

  it('returns the meta unchanged (same reference) when best is already executable', () => {
    const m = meta(quote('kyberswap', '990'), quote('sushiswap', '980'))
    expect(scopeToExecutable(m, 1)).toBe(m)
  })

  it('returns the meta unchanged when NO quote is executable (SC-04 backstop handles it)', () => {
    const m = meta(quote('sushiswap', '1000'), quote('openocean', '990'))
    expect(scopeToExecutable(m, 1)).toBe(m)
  })

  it('passes null through', () => {
    expect(scopeToExecutable(null, 1)).toBeNull()
  })
})

describe('orderExecutableFallbacks — quote-only sources never enter the fallback walk', () => {
  it('excludes quote-only sources and cowswap, preserving rank order', () => {
    const m = meta(
      quote('kyberswap', '1000'),
      quote('sushiswap', '995'),
      quote('velora', '990'),
      quote('openocean', '985'),
      quote('cowswap', '980'),
      quote('uniswapv3', '975'),
    )
    expect(orderExecutableFallbacks(m, 'kyberswap', 1)).toEqual(['velora', 'uniswapv3'])
  })
})
