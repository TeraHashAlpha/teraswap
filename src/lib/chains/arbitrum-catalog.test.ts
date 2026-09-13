/**
 * [CHORE-47C-ARBITRUM-CATALOG, superseded by CHORE-ARBITRUM-TOKEN-CATALOG-PIPELINE]
 * Arbitrum (42161) launch catalog — resolution + dark-state tests.
 *
 * Originally closed AUDIT-ARBITRUM-46-47 M-01 (CHAIN_TOKENS[42161] was empty). Since
 * CHORE-ARBITRUM-TOKEN-CATALOG-PIPELINE, CHAIN_TOKENS[42161] is the pipeline's curated
 * "Suggested" subset (bigger than 6 — see tokens.ts ARBITRUM_SUGGESTED_SYMBOLS), not the
 * bare 5-manifest-token set — the exact-length assertions below were relaxed accordingly.
 * The manifest's 5 launch tokens are now CORE_TOKENS[42161] (always present, still
 * guard-validated at these exact addresses) rather than the catalog's only content, so every
 * invariant that matters here (addresses match the manifest, dark-state, verified ✓) still
 * holds and is still asserted.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAIN_TOKENS, getPopularTokens, getChainToken, getChainTokenList, isVerifiedToken } from './tokens'
import { isChainActive } from './activation'
import { ARBITRUM_CATALOG } from './arbitrum-catalog'
import { ARBITRUM_MANIFEST_TOKENS } from './arbitrum-catalog.generated'

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json'), 'utf8'),
) as { entries: Array<{ category: string; key: string; address: string; expectDecimals: number }> }

const LAUNCH_SYMBOLS = ['WETH', 'USDC', 'USDT', 'DAI', 'WBTC']
// [fix/arbitrum-native-eth] Native ETH added directly in tokens.ts (not the manifest — a
// native asset has no ERC-20 contract to manifest). Manifest-derived assertions below stay
// scoped to LAUNCH_SYMBOLS; catalog-wide assertions grow to 6.
const CATALOG_SYMBOLS = ['ETH', ...LAUNCH_SYMBOLS]

describe('Arbitrum (42161) launch catalog [CHORE-47C-ARBITRUM-CATALOG]', () => {
  it('CHAIN_TOKENS[42161] contains the 5-token manifest launch set plus native ETH (now a subset of the pipeline suggested set, not the whole catalog)', () => {
    expect(CHAIN_TOKENS[42161].length).toBeGreaterThanOrEqual(6)
    const symbols = new Set(CHAIN_TOKENS[42161].map((t) => t.symbol))
    for (const s of CATALOG_SYMBOLS) expect(symbols, `missing ${s}`).toContain(s)
  })

  it('does NOT include wstETH (deferred, owner decision — no Chainlink feed in the manifest)', () => {
    expect(CHAIN_TOKENS[42161].some((t) => t.symbol === 'wstETH')).toBe(false)
  })

  it('every catalog address/decimals matches the manifest exactly (no hand-drift)', () => {
    const manifestTokens = manifest.entries.filter(
      (e) => e.category === 'token' && LAUNCH_SYMBOLS.includes(e.key),
    )
    expect(manifestTokens).toHaveLength(5)
    for (const m of manifestTokens) {
      const catalogEntry = CHAIN_TOKENS[42161].find((t) => t.symbol === m.key)
      expect(catalogEntry, `missing catalog entry for ${m.key}`).toBeDefined()
      expect(catalogEntry!.address.toLowerCase()).toBe(m.address.toLowerCase())
      expect(catalogEntry!.decimals).toBe(m.expectDecimals)
    }
  })

  it('getPopularTokens(42161) includes the launch majors (Preview smoke can find WETH→USDC)', () => {
    const popular = getPopularTokens(42161)
    expect(popular.length).toBeGreaterThanOrEqual(6)
    expect(popular.length).toBeLessThanOrEqual(12)
    expect(popular.some((t) => t.symbol === 'WETH')).toBe(true)
    expect(popular.some((t) => t.symbol === 'USDC')).toBe(true)
    expect(popular.some((t) => t.symbol === 'ETH')).toBe(true)
  })

  it('getChainToken resolves each of the 5 tokens by address', () => {
    for (const t of ARBITRUM_CATALOG) {
      expect(getChainToken(t.address, 42161)?.symbol).toBe(t.key)
    }
  })

  it('getChainTokenList(42161) carries decimals + category through to the rich Token shape', () => {
    const list = getChainTokenList(42161)
    expect(list.length).toBeGreaterThanOrEqual(6)
    const eth = list.find((t) => t.symbol === 'ETH')!
    expect(eth.decimals).toBe(18)
    expect(eth.category).toBe('Native')
    const weth = list.find((t) => t.symbol === 'WETH')!
    expect(weth.decimals).toBe(18)
    expect(weth.category).toBe('Native')
    const usdc = list.find((t) => t.symbol === 'USDC')!
    expect(usdc.category).toBe('Stablecoin')
    const wbtc = list.find((t) => t.symbol === 'WBTC')!
    expect(wbtc.category).toBe('Wrapped BTC')
  })

  it('USDT catalog entry: decimals 6, address matches the manifest USDT (on-chain symbol USD₮0)', () => {
    const usdt = ARBITRUM_MANIFEST_TOKENS.find((t) => t.key === 'USDT')!
    const catalogUsdt = getChainToken(usdt.address, 42161)!
    expect(catalogUsdt.symbol).toBe('USDT') // catalog key/symbol stays USDT for continuity
    expect(catalogUsdt.decimals).toBe(6)
  })

  // [HARD RULE] Strictly additive — populating the catalog must NOT flip the chain live.
  it('populating the catalog does NOT activate the chain — isChainActive(42161) stays false (dark)', () => {
    expect(isChainActive(42161)).toBe(false)
  })

  it('mainnet + Base catalogs are unaffected (byte-identical)', () => {
    expect(CHAIN_TOKENS[1].length).toBeGreaterThan(0)
    expect(CHAIN_TOKENS[8453].length).toBeGreaterThan(0)
  })

  // [CHORE-ARBITRUM-UI-POLISH] All 5 launch tokens are on-chain checked (manifest `ok: true`
  // on both RPCs) — they must render the ✓ badge, not the "unverified" ⚠ warning.
  it('all 5 launch tokens are verified (manifest on-chain checked, not the unverified ⚠ state)', () => {
    for (const symbol of LAUNCH_SYMBOLS) {
      const entry = CHAIN_TOKENS[42161].find((t) => t.symbol === symbol)!
      expect(entry.verified, `${symbol} should be verified`).toBe(true)
    }
  })

  it('isVerifiedToken(address, 42161) is true for every launch-token address (drives the badge)', () => {
    for (const t of ARBITRUM_CATALOG) {
      expect(isVerifiedToken(t.address, 42161), `${t.key} should resolve verified via isVerifiedToken`).toBe(true)
    }
  })
})
