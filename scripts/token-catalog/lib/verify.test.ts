/**
 * [CHORE-TOKEN-CATALOG-PIPELINE] Pure cross-verification core.
 *
 * Covers the quality-criteria matrix from docs/Prompts/CHORE-TOKEN-CATALOG-PIPELINE.md:
 *  - merge is keyed by (chainId, checksummed address), NEVER by symbol
 *  - >=2 sources agree; >=3 when the market signal is weak/unknown
 *  - new tokens must include the required trusted source (coingecko)
 *  - same-symbol different-address conflicts are never merged; loser rejected + logged
 *  - guard-PASS gating (the on-chain checks are the EXISTING catalog guard, reused)
 *  - core allowlist force-include under total source outage; core guard failure throws
 *  - seeds failing verification stay included with verified:false (flagged, never dropped)
 *  - new-token growth cap is logged, never silent
 */
import { describe, it, expect } from 'vitest'
import type { Candidate, GuardOutcome, MarketSignal, PipelineConfig, SeedToken, SourceEntry } from './types'
import { CoreTokenValidationError } from './types'
import { CORE_TOKENS, NATIVE_ETH_SENTINEL, PIPELINE_CONFIG } from './config'
import {
  mergeByAddress,
  isLowLiquidity,
  crossVerify,
  resolveSymbolConflicts,
  assembleCatalog,
} from './verify'

// ── fixtures ──────────────────────────────────────────────────────────────
// Real pinned addresses (copied from token-catalog.test.ts majors — never hand-typed).
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as const
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as const

const CFG: PipelineConfig = { ...PIPELINE_CONFIG, maxNewTokensPerChain: { 1: 400, 8453: 250 } }

function entry(p: Partial<SourceEntry> & { source: SourceEntry['source'] }): SourceEntry {
  return {
    chainId: 1,
    address: WETH,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    ...p,
  } as SourceEntry
}

function candidate(p: Partial<Candidate>): Candidate {
  return {
    chainId: 1,
    address: WETH,
    sources: ['uniswap', 'coingecko'],
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    decimalsDisagree: false,
    ...p,
  }
}

const HEALTHY: MarketSignal = { volume24hUsd: 5_000_000 }
const LOWLIQ: MarketSignal = { volume24hUsd: 1_000, priceUsd: 0.01, priceConfidence: 0.5 }

const noCategory = () => 'Other'
const noLogo = () => '/api/token-logo?chainId=1&address=0x0'

function assembleInput(p: Partial<Parameters<typeof assembleCatalog>[0]>) {
  return {
    chainId: 1,
    qualified: [] as Candidate[],
    guard: new Map<string, GuardOutcome>(),
    seeds: new Map<string, SeedToken>(),
    cores: [],
    market: new Map<string, MarketSignal>(),
    config: CFG,
    categoryFor: noCategory,
    logoFor: noLogo,
    ...p,
  }
}

/** guard-PASS entry for an address. */
const pass = (addr: string): [string, GuardOutcome] => [addr.toLowerCase(), { status: 'pass' }]

