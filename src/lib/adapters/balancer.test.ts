/**
 * [SPRINT-9G G7] Balancer adapter fail-closed router whitelist.
 *
 * fetchSwapData returns the SOR API's `to` as the swap target. It must refuse
 * (throw) unless that target is a whitelisted router on the chain — mirroring
 * the Bebop gate — so a compromised/unexpected SOR response can't direct
 * executable calldata at an arbitrary contract. The legitimate Balancer V2
 * Vault (0xBA12…F2C8) is whitelisted on every supported chain and still passes.
 *
 * Mocking strategy: stub global fetch (the adapter calls it directly) and run
 * the REAL getRouterWhitelist so the whitelist membership check is exercised.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import balancer from './balancer'
import type { SwapParams } from './types'

const VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8' // Balancer V2 Vault (whitelisted)
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const baseParams: SwapParams = {
  src: WETH,
  dst: USDC,
  amount: '1000000000000000000',
  from: '0x1111111111111111111111111111111111111111',
  slippage: 0.5,
} as SwapParams

function mockFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('balancer adapter — fail-closed router whitelist [SPRINT-9G G7]', () => {
  it('returns the swap tx when tx.to is the whitelisted Balancer Vault (mainnet, unchanged)', async () => {
    mockFetch({ buyAmount: '2950000000', to: VAULT, data: '0xabcdef00', value: '0', gasEstimate: 200_000 })
    const quote = await balancer.fetchSwapData!(baseParams)
    expect(quote).not.toBeNull()
    expect(quote!.tx).toBeDefined()
    expect(quote!.tx!.to.toLowerCase()).toBe(VAULT.toLowerCase())
  })

  it('throws (fail-closed) when the SOR target is NOT whitelisted', async () => {
    mockFetch({
      buyAmount: '2950000000',
      to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      data: '0xabcdef00',
      value: '0',
    })
    await expect(balancer.fetchSwapData!(baseParams)).rejects.toThrow(/whitelist|refus/i)
  })
})
