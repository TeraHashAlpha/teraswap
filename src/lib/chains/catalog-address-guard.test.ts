/**
 * catalog-address-guard — deterministic gate over the curated token catalog.
 *
 * Validates EVERY token in src/lib/tokens.ts + src/lib/chains/tokens.ts (chains 1 + 8453)
 * against the four failure classes found this sprint (W / USDe / weETH dead addresses,
 * legacy non-transferable MORPHO). Reads a committed verdict cache (catalog-guard.trust.json,
 * refreshed by scripts/refresh-catalog-guard.ts) — NO network here, so the gate is
 * reproducible and never flaky. See catalog-guard.ts for the check semantics.
 */
import { describe, it, expect } from 'vitest'
import { getFullCatalog } from '@/lib/chains/tokens'
import { getSupportedChainIds } from '@/lib/chains/registry'
import { NATIVE_ETH } from '@/lib/constants'
import { auditCatalog, auditChain, fatal, warnings, type Verdict, type Allowlist } from '@/lib/chains/catalog-guard'
import trustFixture from '@/lib/chains/catalog-guard.trust.json'
import allowlistJson from '@/lib/chains/catalog-guard.allowlist.json'

const verdicts = trustFixture.tokens as Verdict[]
const allowlist = allowlistJson as unknown as Allowlist
// The audited chains MUST track the registry — a chain added there is rendered by ChainSelector +
// TokenSelector (so its tokens are user-selectable) and must NOT silently escape the guard.
// NOTE: custom/imported tokens (getSearchCatalog ∪ getCustomTokens) are intentionally OUT of scope —
// they are inherently untrusted and the UI marks them ⚠ (verified=false); the guard's contract is the
// CURATED catalog (getFullCatalog).
// [SPRINT-46-ARBITRUM-CONFIG] 42161 registered CONFIG-ONLY / dark — its curated catalog
// (CHAIN_TOKENS[42161]) is deliberately absent, so getFullCatalog(42161) is [] and this audit
// is trivially clean. Populating a real Arbitrum catalog is activation-sprint scope.
const CHAINS = [1, 8453, 42161] as const

describe('catalog-address-guard — live catalog is clean', () => {
  it('audits every registry-supported chain (no unaudited-chain drift)', () => {
    expect([...CHAINS].sort()).toEqual([...getSupportedChainIds()].sort())
  })

  const catalogByChain = Object.fromEntries(CHAINS.map((c) => [c, getFullCatalog(c)])) as Record<number, ReturnType<typeof getFullCatalog>>
  const findings = auditCatalog(catalogByChain, verdicts, allowlist)
  const fatals = fatal(findings)

  it('has NO fatal findings (dead / untrusted / duplicate-symbol)', () => {
    if (fatals.length) {
      const lines = fatals.map((f) => `  [${f.severity}] ${f.check} chain ${f.chainId} ${f.symbol} ${f.address}\n      ${f.message}`).join('\n')
      throw new Error(`catalog-address-guard found ${fatals.length} FATAL issue(s):\n${lines}`)
    }
    expect(fatals).toEqual([])
  })

  it('every catalog token (except native-ETH) has a cached verdict', () => {
    const missing = fatals.filter((f) => f.check === 'verdict-cache')
    expect(missing, missing.map((m) => `${m.chainId}:${m.symbol}`).join(', ')).toEqual([])
  })

  it('surfaces transferability/RPC advisories without failing', () => {
    const warns = warnings(findings)
    // advisory only — never reds the gate; just report the count for visibility.
    expect(Array.isArray(warns)).toBe(true)
    expect(warns.length).toBeGreaterThanOrEqual(0)
  })
})