// ── mergeByAddress ────────────────────────────────────────────────────────
describe('mergeByAddress — identity is (chainId, checksummed address)', () => {
  it('merges the same address across sources (case-insensitively) into one candidate with distinct sources', () => {
    const merged = mergeByAddress([
      entry({ source: 'uniswap' }),
      entry({ source: 'coingecko', address: WETH.toLowerCase() as `0x${string}` }),
      entry({ source: 'coingecko' }), // duplicate vote from same source — counted once
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].address).toBe(WETH) // stored EIP-55, not lowercase
    expect(merged[0].sources).toEqual(['uniswap', 'coingecko'])
  })

  it('NEVER merges same-symbol different-address entries', () => {
    const merged = mergeByAddress([
      entry({ source: 'uniswap' }),
      entry({ source: 'coingecko', address: DAI, name: 'Fake WETH' }),
    ])
    expect(merged).toHaveLength(2)
  })

  it('keeps same address on different chains as separate candidates', () => {
    const merged = mergeByAddress([entry({ source: 'uniswap' }), entry({ source: 'coingecko', chainId: 8453 })])
    expect(merged).toHaveLength(2)
  })

  it('takes majority consensus for symbol/decimals and flags decimals disagreement', () => {
    const merged = mergeByAddress([
      entry({ source: 'uniswap', decimals: 18 }),
      entry({ source: 'coingecko', decimals: 18 }),
      entry({ source: 'trustwallet', decimals: 8 }),
    ])
    expect(merged[0].decimals).toBe(18)
    expect(merged[0].decimalsDisagree).toBe(true)
  })

  it('symbol consensus is case-preserving majority with source-priority tiebreak', () => {
    const merged = mergeByAddress([
      entry({ source: 'trustwallet', symbol: 'weth' }),
      entry({ source: 'uniswap', symbol: 'WETH' }),
    ])
    // tie (1-1) → source priority: uniswap outranks trustwallet
    expect(merged[0].symbol).toBe('WETH')
  })
})

// ── isLowLiquidity ────────────────────────────────────────────────────────
describe('isLowLiquidity — the >=3 bump trigger', () => {
  it('volume above the floor is healthy', () => {
    expect(isLowLiquidity(HEALTHY, CFG)).toBe(false)
  })
  it('volume below the floor with weak price confidence is low-liquidity', () => {
    expect(isLowLiquidity(LOWLIQ, CFG)).toBe(true)
  })
  it('unknown volume but confident DefiLlama price clears the floor', () => {
    expect(isLowLiquidity({ priceUsd: 1.0, priceConfidence: 0.99 }, CFG)).toBe(false)
  })
  it('NO market data at all counts as low-liquidity', () => {
    expect(isLowLiquidity(undefined, CFG)).toBe(true)
  })
})

