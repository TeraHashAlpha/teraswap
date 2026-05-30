/**
 * [P224] Per-chain token catalog (P221).
 */
import { describe, it, expect } from 'vitest'
import { getPopularTokens, getChainToken, getChainTokenList, CHAIN_TOKENS } from './tokens'
import { DEFAULT_TOKENS } from '@/lib/tokens'

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