// ─── Regression proofs: each known-bad class MUST be caught (committed, deterministic). ───
describe('catalog-address-guard — catches the four failure classes', () => {
  const AL: Allowlist = { nativeEth: NATIVE_ETH, trustedListExempt: [], duplicateSymbolExempt: [] }

  it('class 1/2 — DEAD address (W/USDe/weETH): no bytecode + not in trusted list ⇒ fatal', () => {
    const dead = '0xb0FFa8000886E57F86dD5264B987B9993715E059' // the wrong W address removed this sprint
    const v: Verdict[] = [{ chainId: 1, address: dead, symbol: 'W', inTrustedList: false, hasBytecode: false, transferable: false }]
    const f = fatal(auditChain(1, [{ address: dead, symbol: 'W' }], v, AL))
    expect(f.map((x) => x.check).sort()).toEqual(['bytecode', 'trusted-list'])
  })

  it('class — a NEW/changed address with no cached verdict ⇒ fatal (forces re-verification)', () => {
    const usdeDead = '0x4c9eDD5852CD905F23c3acF6c2ff8eCA3ce50370'
    const f = fatal(auditChain(1, [{ address: usdeDead, symbol: 'USDe' }], [], AL))
    expect(f).toHaveLength(1)
    expect(f[0].check).toBe('verdict-cache')
  })

  it('class 4 — DUPLICATE symbol (legacy + current MORPHO on one chain) ⇒ fatal', () => {
    const legacy = '0x9994E35Db50125E0DF82e4c2dde62496CE330999'
    const current = '0x58D97B57BB95320F9a05dC918Aef65434969c2B2'
    const tokens = [{ address: legacy, symbol: 'MORPHO' }, { address: current, symbol: 'MORPHO' }]
    const v: Verdict[] = [
      { chainId: 1, address: legacy, symbol: 'MORPHO', inTrustedList: true, hasBytecode: true, transferable: false },
      { chainId: 1, address: current, symbol: 'MORPHO', inTrustedList: true, hasBytecode: true, transferable: true },
    ]
    const f = fatal(auditChain(1, tokens, v, AL))
    expect(f.some((x) => x.check === 'duplicate-symbol')).toBe(true)
  })

  it('class 3 — NON-TRANSFERABLE (legacy MORPHO) ⇒ advisory warn, never fatal', () => {
    const legacy = '0x9994E35Db50125E0DF82e4c2dde62496CE330999'
    const v: Verdict[] = [{ chainId: 1, address: legacy, symbol: 'MORPHO', inTrustedList: true, hasBytecode: true, transferable: false }]
    const f = auditChain(1, [{ address: legacy, symbol: 'MORPHO' }], v, AL)
    expect(fatal(f)).toEqual([])
    expect(warnings(f).some((x) => x.check === 'transferable')).toBe(true)
  })

  it('IDENTITY — a typo/swap to ANOTHER live token under the same symbol ⇒ fatal', () => {
    // address is a real, trusted, transferable contract, but its on-chain symbol() differs from
    // the catalog symbol (it is actually a different token). Not in symbolMismatchExempt ⇒ fatal.
    const addr = '0xdAC17F958D2ee523a2206206994597C13D831ec7' // USDT contract, labelled "DAI"
    const v: Verdict[] = [{ chainId: 1, address: addr, symbol: 'DAI', inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: 'USDT' }]
    const f = fatal(auditChain(1, [{ address: addr, symbol: 'DAI' }], v, AL))
    expect(f.some((x) => x.check === 'identity')).toBe(true)
  })

  it('IDENTITY — a legit catalog/on-chain mismatch pinned in symbolMismatchExempt ⇒ no fatal', () => {
    const addr = '0x1a7e4e63778B4f12a199C062f3eFdD288afCBce8' // agEUR, on-chain symbol EURA
    const v: Verdict[] = [{ chainId: 1, address: addr, symbol: 'agEUR', inTrustedList: false, hasBytecode: true, transferable: true, onchainSymbol: 'EURA' }]
    const al: Allowlist = { ...AL, trustedListExempt: [{ chainId: 1, address: addr, symbol: 'agEUR', reason: 'x' }], symbolMismatchExempt: [{ chainId: 1, address: addr, symbol: 'agEUR', onchainSymbol: 'EURA', reason: 'Angle rebrand' }] }
    expect(fatal(auditChain(1, [{ address: addr, symbol: 'agEUR' }], v, al))).toEqual([])
  })

  it('DUPLICATE exemption is ADDRESS-scoped — an extra address under an exempted ticker ⇒ fatal', () => {
    const a1 = '0x232CE3bd40fCd6f80f3d55A522d03f25Df784Ee2'
    const a2 = '0xb59490aB09A0f526Cc7305822aC65f2Ab12f9723'
    const evil = '0x000000000000000000000000000000000000bEEF'
    const al: Allowlist = { ...AL, duplicateSymbolExempt: [{ chainId: 1, symbol: 'LIT', addresses: [a1, a2], reason: 'collision' }] }
    const v: Verdict[] = [a1, a2, evil].map((address) => ({ chainId: 1, address, symbol: 'LIT', inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: 'LIT' }))
    // a1+a2 alone (fully exempt) ⇒ ok
    expect(fatal(auditChain(1, [{ address: a1, symbol: 'LIT' }, { address: a2, symbol: 'LIT' }], v, al)).some((x) => x.check === 'duplicate-symbol')).toBe(false)
    // a1+a2+evil ⇒ duplicate-symbol fatal re-trips (evil not in the exempt address set)
    expect(fatal(auditChain(1, [{ address: a1, symbol: 'LIT' }, { address: a2, symbol: 'LIT' }, { address: evil, symbol: 'LIT' }], v, al)).some((x) => x.check === 'duplicate-symbol')).toBe(true)
  })

  it('CACHE FRESHNESS — verdict symbol drift from the catalog symbol ⇒ fatal', () => {
    const addr = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const v: Verdict[] = [{ chainId: 1, address: addr, symbol: 'USDC', inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: 'USDC' }]
    const f = fatal(auditChain(1, [{ address: addr, symbol: 'RENAMED' }], v, AL))
    expect(f.some((x) => x.check === 'verdict-cache')).toBe(true)
  })

  it('DECIMALS — catalog decimals ≠ on-chain decimals() ⇒ fatal (the FLUX 18-vs-8 bug)', () => {
    // FLUX: the catalog carried decimals 18 but the contract is 8 — a fund-affecting 10^10 swap-sizing error.
    const flux = '0x720CD16b011b987Da3518fbf38c3071d4F0D1495'
    const v: Verdict[] = [{ chainId: 1, address: flux, symbol: 'FLUX', inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: 'FLUX', decimals: 8 }]
    const f = fatal(auditChain(1, [{ address: flux, symbol: 'FLUX', decimals: 18 }], v, AL))
    expect(f.some((x) => x.check === 'decimals')).toBe(true)
    // corrected to 8 ⇒ no decimals fatal
    expect(fatal(auditChain(1, [{ address: flux, symbol: 'FLUX', decimals: 8 }], v, AL)).some((x) => x.check === 'decimals')).toBe(false)
  })

  it('DECIMALS — unknown on-chain decimals (null) ⇒ advisory warn, never fatal', () => {
    const addr = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    const v: Verdict[] = [{ chainId: 1, address: addr, symbol: 'WETH', inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: 'WETH', decimals: null }]
    const f = auditChain(1, [{ address: addr, symbol: 'WETH', decimals: 18 }], v, AL)
    expect(fatal(f).some((x) => x.check === 'decimals')).toBe(false)
    expect(warnings(f).some((x) => x.check === 'decimals')).toBe(true)
  })

  it('a clean token (in trusted list, bytecode, transferable, unique) ⇒ no findings', () => {
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const v: Verdict[] = [{ chainId: 1, address: usdc, symbol: 'USDC', inTrustedList: true, hasBytecode: true, transferable: true, onchainSymbol: 'USDC', decimals: 6 }]
    expect(auditChain(1, [{ address: usdc, symbol: 'USDC', decimals: 6 }], v, AL)).toEqual([])
  })

  it('native-ETH sentinel is exempt from on-chain + trusted-list checks', () => {
    const f = auditChain(1, [{ address: NATIVE_ETH, symbol: 'ETH' }], [], AL)
    expect(f).toEqual([])
  })
})
