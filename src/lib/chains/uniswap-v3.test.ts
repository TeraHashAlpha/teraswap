/**
 * [SPRINT-46-ARBITRUM-CONFIG] Per-chain Uniswap V3 core contracts — mainnet/Base regression
 * + the Arbitrum (42161) registration.
 * [SPRINT-47-ARBITRUM-ACTIVATION-PREP] The Sprint-46 Arbitrum values all resolved to EMPTY
 * on-chain code (quoterV2, factory) or the wrong contract (swapRouter02 was the V1 SwapRouter,
 * not SwapRouter02) — see docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md. Corrected here to the
 * same addresses as mainnet (on-chain confirmed deployed on Arbitrum).
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

  it('[SPRINT-47-ARBITRUM-ACTIVATION-PREP] Arbitrum (42161) resolves the CORRECTED addresses — same as mainnet, on-chain confirmed', () => {
    const c = getUniswapV3Contracts(42161)!
    expect(c.quoterV2).toBe(UNISWAP_QUOTER_V2)
    expect(c.factory).toBe('0x1F98431c8aD98523631AE4a59f267346ea31F984')
    expect(c.swapRouter02).toBe(UNISWAP_SWAP_ROUTER_02)
    // The corrected swapRouter02 must NOT be the V1 SwapRouter (the resolved discrepancy).
    expect(c.swapRouter02).not.toBe('0xE592427A0AEce92De3Edee1F18E0157C05861564')
  })

  it('returns null for an unconfigured chain', () => {
    expect(getUniswapV3Contracts(999)).toBeNull()
  })
})
