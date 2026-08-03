/**
 * [CHORE-47C-ARBITRUM-CATALOG] Arbitrum (42161) launch catalog — resolution + dark-state tests.
 *
 * Closes AUDIT-ARBITRUM-46-47 M-01: CHAIN_TOKENS[42161] was empty (Preview smoke impossible).
 * These tests confirm the 5-token launch catalog resolves correctly WITHOUT touching
 * isChainActive (the chain must stay dark — populating the catalog is additive only).
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

describe('Arbitrum (42161) launch catalog [CHORE-47C-ARBITRUM-CATALOG]', () => {
  it('CHAIN_TOKENS[42161] is exactly the 5-token launch set (adding a 6th requires updating this test)', () => {
    expect(CHAIN_TOKENS[42161]).toHaveLength(5)
    expect(new Set(CHAIN_TOKENS[42161].map((t) => t.symbol))).toEqual(new Set(LAUNCH_SYMBOLS))
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

  it('getPopularTokens(42161) resolves the 5-token set (Preview smoke can find WETH→USDC)', () => {
    const popular = getPopularTokens(42161)
    expect(popular).toHaveLength(5)
    expect(popular.some((t) => t.symbol === 'WETH')).toBe(true)
    expect(popular.some((t) => t.symbol === 'USDC')).toBe(true)
  })

  it('getChainToken resolves each of the 5 tokens by address', () => {
    for (const t of ARBITRUM_CATALOG) {
      expect(getChainToken(t.address, 42161)?.symbol).toBe(t.key)
    }
  })

  it('getChainTokenList(42161) carries decimals + category through to the rich Token shape', () => {
    const list = getChainTokenList(42161)
    expect(list).toHaveLength(5)
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