// ── crossVerify ───────────────────────────────────────────────────────────
describe('crossVerify — source-agreement rules', () => {
  const key = (c: Candidate) => `${c.chainId}:${c.address.toLowerCase()}`

  it('2 agreeing sources + healthy market ⇒ qualified', () => {
    const c = candidate({ sources: ['uniswap', 'coingecko'] })
    const { qualified, rejected } = crossVerify([c], new Map([[key(c), HEALTHY]]), new Set(), CFG)
    expect(qualified).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  it('2 agreeing sources but LOW liquidity ⇒ rejected (needs 3)', () => {
    const c = candidate({ sources: ['uniswap', 'coingecko'] })
    const { qualified, rejected } = crossVerify([c], new Map([[key(c), LOWLIQ]]), new Set(), CFG)
    expect(qualified).toHaveLength(0)
    expect(rejected[0].reason).toBe('insufficient-sources-low-liquidity')
  })

  it('3 agreeing sources + LOW liquidity ⇒ qualified', () => {
    const c = candidate({ sources: ['uniswap', 'coingecko', 'oneinch'] })
    const { qualified } = crossVerify([c], new Map([[key(c), LOWLIQ]]), new Set(), CFG)
    expect(qualified).toHaveLength(1)
  })

  it('1 source only ⇒ rejected', () => {
    const c = candidate({ sources: ['uniswap'] })
    const { qualified, rejected } = crossVerify([c], new Map([[key(c), HEALTHY]]), new Set(), CFG)
    expect(qualified).toHaveLength(0)
    expect(rejected[0].reason).toBe('insufficient-sources')
  })

  it('a NEW token without the required coingecko vote ⇒ rejected even with 2 sources', () => {
    const c = candidate({ sources: ['uniswap', 'trustwallet'] })
    const { qualified, rejected } = crossVerify([c], new Map([[key(c), HEALTHY]]), new Set(), CFG)
    expect(qualified).toHaveLength(0)
    expect(rejected[0].reason).toBe('missing-required-source')
  })

  it('a SEED token is exempt from the required-source rule', () => {
    const c = candidate({ sources: ['uniswap', 'trustwallet'] })
    const seeds = new Set([key(c)])
    const { qualified } = crossVerify([c], new Map([[key(c), HEALTHY]]), seeds, CFG)
    expect(qualified).toHaveLength(1)
  })

  it("the 'curated' pseudo-source does NOT count as an agreement vote", () => {
    const c = candidate({ sources: ['curated', 'uniswap'] })
    const { qualified, rejected } = crossVerify([c], new Map([[key(c), HEALTHY]]), new Set([key(c)]), CFG)
    expect(qualified).toHaveLength(0)
    expect(rejected[0].reason).toBe('insufficient-sources')
  })

  it("'defillama' does NOT count as an agreement vote (near-automatic for any priced pool)", () => {
    const seed = candidate({ sources: ['defillama', 'uniswap'] })
    const { qualified, rejected } = crossVerify([seed], new Map([[key(seed), HEALTHY]]), new Set([key(seed)]), CFG)
    expect(qualified).toHaveLength(0)
    expect(rejected[0].reason).toBe('insufficient-sources')
  })

  it("'defillama' cannot be the 3rd source that clears the low-liquidity floor", () => {
    const c = candidate({ sources: ['uniswap', 'coingecko', 'defillama'] })
    const { qualified, rejected } = crossVerify([c], new Map([[key(c), LOWLIQ]]), new Set(), CFG)
    expect(qualified).toHaveLength(0)
    expect(rejected[0].reason).toBe('insufficient-sources-low-liquidity')
  })
})

// ── resolveSymbolConflicts ────────────────────────────────────────────────
describe('resolveSymbolConflicts — same (chainId, symbol), different addresses', () => {
  it('keeps the address backed by the higher-priority source and rejects the rest, logged', () => {
    const canonical = candidate({ address: WETH, sources: ['superchain', 'coingecko'] })
    const impostor = candidate({ address: DAI, sources: ['trustwallet', 'coingecko'], name: 'Fake Wrapped Ether' })
    const { kept, conflicts, rejected } = resolveSymbolConflicts([impostor, canonical], new Map(), CFG)
    expect(kept.map((c) => c.address)).toEqual([WETH])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ chainId: 1, symbol: 'WETH', kept: WETH, rejected: [DAI] })
    expect(rejected[0].reason).toBe('symbol-conflict')
  })

  it('symbol comparison is case-insensitive', () => {
    const a = candidate({ address: WETH, symbol: 'WETH', sources: ['uniswap', 'coingecko'] })
    const b = candidate({ address: DAI, symbol: 'weth', sources: ['trustwallet', 'coingecko'] })
    const { kept, conflicts } = resolveSymbolConflicts([a, b], new Map(), CFG)
    expect(kept).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
  })

  it('same symbol on DIFFERENT chains is NOT a conflict', () => {
    const a = candidate({ address: WETH, chainId: 1 })
    const b = candidate({ address: '0x4200000000000000000000000000000000000006', chainId: 8453 })
    const { kept, conflicts } = resolveSymbolConflicts([a, b], new Map(), CFG)
    expect(kept).toHaveLength(2)
    expect(conflicts).toHaveLength(0)
  })

  it('priority tie falls back to more sources, then higher volume', () => {
    const more = candidate({ address: WETH, sources: ['coingecko', 'oneinch', 'trustwallet'] })
    const fewer = candidate({ address: DAI, sources: ['coingecko', 'oneinch'] })
    const { kept } = resolveSymbolConflicts([fewer, more], new Map(), CFG)
    expect(kept.map((c) => c.address)).toEqual([WETH])
  })

  it('a FULL tie (priority, votes, volume) rejects the WHOLE group — address order is grindable', () => {
    // vanity 0x0000… address would win a lexicographic tiebreak — must not decide a ticker
    const vanity = candidate({ address: '0x0000000000c5dc95539589fbD24BE07c6C14eCa4', sources: ['coingecko', 'trustwallet'] })
    const victim = candidate({ address: WETH, sources: ['coingecko', 'oneinch'] })
    const { kept, conflicts, rejected } = resolveSymbolConflicts([vanity, victim], new Map(), CFG)
    expect(kept).toHaveLength(0)
    expect(conflicts[0].kept).toBeNull()
    expect(rejected).toHaveLength(2)
    expect(rejected.every((r) => r.reason === 'symbol-conflict')).toBe(true)
  })
})

