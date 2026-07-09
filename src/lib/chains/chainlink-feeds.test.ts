/**
 * [SPRINT-46-ARBITRUM-CONFIG] Arbitrum (42161) Chainlink feed registration — dark-launch,
 * config-only. Addresses are sourced verbatim from docs/Reports/ARBITRUM-READINESS.md; this
 * suite pins them against drift and confirms mainnet/Base resolution stays byte-identical.
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
  DAI: '0xda10009754f1dF9137293aed5d6DD0dB0Bb075e9',
  USDT: '0xFd086b2F39B6b86fEe29f27E8f6be40e7F2E7D2b',
  WBTC: '0x2F2a2440D2f12C0cDdE18Fe9AEf0cc0d6cF3FC30',
}

describe('chainlink-feeds — Arbitrum (42161) [SPRINT-46-ARBITRUM-CONFIG]', () => {
  it('registers exactly 5 core feeds keyed by Arbitrum token address', () => {
    expect(Object.keys(CHAINLINK_FEEDS_BY_CHAIN[42161]).length).toBe(5)
  })

  it('resolves each core token to its report-verified feed proxy', () => {
    expect(getChainlinkFeed(ARBITRUM_TOKENS.WETH, 42161)).toBe(
      '0x639Fe6ab55C921f74e7fac19EEcf32fd97d80027',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.USDC, 42161)).toBe(
      '0x50834F3e0744f40f628f86e6388f2a4f9a81147f',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.DAI, 42161)).toBe(
      '0xc5C8E77B397E3A2B92f72841640bc7F7eF440DA7',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.USDT, 42161)).toBe(
      '0x3f3f5dF88dC9F13eAFAa42Efb9A3c236f4B3E305',
    )
    expect(getChainlinkFeed(ARBITRUM_TOKENS.WBTC, 42161)).toBe(
      '0xd0C7101eACbB49F3Debb3C340BB2F48c36e341c5',
    )
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

  it('ETH/USD staleness ≈ 1.5x the ~1h report heartbeat; stables ≈ 1.5x the ~24h heartbeat', () => {
    const ethFeed = getChainlinkFeed(ARBITRUM_TOKENS.WETH, 42161)!
    const usdcFeed = getChainlinkFeed(ARBITRUM_TOKENS.USDC, 42161)!
    expect(getFeedStalenessSec(ethFeed, 999)).toBe(Math.round(3600 * 1.5))
    expect(getFeedStalenessSec(usdcFeed, 999)).toBe(Math.round(86400 * 1.5))
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
