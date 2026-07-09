/**
 * [SPRINT-46-ARBITRUM-CONFIG] Per-chain Uniswap V3 core contracts — mainnet/Base regression
 * + the new Arbitrum (42161) registration (report-verified addresses, dark launch).
 */
import { describe, it, expect } from 'vitest'
import { getUniswapV3Contracts } from './uniswap-v3'
import { UNISWAP_QUOTER_V2, UNISWAP_SWAP_ROUTER_02 } from '@/lib/constants'

describe('chains/uniswap-v3', () => {
  it('mainnet (1) references the canonical constants byte-identical', () => {
    const c = getUniswapV3Contracts(1)!
    expect(c.quoterV2).toBe(UNISWAP_QUOTER_V2)
    expect(c.swapRouter02).toBe(UNISWAP_SWAP_ROUTER_02)
  })

  it('Base (8453) resolves its own verified addresses', () => {
    const c = getUniswapV3Contracts(8453)!
    expect(c.swapRouter02).toBe('0x2626664c2603336E57B271c5C0b26F421741e481')
  })

  it('[SPRINT-46-ARBITRUM-CONFIG] Arbitrum (42161) resolves report-verified addresses', () => {
    const c = getUniswapV3Contracts(42161)!
    expect(c.quoterV2).toBe('0xb27308F9f90D7314fB6D5dB7159750d37D2c3cEe')
    expect(c.factory).toBe('0x1f98431C8Ad98523631ae4a59F267346ea31564E')
    expect(c.swapRouter02).toBe('0xE592427A0AEce92De3Edee1F18E0157C05861564')
  })

  it('returns null for an unconfigured chain', () => {
    expect(getUniswapV3Contracts(999)).toBeNull()
  })
})
