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

  // [FIX-MAINNET-FEED-REMEDIATION] Supersedes the ADR-018-era test that pinned all 7 defective
  // entries as "X / USD" @8dp so they would fail closed. Six are now remediated, so their declared
  // identity is the one the address GENUINELY self-reports on-chain (verified 2026-07-29 on two
  // independent RPCs). Every value below is a READ value, not a convention-derived guess — which is
  // the whole point of ADR-018 invariant (b).
  it('remediated mainnet feeds declare the identity their address actually self-reports on-chain', () => {
    // Composed BASE legs — same addresses as before, ETH-denominated at 18dp (never USD).
    expect(getFeedExpectation('0x17D054ECAC33D91F7340645341eFB5DE9009F1C1')).toEqual({ description: 'GRT / ETH', decimals: 18 })
    expect(getFeedExpectation('0x4e844125952D32AcdF339BE976c98E22F6F318dB')).toEqual({ description: 'LDO / ETH', decimals: 18 })
    expect(getFeedExpectation('0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61')).toEqual({ description: 'SHIB / ETH', decimals: 18 })
    // WBTC composition: a NEW WBTC/BTC base leg × the BTC index feed, now honestly labelled.
    expect(getFeedExpectation('0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23')).toEqual({ description: 'WBTC / BTC', decimals: 8 })
    expect(getFeedExpectation('0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c')).toEqual({ description: 'BTC / USD', decimals: 8 })
    // Corrected DIRECT feeds.
    expect(getFeedExpectation('0xD10aBbC76679a20055E167BB80A24ac851b37056')).toEqual({ description: 'APE / USD', decimals: 8 })
    expect(getFeedExpectation('0x9944D86CEB9160aF5C5feB251FD671923323f8C3')).toEqual({ description: 'PAXG / USD', decimals: 8 })
  })

  it('the dead pre-remediation addresses are GONE from the registry entirely (cannot be resurrected silently)', () => {
    // APE …b37571 (hex drift, zero code) and PAXG 0x9B97304E… (retired proxy, aggregator()==0) were
    // replaced, not merely relabelled. An address with no expectation fails closed at read time, so
    // even if one crept back into a feed map it could never be priced.
    expect(getFeedExpectation('0xD10aBbC76679a20055E167BB80A24ac851b37571')).toBeNull()
    expect(getFeedExpectation('0x9B97304EA12EFed0FAd976FBeCAad46016bf269e')).toBeNull()
  })

  it('PEPE stays UNRESOLVED and therefore still fails closed (no Chainlink PEPE feed exists on mainnet)', () => {
    // Chainlink publishes no PEPE feed of any denomination on mainnet, so there is nothing correct
    // to point this at. The expectation is what a real PEPE/USD feed would report; the configured
    // address has zero on-chain code and can never match it. Blocking is the intended end state.
    expect(getFeedExpectation('0x02DE28aB3C28A5B1E8236B1069a211b7494F0f35')).toEqual({ description: 'PEPE / USD', decimals: 8 })
  })

  // [FIX-MAINNET-FEED-REMEDIATION] The six remediated feeds publish at a 86400s heartbeat, far
  // beyond the 3600s mainnet global. Without an explicit heartbeat they would be judged stale
  // essentially always (observed ages when verified: WBTC/BTC 22.6h, GRT/ETH 17.4h, APE/USD 10.5h),
  // silently reducing the remediation to "still returns null". This pins the fix.
  it('every remediated long-tail mainnet feed has a heartbeat entry (else it reads permanently stale)', () => {
    for (const feed of [
      '0x17D054ECAC33D91F7340645341eFB5DE9009F1C1', // GRT/ETH
      '0x4e844125952D32AcdF339BE976c98E22F6F318dB', // LDO/ETH
      '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61', // SHIB/ETH
      '0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23', // WBTC/BTC
      '0xD10aBbC76679a20055E167BB80A24ac851b37056', // APE/USD
      '0x9944D86CEB9160aF5C5feB251FD671923323f8C3', // PAXG/USD
    ]) {
      expect(getFeedHeartbeatSec(feed), feed).toBe(86400)
      // heartbeat x1.5 = 36h ceiling, comfortably above the observed ~23h worst case.
      expect(getFeedStalenessSec(feed, 3600), feed).toBe(129600)
    }
    // The fast-updating quote legs stay on the global (unchanged, still correct at 1h).
    expect(getFeedHeartbeatSec(CHAINLINK_ETH_USD)).toBeNull()
    expect(getFeedHeartbeatSec('0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c')).toBeNull()
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

  // [FIX-MAINNET-FEED-REMEDIATION] The four remediated mainnet tokens must resolve as COMPOSED —
  // if any of them were left in the direct map, resolveFeed would return it as 'single' and the
  // composed entry would be dead config that never runs.
  it('the four remediated mainnet tokens resolve to kind:"composed" with both legs self-identifying', () => {
    const CASES = [
      { token: '0xc944e90c64b2c07662a292be6244bdf05cda44a7', base: 'GRT / ETH', baseDec: 18, quote: 'ETH / USD' },
      { token: '0x5a98fcbea516cf06857215779fd812ca3bef1b32', base: 'LDO / ETH', baseDec: 18, quote: 'ETH / USD' },
      { token: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', base: 'SHIB / ETH', baseDec: 18, quote: 'ETH / USD' },
      { token: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', base: 'WBTC / BTC', baseDec: 8, quote: 'BTC / USD' },
    ]
    for (const c of CASES) {
      // Must NOT be resolvable as a direct feed any more — that is what routes it to composition.
      expect(getChainlinkFeed(c.token, 1), c.base).toBeNull()
      const r = resolveFeed(c.token, 1)
      expect(r, c.base).not.toBeNull()
      expect(r!.kind, c.base).toBe('composed')
      if (r!.kind === 'composed') {
        expect(r!.base.expectedDescription).toBe(c.base)
        expect(r!.base.expectedDecimals).toBe(c.baseDec)
        expect(r!.quote.expectedDescription).toBe(c.quote)
        expect(r!.quote.expectedDecimals).toBe(8)
      }
    }
  })

  it('WBTC composes through BTC, not ETH — the peg itself is an input, so a WBTC depeg is visible', () => {
    const r = resolveFeed('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 1)!
    expect(r.kind).toBe('composed')
    if (r.kind === 'composed') {
      // The quote leg is the BTC index feed that WBTC/USD used to point at directly. Pricing
      // WBTC as (WBTC/BTC x BTC/USD) rather than as BTC/USD is the entire remediation for WBTC.
      expect(r.quote.address.toLowerCase()).toBe('0xf4030086522a5beea4988f8ca5b36dbc97bee88c')
      expect(r.base.expectedDescription).toBe('WBTC / BTC')
      expect(r.quote.expectedDescription).not.toBe('WBTC / USD')
    }
  })

  it('APE and PAXG resolve to kind:"single" on their CORRECTED addresses', () => {
    const ape = resolveFeed('0x4d224452801aced8b2f0aebe155379bb5d594381', 1)!
    expect(ape.kind).toBe('single')
    if (ape.kind === 'single') {
      expect(ape.leg.address.toLowerCase()).toBe('0xd10abbc76679a20055e167bb80a24ac851b37056')
      expect(ape.leg.expectedDescription).toBe('APE / USD')
    }
    const paxg = resolveFeed('0x45804880de22913dafe09f4980848ece6ecbaf78', 1)!
    expect(paxg.kind).toBe('single')
    if (paxg.kind === 'single') {
      expect(paxg.leg.address.toLowerCase()).toBe('0x9944d86ceb9160af5c5feb251fd671923323f8c3')
      expect(paxg.leg.expectedDescription).toBe('PAXG / USD')
    }
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