// ── assembleCatalog ───────────────────────────────────────────────────────
describe('assembleCatalog — guard-gated, cores forced, seeds preserved, caps logged', () => {
  it('TOTAL source outage: cores are still included and guard-verified', () => {
    const cores = CORE_TOKENS[1]
    const guard = new Map(cores.filter((c) => !c.native).map((c) => pass(c.address)))
    const { tokens, report } = assembleCatalog(assembleInput({ qualified: [], cores, guard }))
    const symbols = tokens.map((t) => t.symbol)
    expect(symbols).toEqual(expect.arrayContaining(['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'WBTC']))
    for (const t of tokens) expect(t.core).toBe(true)
    // native ETH verifies via the sentinel pseudo-source; ERC-20 cores via guard PASS
    expect(tokens.find((t) => t.symbol === 'ETH')?.verified).toBe(true)
    expect(tokens.find((t) => t.symbol === 'WETH')?.verified).toBe(true)
    expect(report.included).toBe(cores.length)
  })

  it('a core with a FATAL guard finding THROWS (fund-critical, never ship silently)', () => {
    const cores = CORE_TOKENS[1]
    const guard = new Map(cores.filter((c) => !c.native).map((c) => pass(c.address)))
    guard.set(USDC.toLowerCase(), { status: 'fatal', detail: 'decimals 6 ≠ on-chain 18' })
    expect(() => assembleCatalog(assembleInput({ cores, guard }))).toThrow(CoreTokenValidationError)
  })

  it('a core with an UNVERIFIABLE guard outcome (RPC null) also THROWS — fail-closed', () => {
    const cores = CORE_TOKENS[1]
    const guard = new Map(cores.filter((c) => !c.native).map((c) => pass(c.address)))
    guard.set(USDC.toLowerCase(), { status: 'unverifiable', detail: 'RPC unreachable' })
    expect(() => assembleCatalog(assembleInput({ cores, guard }))).toThrow(CoreTokenValidationError)
  })

  it('a qualified candidate with guard PASS gets verified:true with its sources persisted', () => {
    const c = candidate({ sources: ['uniswap', 'coingecko'] })
    const { tokens } = assembleCatalog(assembleInput({ qualified: [c], guard: new Map([pass(WETH)]) }))
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ address: WETH, verified: true, sources: ['uniswap', 'coingecko'] })
  })

  it('a NEW candidate with a FATAL guard finding is dropped with a rejection', () => {
    const c = candidate({ sources: ['uniswap', 'coingecko'] })
    const guard = new Map([[WETH.toLowerCase(), { status: 'fatal' as const, detail: 'identity mismatch' }]])
    const { tokens, report } = assembleCatalog(assembleInput({ qualified: [c], guard }))
    expect(tokens).toHaveLength(0)
    expect(report.rejections[0].reason).toBe('guard-fatal')
  })

  it('a NEW candidate the guard could not verify (RPC null) is NOT added', () => {
    const c = candidate({ sources: ['uniswap', 'coingecko'] })
    const guard = new Map([[WETH.toLowerCase(), { status: 'unverifiable' as const }]])
    const { tokens, report } = assembleCatalog(assembleInput({ qualified: [c], guard }))
    expect(tokens).toHaveLength(0)
    expect(report.rejections[0].reason).toBe('guard-unverifiable')
  })

  it('a SEED with a FATAL guard finding stays included with verified:false and is flagged', () => {
    const c = candidate({ address: WBTC, symbol: 'WBTC', sources: ['uniswap', 'coingecko'] })
    const seed: SeedToken = { address: WBTC, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, category: 'Wrapped BTC' }
    const guard = new Map([[WBTC.toLowerCase(), { status: 'fatal' as const, detail: 'trusted-list miss' }]])
    const { tokens, report } = assembleCatalog(
      assembleInput({ qualified: [c], guard, seeds: new Map([[WBTC.toLowerCase(), seed]]) }),
    )
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ address: WBTC, verified: false })
    expect(report.unverifiedSeeds[0]).toMatchObject({ symbol: 'WBTC', reason: 'guard-fatal' })
  })

  it('a SEED failing cross-verification stays included with verified:false and is flagged', () => {
    const seed: SeedToken = { address: WBTC, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, category: 'Wrapped BTC' }
    const { tokens, report } = assembleCatalog(
      assembleInput({ seeds: new Map([[WBTC.toLowerCase(), seed]]) }),
    )
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ address: WBTC, verified: false })
    expect(report.unverifiedSeeds).toHaveLength(1)
    expect(report.unverifiedSeeds[0].symbol).toBe('WBTC')
  })

  it('a NEW token colliding with a preserved SEED symbol is dropped (guard duplicate-symbol stays green)', () => {
    const seed: SeedToken = { address: WBTC, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8 }
    const impostor = candidate({ address: DAI, symbol: 'WBTC', sources: ['uniswap', 'coingecko'] })
    const { tokens, report } = assembleCatalog(
      assembleInput({
        qualified: [impostor],
        guard: new Map([pass(DAI)]),
        seeds: new Map([[WBTC.toLowerCase(), seed]]),
      }),
    )
    expect(tokens.map((t) => t.address)).toEqual([WBTC])
    expect(report.rejections.some((r) => r.reason === 'symbol-conflict' && r.address === DAI)).toBe(true)
  })

  it('the new-token cap keeps highest-volume tokens and LOGS the overflow', () => {
    const cfg = { ...CFG, maxNewTokensPerChain: { 1: 1 } }
    const big = candidate({ address: WETH, symbol: 'AAA', sources: ['uniswap', 'coingecko'] })
    const small = candidate({ address: DAI, symbol: 'BBB', sources: ['uniswap', 'coingecko'] })
    const guard = new Map([pass(WETH), pass(DAI)])
    const market = new Map<string, MarketSignal>([
      [WETH.toLowerCase(), { volume24hUsd: 9_000_000 }],
      [DAI.toLowerCase(), { volume24hUsd: 200_000 }],
    ])
    const { tokens, report } = assembleCatalog(
      assembleInput({ qualified: [small, big], guard, market, config: cfg }),
    )
    expect(tokens.map((t) => t.symbol)).toEqual(['AAA'])
    expect(report.capped).toEqual([{ address: DAI, symbol: 'BBB' }])
  })

  it('output is deterministically sorted (lowercase symbol, then address) and native ETH first', () => {
    const cores = [CORE_TOKENS[1][0]] // native ETH only
    const a = candidate({ address: DAI, symbol: 'DAI', sources: ['uniswap', 'coingecko'] })
    const b = candidate({ address: WETH, symbol: 'WETH', sources: ['uniswap', 'coingecko'] })
    const { tokens } = assembleCatalog(
      assembleInput({ qualified: [b, a], cores, guard: new Map([pass(DAI), pass(WETH)]) }),
    )
    expect(tokens.map((t) => t.symbol)).toEqual(['ETH', 'DAI', 'WETH'])
    expect(tokens[0].address).toBe(NATIVE_ETH_SENTINEL)
  })
})
