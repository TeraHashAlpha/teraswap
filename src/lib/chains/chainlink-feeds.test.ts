/**
 * [SPRINT-46-ARBITRUM-CONFIG → CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] Arbitrum (42161)
 * Chainlink feed registration — dark-launch, config-only. AUDIT-ARBITRUM-46-47 HIGH: the
 * original recon addresses (Sprint 46) all had ZERO on-chain code; addresses below are the
 * CORRECTED values from scripts/verify-arbitrum-addresses.mjs
 * (docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json). This suite pins them against drift and
 * confirms mainnet/Base resolution stays byte-identical.
 */
import { describe, it, expect } from 'vitest'
import {
  CHAINLINK_FEEDS_BY_CHAIN,
  getChainlinkFeed,
  getFeedHeartbeatSec,
  getFeedStalenessSec,
  getFeedExpectation,
  getComposedFeed,
  resolveFeed,
  type ResolvedFeed,
} from './chainlink-feeds'
import { CHAINLINK_FEEDS, CHAINLINK_ETH_USD } from '../constants'

const ARBITRUM_TOKENS = {
  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
}

describe('chainlink-feeds — Arbitrum (42161) [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION]', () => {
  it('registers exactly 5 core feeds keyed by Arbitrum token address', () => {
    expect(Object.keys(CHAINLINK_FEEDS_BY_CHAIN[42161]).length).toBe(5)
  })

  it('resolves each core token to its manifest-verified feed proxy (CORRECTED addresses)', () => {
    expect(getChainlinkFeed(ARBITRUM_TOKENS.WETH, 42161)).toBe(
      '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.USDC, 42161)).toBe(
      '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.DAI, 42161)).toBe(
      '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.USDT, 42161)).toBe(
      '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.WBTC, 42161)).toBe(
      '0xd0C7101eACbB49F3deCcCc166d238410D6D46d57',
    )
  })

  // [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] Regression guard: the broken recon-sourced feed
  // addresses must never silently reappear.
  it('never regresses to the broken (zero-code) recon addresses', () => {
    const broken = [
      '0x639Fe6ab55C921f74e7fac19EEcf32fd97d80027', // old ETH/USD
      '0x50834F3e0744f40f628f86e6388f2a4f9a81147f', // old USDC/USD
      '0xc5C8E77B397E3A2B92f72841640bc7F7eF440DA7', // old DAI/USD
      '0x3f3f5dF88dC9F13eAFAa42Efb9A3c236f4B3E305', // old USDT/USD
      '0xd0C7101eACbB49F3Debb3C340BB2F48c36e341c5', // old WBTC/USD
    ]
    const current = Object.values(CHAINLINK_FEEDS_BY_CHAIN[42161]).map((a) => a.toLowerCase())
    for (const b of broken) expect(current).not.toContain(b.toLowerCase())
  })

  it('native ETH sentinel maps through the wrapped-native (WETH) feed on Arbitrum', () => {
    const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
    expect(getChainlinkFeed(NATIVE_ETH, 42161)).toBe(getChainlinkFeed(ARBITRUM_TOKENS.WETH, 42161))
  })

  it('an unmapped token on Arbitrum falls through to null (fail-conservative)', () => {
    expect(getChainlinkFeed('0x0000000000000000000000000000000000dEaD', 42161)).toBeNull()
  })

  it('has a heartbeat entry for every Arbitrum feed (no silent global-fallback drift)', () => {
    for (const feed of Object.values(CHAINLINK_FEEDS_BY_CHAIN[42161])) {
      expect(getFeedHeartbeatSec(feed), feed).not.toBeNull()
    }
  })

  // [CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] Heartbeats are the exact `heartbeat` field from
  // Chainlink's official reference-data directory for each corrected feed's canonical entry —
  // ETH/USD 1755s, USDC/USD 255s, DAI/USD 86400s, USDT/USD 255s, WBTC/USD 86400s.
  it('staleness ≈ 1.5x each feed\'s official heartbeat', () => {
    const ethFeed = getChainlinkFeed(ARBITRUM_TOKENS.WETH, 42161)!
    const usdcFeed = getChainlinkFeed(ARBITRUM_TOKENS.USDC, 42161)!
    const daiFeed = getChainlinkFeed(ARBITRUM_TOKENS.DAI, 42161)!
    const usdtFeed = getChainlinkFeed(ARBITRUM_TOKENS.USDT, 42161)!
    const wbtcFeed = getChainlinkFeed(ARBITRUM_TOKENS.WBTC, 42161)!
    expect(getFeedStalenessSec(ethFeed, 999)).toBe(Math.round(1755 * 1.5))
    expect(getFeedStalenessSec(usdcFeed, 999)).toBe(Math.round(255 * 1.5))
    expect(getFeedStalenessSec(daiFeed, 999)).toBe(Math.round(86400 * 1.5))
    expect(getFeedStalenessSec(usdtFeed, 999)).toBe(Math.round(255 * 1.5))
    expect(getFeedStalenessSec(wbtcFeed, 999)).toBe(Math.round(86400 * 1.5))
  })

  it('mainnet (1) and Base (8453) feed resolution is unaffected (byte-identical)', () => {
    // Mainnet WETH still resolves through the legacy CHAINLINK_ETH_USD path.
    expect(getChainlinkFeed('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 1)).not.toBeNull()
    // Base WETH still resolves through the existing Base map.
    expect(getChainlinkFeed('0x4200000000000000000000000000000000000006', 8453)).toBe(
      '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    )
  })
})

// ─────────────────────────────────────────────────────────────
// [ADR-018] Feed self-identification registry.
// ─────────────────────────────────────────────────────────────
describe('FEED_EXPECTATIONS / getFeedExpectation [ADR-018]', () => {
  it('every address in CHAINLINK_FEEDS (mainnet) + CHAINLINK_ETH_USD has a declared expectation', () => {
    expect(getFeedExpectation(CHAINLINK_ETH_USD)).not.toBeNull()
    for (const [token, feed] of Object.entries(CHAINLINK_FEEDS)) {
      expect(getFeedExpectation(feed), `mainnet ${token} → ${feed}`).not.toBeNull()
    }
  })

  it('every address in CHAINLINK_FEEDS_BY_CHAIN (Base + Arbitrum) has a declared expectation', () => {
    for (const [chainId, feeds] of Object.entries(CHAINLINK_FEEDS_BY_CHAIN)) {
      for (const [token, feed] of Object.entries(feeds)) {
        expect(getFeedExpectation(feed), `chain ${chainId} ${token} → ${feed}`).not.toBeNull()
      }
    }
  })

  it('resolves case-insensitively, same convention as getChainlinkFeed/getFeedHeartbeatSec', () => {
    const lower = getFeedExpectation(CHAINLINK_ETH_USD.toLowerCase())
    const mixed = getFeedExpectation(CHAINLINK_ETH_USD)
    expect(lower).toEqual(mixed)
  })

  it('an address with no declared expectation → null (fail closed, not a thrown error at call time)', () => {
    expect(getFeedExpectation('0x000000000000000000000000000000000000dEaD')).toBeNull()
  })

  // [ADR-018] The 7 mainnet entries a sibling on-chain verification pass found defective. The
  // expectation recorded here is the CORRECT identity for the pair the key claims — deliberately
  // NOT what the current (wrong) address actually returns — so each fails closed against its own
  // bug. This test pins the intent, not a live on-chain read (that's the whole point: it must fail
  // WITHOUT needing a network call).
  it('the 7 known-defective mainnet entries are recorded as their CORRECT pair (Chainlink "X / USD" @ 8dp convention)', () => {
    const WBTC_USD_ADDR = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' // currently the BTC/USD index feed
    const GRT_USD_ADDR = '0x17D054ECAC33D91F7340645341eFB5DE9009F1C1'  // currently GRT/ETH
    const LDO_USD_ADDR = '0x4e844125952D32AcdF339BE976c98E22F6F318dB'  // currently LDO/ETH
    const SHIB_USD_ADDR = '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61' // currently SHIB/ETH
    const APE_USD_ADDR = '0xD10aBbC76679a20055E167BB80A24ac851b37571'  // currently no code
    const PEPE_USD_ADDR = '0x02DE28aB3C28A5B1E8236B1069a211b7494F0f35' // currently no code
    const PAXG_USD_ADDR = '0x9B97304EA12EFed0FAd976FBeCAad46016bf269e' // currently a dead proxy

    expect(getFeedExpectation(WBTC_USD_ADDR)).toEqual({ description: 'WBTC / USD', decimals: 8 })
    expect(getFeedExpectation(GRT_USD_ADDR)).toEqual({ description: 'GRT / USD', decimals: 8 })
    expect(getFeedExpectation(LDO_USD_ADDR)).toEqual({ description: 'LDO / USD', decimals: 8 })
    expect(getFeedExpectation(SHIB_USD_ADDR)).toEqual({ description: 'SHIB / USD', decimals: 8 })
    expect(getFeedExpectation(APE_USD_ADDR)).toEqual({ description: 'APE / USD', decimals: 8 })
    expect(getFeedExpectation(PEPE_USD_ADDR)).toEqual({ description: 'PEPE / USD', decimals: 8 })
    expect(getFeedExpectation(PAXG_USD_ADDR)).toEqual({ description: 'PAXG / USD', decimals: 8 })
  })
})

describe('resolveFeed — [ADR-018] exhaustive single/composed dispatch', () => {
  it('a direct-feed token resolves to kind:"single" with its declared identity attached', () => {
    const resolved = resolveFeed('0x4200000000000000000000000000000000000006', 8453) // Base WETH
    expect(resolved).not.toBeNull()
    expect(resolved!.kind).toBe('single')
    if (resolved!.kind === 'single') {
      expect(resolved!.leg.address.toLowerCase()).toBe('0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70')
      expect(resolved!.leg.expectedDescription).toBe('ETH / USD')
      expect(resolved!.leg.expectedDecimals).toBe(8)
    }
  })

  it('a composed-only token (Base cbETH) resolves to kind:"composed" with BOTH legs\' identities attached', () => {
    const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'
    const composed = getComposedFeed(CBETH, 8453)
    expect(composed).not.toBeNull()

    const resolved = resolveFeed(CBETH, 8453)
    expect(resolved).not.toBeNull()
    expect(resolved!.kind).toBe('composed')
    if (resolved!.kind === 'composed') {
      expect(resolved!.base.address.toLowerCase()).toBe(composed!.base.toLowerCase())
      expect(resolved!.base.expectedDescription).toBe('CBETH / ETH')
      expect(resolved!.base.expectedDecimals).toBe(18)
      expect(resolved!.quote.address.toLowerCase()).toBe(composed!.quote.toLowerCase())
      expect(resolved!.quote.expectedDescription).toBe('ETH / USD')
      expect(resolved!.quote.expectedDecimals).toBe(8)
    }
  })

  it('a token with neither a direct nor composed feed → null', () => {
    expect(resolveFeed('0x000000000000000000000000000000000000dEaD', 1)).toBeNull()
  })

  it('the kind discriminant is exhaustive at compile time — a switch with a never-typed default compiles', () => {
    // This is a compile-time assertion disguised as a runtime one: if ResolvedFeed ever grows a
    // third variant, the `exhaustive: never` assignment below fails to TYPECHECK (not just to run),
    // so `npm run typecheck` catches it before any test does.
    const classify = (r: ResolvedFeed): string => {
      switch (r.kind) {
        case 'single':
          return 'single'
        case 'composed':
          return 'composed'
        default: {
          const exhaustive: never = r
          return exhaustive
        }
      }
    }
    const resolved = resolveFeed('0x4200000000000000000000000000000000000006', 8453)!
    expect(classify(resolved)).toBe('single')
  })
})
