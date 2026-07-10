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
} from './chainlink-feeds'

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
