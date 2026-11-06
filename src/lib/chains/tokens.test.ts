/**
 * [P224] Per-chain token catalog (P221).
 */
import { describe, it, expect } from 'vitest'
import { getPopularTokens, getChainToken, getChainTokenList, CHAIN_TOKENS, remapTokenToChain, remapPairToChain, getDefaultPair, findChainToken, isVerifiedToken, explorerTokenUrl, explorerTxUrl, explorerAddressUrl, getSearchCatalog, rankSearchMatches, computeLowLiquidityDemotions, LOW_LIQUIDITY_FLOOR_USD, getCanonicalUsdc } from './tokens'
import { DEFAULT_TOKENS, findToken, addCustomToken, removeCustomToken } from '@/lib/tokens'
import { NATIVE_ETH } from '@/lib/constants'
import { getChainlinkFeed } from './chainlink-feeds'
import { getChainConfig, getWrappedNative, getSupportedChainIds } from './registry'

describe('chains/tokens [P221]', () => {
  it('returns Base popular tokens for chainId 8453', () => {
    const popular = getPopularTokens(8453)
    const symbols = popular.map((t) => t.symbol)
    expect(symbols).toContain('ETH')
    expect(symbols).toContain('USDC')
    expect(symbols).toContain('WETH')

    const usdc = getChainToken('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 8453)
    expect(usdc?.symbol).toBe('USDC')
    expect(usdc?.decimals).toBe(6)

    const weth = popular.find((t) => t.symbol === 'WETH')
    expect(weth?.address).toBe('0x4200000000000000000000000000000000000006')
  })

  it('returns the existing mainnet tokens for chainId 1 (unchanged)', () => {
    // getChainTokenList(1) returns the exact DEFAULT_TOKENS reference.
    expect(getChainTokenList(1)).toBe(DEFAULT_TOKENS)
    expect(CHAIN_TOKENS[1].length).toBe(DEFAULT_TOKENS.length)
  })

  it('getChainToken returns null for an unknown address', () => {
    expect(getChainToken('0xdeadbeef00000000000000000000000000000000', 8453)).toBeNull()
    expect(getChainToken('0x1111111111111111111111111111111111111111', 1)).toBeNull()
  })
})

// [fix/arbitrum-native-eth] CHORE-47C-ARBITRUM-CATALOG had no native ETH row (a native asset
// has no manifest entry by construction). Added directly in tokens.ts, mirroring mainnet/Base.
describe('Arbitrum (42161) native ETH [fix/arbitrum-native-eth]', () => {
  it('getChainTokenList includes native ETH as the shared NATIVE_ETH sentinel (no chain-specific hex)', () => {
    const eth = getChainTokenList(42161).find((t) => t.symbol === 'ETH')
    expect(eth).toBeDefined()
    expect(eth?.address).toBe(NATIVE_ETH)
    expect(eth?.category).toBe('Native')
  })

  it('L-01: getChainlinkFeed(NATIVE_ETH, 42161) is non-null and equals the WETH-keyed feed', () => {
    const wethFeed = getChainlinkFeed('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 42161)
    const ethFeed = getChainlinkFeed(NATIVE_ETH, 42161)
    expect(ethFeed).not.toBeNull()
    expect(ethFeed).toBe(wethFeed)
  })
})

describe('remapTokenToChain — fix mainnet token addresses on Base [SPRINT-9E]', () => {
  const mainnetUSDC = findToken('USDC')!
  const mainnetETH = findToken('ETH')!

  it('remaps mainnet USDC (0xA0b8…) to Base USDC (0x833589…) on chainId 8453', () => {
    const r = remapTokenToChain(mainnetUSDC, 8453)
    expect(r?.symbol).toBe('USDC')
    expect(r?.address.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(r?.address.toLowerCase()).not.toBe(mainnetUSDC.address.toLowerCase())
    expect(r?.decimals).toBe(6)
  })

  it('is a NO-OP on mainnet (chainId 1) — returns the same token (byte-identical)', () => {
    expect(remapTokenToChain(mainnetUSDC, 1)).toBe(mainnetUSDC)
    expect(remapTokenToChain(mainnetETH, 1)).toBe(mainnetETH)
  })

  it('leaves native ETH unchanged on Base (same NATIVE_ETH sentinel on both chains)', () => {
    expect(remapTokenToChain(mainnetETH, 8453)?.address.toLowerCase()).toBe(mainnetETH.address.toLowerCase())
  })

  it('returns null for a null token', () => {
    expect(remapTokenToChain(null, 8453)).toBeNull()
  })
})

// ── [SPRINT-9P] chain-aware verified badge + scoped import lookup ──

const BASE_WETH = '0x4200000000000000000000000000000000000006'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
// A synthetic address in no catalog. (Was the prod-reported ETHFI import; ETHFI is now admitted to the Base
// catalog by the single-source volume rule — feat/catalog-single-source-volume — so it no longer proves ⚠.)
const UNKNOWN_BASE_IMPORT = '0x3333333333333333333333333333333333333333'

describe('isVerifiedToken — chain-aware badge auto-detect [9P]', () => {
  it('Base catalog tokens verify ✓ on Base', () => {
    expect(isVerifiedToken(BASE_WETH, 8453)).toBe(true)
    expect(isVerifiedToken(BASE_USDC, 8453)).toBe(true)
  })
  it('an unknown address keeps the ⚠ on Base', () => {
    expect(isVerifiedToken(UNKNOWN_BASE_IMPORT, 8453)).toBe(false)
  })
  it('mainnet uses findTokenByAddress (unchanged): mainnet USDC ✓, a Base-only address ✗', () => {
    expect(isVerifiedToken(MAINNET_USDC, 1)).toBe(true)
    expect(isVerifiedToken(BASE_USDC, 1)).toBe(false)
  })
})

describe('explorerTokenUrl — chain-aware [9P]', () => {
  it('mainnet → etherscan.io', () => {
    expect(explorerTokenUrl(MAINNET_USDC, 1)).toBe(`https://etherscan.io/token/${MAINNET_USDC}`)
  })
  it('Base → basescan.org', () => {
    expect(explorerTokenUrl(BASE_USDC, 8453)).toBe(`https://basescan.org/token/${BASE_USDC}`)
  })
})

describe('explorerTxUrl / explorerAddressUrl — chain-aware [SPRINT-9S S3]', () => {
  const HASH = '0xabc0000000000000000000000000000000000000000000000000000000000000'
  it('tx: mainnet → etherscan, Base → basescan', () => {
    expect(explorerTxUrl(HASH, 1)).toBe(`https://etherscan.io/tx/${HASH}`)
    expect(explorerTxUrl(HASH, 8453)).toBe(`https://basescan.org/tx/${HASH}`)
  })
  it('address: mainnet → etherscan, Base → basescan', () => {
    expect(explorerAddressUrl(MAINNET_USDC, 1)).toBe(`https://etherscan.io/address/${MAINNET_USDC}`)
    expect(explorerAddressUrl(BASE_USDC, 8453)).toBe(`https://basescan.org/address/${BASE_USDC}`)
  })
  it('unknown chain falls back to mainnet etherscan (never throws)', () => {
    expect(explorerTxUrl(HASH, 999999)).toBe(`https://etherscan.io/tx/${HASH}`)
  })
})

describe('findChainToken — chain-scoped import lookup [9P]', () => {
  it('resolves a Base catalog token on Base', () => {
    expect(findChainToken(BASE_WETH, 8453)?.symbol).toBe('WETH')
  })
  it('a mainnet catalog token resolves on mainnet (byte-identical)', () => {
    expect(findChainToken(MAINNET_USDC, 1)?.symbol).toBe('USDC')
  })
  it('a Base address does not resolve on mainnet', () => {
    expect(findChainToken(BASE_USDC, 1)).toBeNull()
  })
  it('cross-chain collision: a token imported on Base does NOT leak to mainnet', () => {
    const collision = '0x1111111111111111111111111111111111111111'
    addCustomToken({ address: collision, symbol: 'BASEONLY', name: 'Base Only', decimals: 18, logoURI: '', category: 'Imported', chainId: 8453 })
    expect(findChainToken(collision, 8453)?.symbol).toBe('BASEONLY')
    expect(findChainToken(collision, 1)).toBeNull()
  })
})

// [fix/token-search-ranking] Rank derived from the catalog rows (exact symbol match,
// then source count) — never a hardcoded symbol/address allowlist.
describe('rankSearchMatches — data-driven ranking, no hardcoded allowlist [fix/token-search-ranking]', () => {
  it('ranks an exact case-insensitive symbol match above a substring-only match', () => {
    const tokens = [
      { symbol: 'aUSDC', sources: ['s1', 's2', 's3', 's4'] },
      { symbol: 'USDC', sources: ['s1', 's2'] },
    ]
    const ranked = rankSearchMatches(tokens, 'usdc')
    expect(ranked[0].symbol).toBe('USDC')
    expect(ranked[1].symbol).toBe('aUSDC')
  })

  it('among equal-tier matches, ranks more sources higher', () => {
    const tokens = [
      { symbol: 'cUSDC', sources: ['s1'] },
      { symbol: 'aUSDC', sources: ['s1', 's2', 's3'] },
      { symbol: 'waUSDC', sources: ['s1', 's2'] },
    ]
    const ranked = rankSearchMatches(tokens, 'usdc')
    expect(ranked.map((t) => t.symbol)).toEqual(['aUSDC', 'waUSDC', 'cUSDC'])
  })

  it('applies the same generic rule to synthetic symbols never in any real catalog — proves no hardcoded symbol/address list is involved', () => {
    const tokens = [
      { symbol: 'ZQXFOO', sources: ['s1'] },
      { symbol: 'wZQXFOO', sources: ['s1', 's2', 's3', 's4', 's5'] },
    ]
    const ranked = rankSearchMatches(tokens, 'zqxfoo')
    // Exact match wins even though the substring match has far more sources.
    expect(ranked[0].symbol).toBe('ZQXFOO')
  })

  it('leaves non-matching relative order stable when neither tier nor source count differ', () => {
    const tokens = [
      { symbol: 'FOOBAR', sources: ['s1'] },
      { symbol: 'FOOBAZ', sources: ['s1'] },
    ]
    const ranked = rankSearchMatches(tokens, 'foo')
    expect(ranked.map((t) => t.symbol)).toEqual(['FOOBAR', 'FOOBAZ'])
  })
})

// [fix/token-search-ranking-squatting] Base symbol-squatting recon: 11 addresses share the
// ticker LAPTOP, one real ($1.6M liquidity), the rest near-zero. Synthetic here (same
// convention as the block above) — resolveSymbolConflicts already keeps only one address
// per (chainId, symbol) in the SHIPPED catalog, so multiple same-symbol rows only coexist
// in search results via a session import; this proves the ranking/demotion rule generically.
describe('rankSearchMatches — liquidity + trusted-list tie-break among symbol duplicates [fix/token-search-ranking-squatting]', () => {
  it('Base LAPTOP search: the real (liquid) token ranks first among 10 near-zero clones', () => {
    const real = { symbol: 'LAPTOP', liquidityUsd: 1_600_000, sources: ['coingecko', 'uniswap'] }
    const clones = Array.from({ length: 10 }, (_, i) => ({
      symbol: 'LAPTOP',
      liquidityUsd: 0,
      sources: ['uniswap'],
      _i: i,
    }))
    const ranked = rankSearchMatches([...clones, real], 'laptop')
    expect(ranked[0]).toBe(real)
    expect(ranked).toHaveLength(11) // every clone stays reachable, just lower
  })

  it('native/bridged pairs are NOT squatting — different symbols never trigger the tie-break', () => {
    const usdc = { symbol: 'USDC', liquidityUsd: 50_000, sources: ['coingecko', 'uniswap', 'oneinch'] }
    const usdcE = { symbol: 'USDC.e', liquidityUsd: 5_000_000, sources: ['arbitrumBridge'] }
    const ranked = rankSearchMatches([usdc, usdcE], 'usdc')
    // USDC wins the exact-match tier over the substring match "USDC.e" regardless of
    // liquidity — they are different symbols, so the same-symbol tie-break never applies.
    expect(ranked[0]).toBe(usdc)
    expect(ranked[1]).toBe(usdcE)
  })

  it('null liquidity (no data yet) does not sort below a CONFIRMED zero-liquidity squatter', () => {
    const unknown = { symbol: 'FOO', liquidityUsd: null, sources: ['uniswap'] }
    const zeroSquatter = { symbol: 'FOO', liquidityUsd: 0, sources: ['uniswap', 'oneinch'] }
    const ranked = rankSearchMatches([zeroSquatter, unknown], 'foo')
    expect(ranked[0]).toBe(unknown)
  })

  it('among tied liquidity, CoinGecko trusted-list membership breaks the tie', () => {
    const trusted = { symbol: 'BAR', liquidityUsd: 500, sources: ['coingecko'] }
    const untrusted = { symbol: 'BAR', liquidityUsd: 500, sources: ['uniswap'] }
    const ranked = rankSearchMatches([untrusted, trusted], 'bar')
    expect(ranked[0]).toBe(trusted)
  })
})

describe('computeLowLiquidityDemotions — the "low liquidity / unverified" divider [fix/token-search-ranking-squatting]', () => {
  it('demotes near-zero LAPTOP clones under the $100k floor, never the real token', () => {
    const real = { symbol: 'LAPTOP', liquidityUsd: 1_600_000 }
    const clones = Array.from({ length: 10 }, (_, i) => ({ symbol: 'LAPTOP', liquidityUsd: i === 0 ? null : 0 }))
    const demoted = computeLowLiquidityDemotions([real, ...clones])
    expect(demoted.has(real)).toBe(false)
    expect(clones.every((c) => demoted.has(c))).toBe(true)
    expect(demoted.size).toBe(clones.length) // demoted, not hidden — count matches, none dropped
  })

  it('the documented floor is $100k, matching the pipeline liquidityFloorUsd', () => {
    expect(LOW_LIQUIDITY_FLOOR_USD).toBe(100_000)
  })

  it('does not demote a group where NOTHING clears the floor — no "real" token to be a clone of', () => {
    const a = { symbol: 'FOO', liquidityUsd: 10 }
    const b = { symbol: 'FOO', liquidityUsd: 5 }
    expect(computeLowLiquidityDemotions([a, b]).size).toBe(0)
  })

  it('never demotes a solo low-liquidity match — no duplicate to be a clone of', () => {
    const solo = { symbol: 'FOO', liquidityUsd: 0 }
    expect(computeLowLiquidityDemotions([solo]).size).toBe(0)
  })

  it('native/bridged pairs never collide in the divider — symbols differ', () => {
    const usdc = { symbol: 'USDC', liquidityUsd: 5_000_000 }
    const usdcE = { symbol: 'USDC.e', liquidityUsd: 0 }
    expect(computeLowLiquidityDemotions([usdc, usdcE]).size).toBe(0)
  })
})

describe('getSearchCatalog ranking — real catalog, per chain [fix/token-search-ranking]', () => {
  function exactMatchAddress(chainId: number, symbol: string): string {
    const catalog = getSearchCatalog(chainId)
    const exact = catalog.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase())
    if (!exact) throw new Error(`fixture assumption broken: no exact '${symbol}' match in chain ${chainId} catalog`)
    return exact.address
  }

  it('mainnet (1): searching "USDC" ranks the canonical USDC first', () => {
    const expected = exactMatchAddress(1, 'USDC')
    const catalog = getSearchCatalog(1)
    const matches = catalog.filter((t) => t.symbol.toLowerCase().includes('usdc'))
    const ranked = rankSearchMatches(matches, 'USDC')
    expect(ranked[0].address).toBe(expected)
    // Receipt/wrapped tokens (lookalikes) are still present, not filtered out.
    expect(ranked.length).toBeGreaterThan(1)
  })

  it('Base (8453): the same ranking rule applies, derived from the Base catalog', () => {
    const catalog = getSearchCatalog(8453)
    const matches = catalog.filter((t) => t.symbol.toLowerCase().includes('usdc'))
    if (matches.length < 2) return // fixture has no lookalikes on this chain — rule still holds trivially
    const expected = exactMatchAddress(8453, 'USDC')
    const ranked = rankSearchMatches(matches, 'USDC')
    expect(ranked[0].address).toBe(expected)
  })

  it('Arbitrum (42161): the same ranking rule applies, derived from the Arbitrum catalog', () => {
    const catalog = getSearchCatalog(42161)
    const matches = catalog.filter((t) => t.symbol.toLowerCase().includes('usdc'))
    if (matches.length < 2) return // fixture has no lookalikes on this chain — rule still holds trivially
    const expected = exactMatchAddress(42161, 'USDC')
    const ranked = rankSearchMatches(matches, 'USDC')
    expect(ranked[0].address).toBe(expected)
  })
})

// [CHORE-DCA-DEFAULT-BUY-USDC] DCA's buy leg now defaults to the chain's canonical USDC instead
// of native ETH (which resolveSignableToken turned into the same wrapped native the sell leg is
// pinned to — a same-token WETH→WETH default that signed fine and only failed at routing). Every
// assertion here is against the CATALOG (getChainConfig / getWrappedNative), never an address
// literal, per the prompt's requirement.
describe('getCanonicalUsdc — chain-aware DCA default-buy resolution [CHORE-DCA-DEFAULT-BUY-USDC]', () => {
  it('every supported chain: resolves to exactly the catalog USDC entry for that chain', () => {
    for (const chainId of getSupportedChainIds()) {
      const usdcAddress = getChainConfig(chainId).tokens.USDC
      const resolved = getCanonicalUsdc(chainId)
      expect(resolved).not.toBeNull()
      expect(resolved!.address.toLowerCase()).toBe(usdcAddress.toLowerCase())
      expect(resolved!.symbol).toBe('USDC')
    }
  })

  it('every supported chain: the invariant — default buy (USDC) never equals default sell (WETH)', () => {
    for (const chainId of getSupportedChainIds()) {
      const buy = getCanonicalUsdc(chainId)
      const sell = getWrappedNative(chainId)
      expect(buy).not.toBeNull()
      expect(buy!.address.toLowerCase()).not.toBe(sell.toLowerCase())
    }
  })

  it('a chain with no catalog USDC yields no default (empty selector, never a wrong one)', () => {
    // No chain in CHAIN_CONFIGS actually lacks a USDC entry today (proven by the first test
    // above, over every id getSupportedChainIds() returns) — this exercises the SAME fail-closed
    // path getCanonicalUsdc takes for that case, via a chain id absent from the registry
    // entirely (getChainConfig throws), rather than defaulting to something wrong.
    const unsupportedChainId = 999999
    expect(() => getChainConfig(unsupportedChainId)).toThrow()
    expect(getCanonicalUsdc(unsupportedChainId)).toBeNull()
  })
})

// [fix/v1-maintenance C2] isCuratedToken — per-chain curated membership (case-insensitive).
import { isCuratedToken as _isCuratedToken } from './tokens'
describe('isCuratedToken [fix/v1-maintenance C2]', () => {
  const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
  it('each chain curates its own USDC, case-insensitively', () => {
    expect(_isCuratedToken(MAINNET_USDC, 1)).toBe(true)
    expect(_isCuratedToken(BASE_USDC.toLowerCase(), 8453)).toBe(true)
    expect(_isCuratedToken(ARB_USDC, 42161)).toBe(true)
  })
  it('lists are per chain: a mainnet address is not curated on Base/Arbitrum, and unknowns are not curated anywhere', () => {
    expect(_isCuratedToken(MAINNET_USDC, 8453)).toBe(false)
    expect(_isCuratedToken(BASE_USDC, 1)).toBe(false)
    expect(_isCuratedToken('0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef', 42161)).toBe(false)
    expect(_isCuratedToken(MAINNET_USDC, 999999)).toBe(false)
  })
})

// ── [fix/chain-switch-token-fallback] a token with no home on the chain is NEVER carried over ──

describe('remapTokenToChain / remapPairToChain — chain-switch fallback [fix/chain-switch-token-fallback]', () => {
  const ARB = 42161
  const BASE = 8453
  const SNX_MAINNET = '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f'
  const SNX_BASE = '0x22e6966b799c4d5b13be962e1d117b56327fda66'
  const mainnetSNX = findToken('SNX')!
  const mainnetUSDC = findToken('USDC')!
  const mainnetDAI = findToken('DAI')!
  const mainnetETH = findToken('ETH')!
  const baseSNX = findChainToken(SNX_BASE, BASE)!
  const addrs = (p: { tokenIn: { address: string } | null; tokenOut: { address: string } | null }) =>
    [p.tokenIn?.address.toLowerCase(), p.tokenOut?.address.toLowerCase()]

  it('fixtures: mainnet + Base list SNX, Arbitrum has none (the owner repro)', () => {
    expect(mainnetSNX.address.toLowerCase()).toBe(SNX_MAINNET)
    expect(baseSNX.symbol).toBe('SNX')
    expect(findChainToken(SNX_MAINNET, ARB)).toBeNull()
    expect(getChainTokenList(ARB).some((t) => t.symbol === 'SNX')).toBe(false)
  })

  it('token helper: mainnet SNX → Arbitrum is null, never the mainnet token', () => {
    expect(remapTokenToChain(mainnetSNX, ARB)).toBeNull()
  })

  it('pair: mainnet SNX/USDC → Arbitrum = the Arbitrum default pair (ETH → USDC)', () => {
    const r = remapPairToChain(mainnetSNX, mainnetUSDC, ARB)
    expect(r).toEqual(getDefaultPair(ARB))
    expect(r.tokenIn?.symbol).toBe('ETH')
    expect(r.tokenOut?.address.toLowerCase()).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
  })

  it('Base SNX (0x22e6…) stays on Base — it belongs to the chain (even outside the curated list)', () => {
    expect(remapTokenToChain(baseSNX, BASE)).toBe(baseSNX)
    const r = remapPairToChain(baseSNX, findChainToken('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', BASE)!, BASE)
    expect(r.tokenIn).toBe(baseSNX)
  })

  it('mainnet SNX → Base: Base SNX is catalogued but not curated, so symbol matching does NOT pick it (long-tail clones) → null', () => {
    expect(remapTokenToChain(mainnetSNX, BASE)).toBeNull()
  })

  it('DAI mainnet → Base = Base DAI (symbol match)', () => {
    const r = remapPairToChain(mainnetDAI, mainnetUSDC, BASE)
    expect(r.tokenIn?.address.toLowerCase()).toBe('0x50c5725949a6f0c72e6c4a641f24049a917db0cb')
    expect(r.tokenOut?.address.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
  })

  it('stale {SNX mainnet, DAI mainnet} restored on Base = Base default pair — no mainnet address survives', () => {
    const r = remapPairToChain(mainnetSNX, mainnetDAI, BASE)
    expect(r).toEqual(getDefaultPair(BASE))
    expect(addrs(r)).toEqual(['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'])
  })
  it('stale {SNX mainnet, DAI mainnet} restored on Arbitrum = Arbitrum default pair', () => {
    expect(remapPairToChain(mainnetSNX, mainnetDAI, ARB)).toEqual(getDefaultPair(ARB))
  })

  it('a token imported on Base stays only on Base', () => {
    const imported = '0x1234567890123456789012345678901234567890'
    addCustomToken({ address: imported, symbol: 'IMPBASE', name: 'Imported on Base', decimals: 18, logoURI: '', category: 'Imported', chainId: BASE })
    try {
      const tok = findChainToken(imported, BASE)!
      expect(tok).not.toBeNull()
      // On Base: untouched (same object), pair keeps it.
      expect(remapTokenToChain(tok, BASE)).toBe(tok)
      expect(remapPairToChain(tok, mainnetUSDC, BASE).tokenIn).toBe(tok)
      // Anywhere else: no home → null → default pair.
      expect(remapTokenToChain(tok, 1)).toBeNull()
      expect(remapTokenToChain(tok, ARB)).toBeNull()
      expect(remapPairToChain(tok, mainnetUSDC, ARB)).toEqual(getDefaultPair(ARB))
    } finally {
      removeCustomToken(imported, BASE)
    }
  })

  it('both legs collapsing to the same address → the default pair', () => {
    // A foreign-address "USDC" and the real mainnet USDC both resolve to Base USDC.
    const fakeUsdc = { ...mainnetUSDC, address: '0x9999999999999999999999999999999999999999' as `0x${string}` }
    const r = remapPairToChain(fakeUsdc, mainnetUSDC, BASE)
    expect(r).toEqual(getDefaultPair(BASE))
    expect(r.tokenIn?.address).not.toBe(r.tokenOut?.address)
  })

  it('mainnet is a no-op: same objects back, nothing swapped for the default pair', () => {
    const r = remapPairToChain(mainnetSNX, mainnetUSDC, 1)
    expect(r.tokenIn).toBe(mainnetSNX)
    expect(r.tokenOut).toBe(mainnetUSDC)
    expect(remapPairToChain(mainnetETH, mainnetDAI, 1)).toEqual({ tokenIn: mainnetETH, tokenOut: mainnetDAI })
  })

  it('the default pair is what a fresh visitor gets: ETH → USDC from the chain list; mainnet = DEFAULT_TOKENS entries', () => {
    expect(getDefaultPair(1)).toEqual({ tokenIn: mainnetETH, tokenOut: mainnetUSDC })
    for (const c of [1, BASE, ARB]) {
      const d = getDefaultPair(c)
      expect(d.tokenIn?.symbol).toBe('ETH')
      expect(d.tokenOut?.symbol).toBe('USDC')
      expect(findChainToken(d.tokenOut!.address, c)).not.toBeNull()
    }
  })

  it('every leg of every result is known on the target chain (catalog ∪ imported-for-that-chain)', () => {
    const pool = [mainnetSNX, mainnetUSDC, mainnetDAI, mainnetETH, baseSNX, findChainToken('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', ARB)!]
    for (const c of [1, BASE, ARB]) {
      for (const a of pool) for (const b of pool) {
        const r = remapPairToChain(a, b, c)
        expect(findChainToken(r.tokenIn!.address, c), `${a.symbol}/${b.symbol} → ${c} in`).not.toBeNull()
        expect(findChainToken(r.tokenOut!.address, c), `${a.symbol}/${b.symbol} → ${c} out`).not.toBeNull()
      }
    }
  })

  it('null in stays null; an unknown chain has no home for anything', () => {
    expect(remapPairToChain(null, mainnetUSDC, BASE).tokenIn).toBeNull()
    expect(remapTokenToChain(mainnetUSDC, 999999)).toBeNull()
  })
})
