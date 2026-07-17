/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Invariants of the COMMITTED generated catalogs
 * (src/config/generated/token-catalog.<chainId>.json). NO network — this is the
 * deterministic CI gate over what `npm run tokens:sync` produced:
 *
 *  - schema + chainId sanity
 *  - every address is EIP-55 with valid integer decimals (anti address-typo)
 *  - no duplicate address and no duplicate symbol per chain (anti-spoofing — mirrors
 *    the guard's duplicate-symbol fatal)
 *  - every CORE token (fee/routing-critical allowlist) is present, verified, core:true
 *  - verified:true rows carry the agreement evidence: >=2 external sources, or the
 *    native sentinel, or a pinned core
 *  - every logoURI is CSP-'self' (/tokens/* bundled asset or the /api/token-logo route)
 *    — no third-party CDN can creep in without a next.config.js img-src review
 */
import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import { NATIVE_ETH } from '@/lib/constants'
import { GENERATED_TOKEN_CATALOG, type GeneratedToken } from './token-catalog.generated'
import { CORE_TOKENS } from '../../../scripts/token-catalog/lib/config'
import catalog1 from '@/config/generated/token-catalog.1.json'
import catalog8453 from '@/config/generated/token-catalog.8453.json'
import allowlist from './catalog-guard.allowlist.json'

const FILES: Array<[number, { schemaVersion: number; chainId: number; counts: { included: number; verified: number } }]> = [
  [1, catalog1],
  [8453, catalog8453],
]

// External (agreement-counting) sources — 'curated'/'native' are provenance markers and
// 'defillama' is market-signal-only (its identity row is near-automatic for any priced
// pool, so it never counts toward the agreement floor).
const NON_VOTING = new Set(['curated', 'native', 'defillama'])

describe.each(FILES)('token-catalog.%i.json — committed catalog invariants', (chainId, file) => {
  const tokens: GeneratedToken[] = GENERATED_TOKEN_CATALOG[chainId]

  it('has the expected schema and chain', () => {
    expect(file.schemaVersion).toBe(1)
    expect(file.chainId).toBe(chainId)
    expect(file.counts.included).toBe(tokens.length)
    expect(file.counts.verified).toBe(tokens.filter((t) => t.verified).length)
    expect(tokens.length).toBeGreaterThan(50)
  })

  it('every address is canonical EIP-55 with valid integer decimals', () => {
    for (const t of tokens) {
      expect(getAddress(t.address)).toBe(t.address)
      expect(Number.isInteger(t.decimals)).toBe(true)
      expect(t.decimals).toBeGreaterThanOrEqual(0)
      expect(t.decimals).toBeLessThanOrEqual(36)
    }
  })

  it('has no duplicate address and no duplicate symbol (anti-spoofing), except CONSCIOUSLY exempted ticker collisions', () => {
    const addrs = tokens.map((t) => t.address.toLowerCase())
    expect(new Set(addrs).size).toBe(addrs.length)

    // Mirrors the catalog guard's duplicateSymbolExempt (src/lib/chains/catalog-guard.allowlist.json):
    // a duplicate symbol is only allowed when EVERY colliding address on this chain is explicitly
    // exempted for that symbol — e.g. CHORE-CATALOG-REUSD-COLLISION (two distinct real mainnet
    // projects both named "reUSD"). A non-exempted duplicate still fails this test.
    const exemptAddrsBySymbol = new Map<string, Set<string>>()
    for (const e of allowlist.duplicateSymbolExempt) {
      if (e.chainId === chainId) exemptAddrsBySymbol.set(e.symbol.toUpperCase(), new Set(e.addresses.map((a) => a.toLowerCase())))
    }
    const bySymbol = new Map<string, GeneratedToken[]>()
    for (const t of tokens) {
      const s = t.symbol.toUpperCase()
      if (!bySymbol.has(s)) bySymbol.set(s, [])
      bySymbol.get(s)!.push(t)
    }
    for (const [symbol, group] of bySymbol) {
      if (group.length <= 1) continue
      const exempt = exemptAddrsBySymbol.get(symbol)
      const fullyExempt = !!exempt && group.every((t) => exempt.has(t.address.toLowerCase()))
      expect(fullyExempt, `symbol "${symbol}" appears ${group.length}x on chain ${chainId} (${group.map((t) => t.address).join(', ')}) — not fully covered by duplicateSymbolExempt`).toBe(true)
    }
  })

  it('every core token is present, verified and flagged core (outage cannot drop them)', () => {
    const byAddr = new Map(tokens.map((t) => [t.address.toLowerCase(), t]))
    for (const core of CORE_TOKENS[chainId]) {
      const row = byAddr.get(core.address.toLowerCase())
      expect(row, `core ${core.symbol} missing`).toBeDefined()
      expect(row!.symbol).toBe(core.symbol)
      expect(row!.decimals).toBe(core.decimals)
      expect(row!.verified).toBe(true)
      expect(row!.core).toBe(true)
    }
  })

  it('the native ETH sentinel is present exactly once and verified via the native source', () => {
    const native = tokens.filter((t) => t.address.toLowerCase() === NATIVE_ETH.toLowerCase())
    expect(native).toHaveLength(1)
    expect(native[0].sources).toEqual(['native'])
    expect(native[0].verified).toBe(true)
  })

  it('verified:true always carries agreement evidence (>=2 external sources, native, or core)', () => {
    for (const t of tokens) {
      if (!t.verified) continue
      const votes = t.sources.filter((s) => !NON_VOTING.has(s)).length
      const ok = votes >= 2 || t.sources.includes('native') || t.core === true
      expect(ok, `${t.symbol} ${t.address} verified without evidence (sources: ${t.sources.join(',')})`).toBe(true)
    }
  })

  it('unverified rows still record their provenance (never an empty sources list)', () => {
    for (const t of tokens) expect(t.sources.length, `${t.symbol} has no sources`).toBeGreaterThan(0)
  })

  it("every logoURI is CSP-'self' (bundled /tokens/* or the /api/token-logo route)", () => {
    for (const t of tokens) {
      const ok = t.logoURI.startsWith('/tokens/') || t.logoURI.startsWith('/api/token-logo?')
      expect(ok, `${t.symbol} logoURI not 'self': ${t.logoURI}`).toBe(true)
    }
  })
})
