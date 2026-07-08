/**
 * [CHORE-STABLECOIN-CONSTANT] Chain-keyed stablecoin single source of truth (AZ review FE5).
 *
 * Six divergent inline lists (SlippageModal:19, SwapBox:231 + :556, useSplitRoute:67 + :69,
 * chains/tokens.ts:163) disagreed on what counts as a ~$1 stable per chain — USDbC counted
 * as ~$1 in one gate but not another. This suite pins:
 *   1. the canonical per-chain USD (~$1) membership + drift-guards against the curated
 *      catalogs (mainnet canon == DEFAULT_TOKENS 'Stablecoin' category);
 *   2. EURC (EUR-pegged, NOT ~$1) as category-only — never in a USD set;
 *   3. that every historical call site resolves to the constant (imports it, no inline
 *      membership list left behind) — plus behavioural checks via calculateAutoSlippage.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  USD_STABLECOINS_BY_CHAIN,
  STABLECOIN_CATEGORY_EXTRAS,
  getUsdStablecoins,
  isUsdStablecoin,
  isStablecoinCategorySymbol,
} from './stablecoins'
import { DEFAULT_TOKENS } from '@/lib/tokens'
import { getFullCatalog } from '@/lib/chains/tokens'
import { calculateAutoSlippage } from '@/components/SlippageModal'

const MAINNET_CANON = ['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'PYUSD', 'USDe', 'USDS', 'GHO', 'crvUSD', 'BOLD']
const BASE_CANON = ['USDC', 'USDbC', 'USDT', 'DAI']

describe('USD_STABLECOINS_BY_CHAIN — canonical per-chain membership', () => {
  it('mainnet (1) is exactly the 11 curated USD stables', () => {
    expect([...USD_STABLECOINS_BY_CHAIN[1]].sort()).toEqual([...MAINNET_CANON].sort())
  })

  it('Base (8453) is exactly the 4 curated USD stables — USDbC included', () => {
    expect([...USD_STABLECOINS_BY_CHAIN[8453]].sort()).toEqual([...BASE_CANON].sort())
  })

  it('has no duplicate symbols in any chain set', () => {
    for (const [chainId, set] of Object.entries(USD_STABLECOINS_BY_CHAIN)) {
      expect(new Set(set).size, `chain ${chainId}`).toBe(set.length)
    }
  })

  it('EURC (EUR-pegged, ~$1 is wrong) is never in a USD set on any chain', () => {
    for (const [chainId, set] of Object.entries(USD_STABLECOINS_BY_CHAIN)) {
      expect(set, `chain ${chainId}`).not.toContain('EURC')
    }
  })

  it('mainnet canon drift-guards against the curated catalog (DEFAULT_TOKENS Stablecoin category)', () => {
    const curated = DEFAULT_TOKENS.filter((t) => t.category === 'Stablecoin').map((t) => t.symbol)
    expect([...USD_STABLECOINS_BY_CHAIN[1]].sort()).toEqual(curated.sort())
  })

  it('every Base member exists in the Base catalog (no phantom ~$1 symbols)', () => {
    const symbols = new Set(getFullCatalog(8453).map((t) => t.symbol))
    for (const s of USD_STABLECOINS_BY_CHAIN[8453]) {
      expect(symbols.has(s), `Base catalog is missing ${s}`).toBe(true)
    }
  })
})

describe('isUsdStablecoin / getUsdStablecoins', () => {
  it('USDbC is ~$1 on Base and NOT on mainnet', () => {
    expect(isUsdStablecoin('USDbC', 8453)).toBe(true)
    expect(isUsdStablecoin('USDbC', 1)).toBe(false)
  })

  it('GHO/crvUSD/BOLD are ~$1 on mainnet only', () => {
    for (const s of ['GHO', 'crvUSD', 'BOLD']) {
      expect(isUsdStablecoin(s, 1), s).toBe(true)
      expect(isUsdStablecoin(s, 8453), s).toBe(false)
    }
  })

  it('matches the exact catalog symbol casing (an imported lowercase "usdc" gains no ~$1 trust)', () => {
    expect(isUsdStablecoin('usdc', 1)).toBe(false)
    expect(isUsdStablecoin('USDC', 1)).toBe(true)
  })

  it('is false for null/undefined symbols', () => {
    expect(isUsdStablecoin(undefined, 1)).toBe(false)
    expect(isUsdStablecoin(null, 1)).toBe(false)
  })

  it('unknown chain → empty set, nothing is ~$1 (fail-closed)', () => {
    expect(getUsdStablecoins(999)).toEqual([])
    expect(isUsdStablecoin('USDC', 999)).toBe(false)
  })
})

describe('STABLECOIN_CATEGORY_EXTRAS / isStablecoinCategorySymbol — UI taxonomy ⊃ USD set', () => {
  it('EURC keeps the Stablecoin UI category on both chains', () => {
    expect(isStablecoinCategorySymbol('EURC', 1)).toBe(true)
    expect(isStablecoinCategorySymbol('EURC', 8453)).toBe(true)
  })

  it('every USD stable is also category-Stablecoin', () => {
    for (const [chainId, set] of Object.entries(USD_STABLECOINS_BY_CHAIN)) {
      for (const s of set) {
        expect(isStablecoinCategorySymbol(s, Number(chainId)), `${s}@${chainId}`).toBe(true)
      }
    }
  })

  it('category extras never leak into the USD sets', () => {
    for (const [chainId, extras] of Object.entries(STABLECOIN_CATEGORY_EXTRAS)) {
      for (const s of extras) {
        expect(isUsdStablecoin(s, Number(chainId)), `${s}@${chainId}`).toBe(false)
      }
    }
  })

  it('yield-accruing lookalikes (sUSDe/sDAI — NOT ~$1) stay out of both sets', () => {
    for (const s of ['sUSDe', 'sDAI']) {
      expect(isUsdStablecoin(s, 1), s).toBe(false)
      expect(isStablecoinCategorySymbol(s, 1), s).toBe(false)
    }
  })
})

describe('call sites resolve to the constant', () => {
  // The 4 files hosting the 6 historical inline lists (AZ FE5: SlippageModal:19,
  // SwapBox:231 + :556, useSplitRoute:67 + :69, chains/tokens.ts:163).
  const CALL_SITES: Array<{ file: string; helper: RegExp; minUses: number }> = [
    { file: 'src/components/SlippageModal.tsx', helper: /isUsdStablecoin\(/g, minUses: 2 },
    // The exec-price derivation uses it twice (tokenOut + tokenIn). The third historical
    // use (the input-USD estimate) moved into lib/swap-usd-estimate.ts
    // ([CHORE-ORACLE-VALUE-FAILCLOSED] max(in,out) estimate) — scanned below.
    { file: 'src/components/SwapBox.tsx', helper: /isUsdStablecoin\(/g, minUses: 2 },
    { file: 'src/lib/swap-usd-estimate.ts', helper: /isUsdStablecoin\(/g, minUses: 1 },
    { file: 'src/hooks/useSplitRoute.ts', helper: /isUsdStablecoin\(/g, minUses: 2 },
    { file: 'src/lib/chains/tokens.ts', helper: /isStablecoinCategorySymbol\(/g, minUses: 1 },
  ]
  // Signature of the historical inline lists — every one of the 6 started ['USDC', 'USDT', …].
  const INLINE_LIST = /\[\s*['"]USDC['"]\s*,\s*['"]USDT['"]/
  const IMPORT_RE = /from\s+['"](?:@\/lib\/chains\/stablecoins|\.\/stablecoins)['"]/

  for (const site of CALL_SITES) {
    const src = () => readFileSync(path.resolve(process.cwd(), site.file), 'utf8')

    it(`${site.file} imports the constant module`, () => {
      expect(src()).toMatch(IMPORT_RE)
    })

    it(`${site.file} has no inline stablecoin membership list left`, () => {
      expect(src()).not.toMatch(INLINE_LIST)
    })

    it(`${site.file} resolves membership through the shared helper (>=${site.minUses} uses)`, () => {
      expect((src().match(site.helper) ?? []).length).toBeGreaterThanOrEqual(site.minUses)
    })
  }
})

describe('calculateAutoSlippage — chain-keyed membership (behavioural)', () => {
  it('USDbC→USDC on Base is stable-to-stable → 0.1', () => {
    expect(calculateAutoSlippage('USDbC', 'USDC', 8453)).toBe(0.1)
  })

  it('USDbC→USDC on mainnet is NOT stable-to-stable (no mainnet USDbC) → 0.5', () => {
    expect(calculateAutoSlippage('USDbC', 'USDC', 1)).toBe(0.5)
  })

  it('GHO→USDC on mainnet is stable-to-stable → 0.1 (GHO was missing from the old list)', () => {
    expect(calculateAutoSlippage('GHO', 'USDC', 1)).toBe(0.1)
  })

  it('BOLD→USDC on Base → 0.5 (BOLD is mainnet-only)', () => {
    expect(calculateAutoSlippage('BOLD', 'USDC', 8453)).toBe(0.5)
  })

  it('ETH→USDbC on Base is major-to-stable → 0.3', () => {
    expect(calculateAutoSlippage('ETH', 'USDbC', 8453)).toBe(0.3)
  })

  it('defaults to mainnet membership when chainId is omitted (back-compat)', () => {
    expect(calculateAutoSlippage('USDC', 'USDT')).toBe(0.1)
  })
})
