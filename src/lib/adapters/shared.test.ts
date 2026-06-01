// @vitest-environment node
/**
 * [SPRINT-9C] getRpcUrlForChain — chain-aware RPC resolver for the on-chain
 * adapters. Mainnet (chainId 1) must equal getRpcUrl() exactly (byte-identical,
 * incl. the /api/rpc privacy proxy in the browser); other chains resolve the
 * chain's configured RPC and must NEVER return the mainnet RPC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { toWeth } from './shared'
import { NATIVE_ETH, WETH_ADDRESS } from '@/lib/constants'

const BASE_WETH = '0x4200000000000000000000000000000000000006'

describe('toWeth — chain-aware wrapped-native [SPRINT-9E]', () => {
  it('mainnet (default / chainId 1) maps native ETH → mainnet WETH (byte-identical)', () => {
    expect(toWeth(NATIVE_ETH).toLowerCase()).toBe(WETH_ADDRESS.toLowerCase())
    expect(toWeth(NATIVE_ETH, 1).toLowerCase()).toBe(WETH_ADDRESS.toLowerCase())
  })
  it('Base (8453) maps native ETH → BASE WETH, not the mainnet WETH', () => {
    expect(toWeth(NATIVE_ETH, 8453).toLowerCase()).toBe(BASE_WETH.toLowerCase())
    expect(toWeth(NATIVE_ETH, 8453).toLowerCase()).not.toBe(WETH_ADDRESS.toLowerCase())
  })
  it('a non-native token passes through unchanged on any chain', () => {
    const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    expect(toWeth(usdc, 8453)).toBe(usdc)
    expect(toWeth(usdc, 1)).toBe(usdc)
  })
})

const ENV = ['RPC_URL', 'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL'] as const
const saved: Record<string, string | undefined> = {}

async function loadShared() {
  vi.resetModules()
  return import('./shared')
}

describe('getRpcUrlForChain [SPRINT-9C]', () => {
  beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k] }
  })

  it('mainnet (chainId 1) returns getRpcUrl() exactly — byte-identical', async () => {
    process.env.RPC_URL = 'https://eth.mainnet.test'
    const { getRpcUrlForChain, getRpcUrl } = await loadShared()
    expect(getRpcUrlForChain(1)).toBe(getRpcUrl())
    expect(getRpcUrlForChain(1)).toBe('https://eth.mainnet.test')
  })

  it('omitted chainId defaults to mainnet', async () => {
    process.env.RPC_URL = 'https://eth.mainnet.test'
    const { getRpcUrlForChain } = await loadShared()
    expect(getRpcUrlForChain()).toBe('https://eth.mainnet.test')
  })

  it('Base (8453) returns the configured Base RPC, never the mainnet RPC', async () => {
    process.env.RPC_URL = 'https://eth.mainnet.test'
    process.env.NEXT_PUBLIC_BASE_RPC_URL = 'https://base.rpc.test'
    const { getRpcUrlForChain } = await loadShared()
    expect(getRpcUrlForChain(8453)).toBe('https://base.rpc.test')
    expect(getRpcUrlForChain(8453)).not.toContain('eth.mainnet.test')
  })

  it('Base (8453) with no env falls back to the registry Base fallback (a Base RPC, not Ethereum mainnet)', async () => {
    const { getRpcUrlForChain } = await loadShared()
    expect(getRpcUrlForChain(8453)).toBe('https://mainnet.base.org')
  })
})
