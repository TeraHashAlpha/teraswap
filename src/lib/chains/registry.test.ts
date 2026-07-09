/**
 * [P220] ChainConfig registry resolution (P216).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getChainConfig, getSupportedChainIds, getWrappedNative, DEFAULT_CHAIN_ID } from './registry'

describe('chains/registry [P216]', () => {
  it('returns the Ethereum mainnet config for chainId 1', () => {
    const c = getChainConfig(1)
    expect(c.chainId).toBe(1)
    expect(c.slug).toBe('ethereum')
    expect(c.gasModel).toBe('eip1559')
    expect(c.nativeCurrency.symbol).toBe('ETH')
    expect(c.contracts.feeCollector).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(c.contracts.permit2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
    // Mainnet is an L1 — no sequencer feed.
    expect(c.sequencerUptimeFeed).toBeUndefined()
  })

  it('returns the Base config for chainId 8453 with feeCollector null when the env var is unset', () => {
    const c = getChainConfig(8453)
    expect(c.chainId).toBe(8453)
    expect(c.slug).toBe('base')
    expect(c.gasModel).toBe('op-stack')
    // [Sprint 45] env-driven: null (→ "Coming Soon") until NEXT_PUBLIC_BASE_FEE_COLLECTOR is set.
    expect(c.contracts.feeCollector).toBeNull()
    expect(c.sequencerUptimeFeed).toBe('0xBCF85224fc0756B9Fa45aA7892530B47e10b6433')
    expect(c.nativeCurrency.wrappedAddress).toBe('0x4200000000000000000000000000000000000006')
  })

  it('throws on an unsupported chain', () => {
    expect(() => getChainConfig(99999)).toThrow(/unsupported chain/i)
  })

  it('getSupportedChainIds includes 1 and 8453; DEFAULT_CHAIN_ID is mainnet', () => {
    const ids = getSupportedChainIds()
    expect(ids).toContain(1)
    expect(ids).toContain(8453)
    expect(DEFAULT_CHAIN_ID).toBe(1)
  })
})

describe('chains/registry — Arbitrum One (42161) [SPRINT-46-ARBITRUM-CONFIG, dark launch]', () => {
  it('is registered with feeCollector HARD-null (no env override, unlike Base)', () => {
    const c = getChainConfig(42161)
    expect(c.chainId).toBe(42161)
    expect(c.slug).toBe('arbitrum')
    expect(c.gasModel).toBe('arbitrum')
    expect(c.contracts.feeCollector).toBeNull()
  })

  it('shares the canonical CREATE2 Permit2 + CoW VaultRelayer addresses', () => {
    const c = getChainConfig(42161)
    expect(c.contracts.permit2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
    expect(c.contracts.cowVaultRelayer).toBe('0xC92E8bdf79f0507f65a392b0ab4667716BFE0110')
  })

  it('has a report-verified sequencer uptime feed (L2, like Base)', () => {
    expect(getChainConfig(42161).sequencerUptimeFeed).toBe(
      '0xFdB631f5eE196f5C5AA41F952B0282f59B2Eff9E',
    )
  })

  it('token set is native-USDC-only — no USDC.e', () => {
    const { tokens } = getChainConfig(42161)
    expect(tokens.USDC).toBe('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
    expect(Object.values(tokens)).not.toContain('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5F86') // USDC.e
  })

  it('getSupportedChainIds includes 42161', () => {
    expect(getSupportedChainIds()).toContain(42161)
  })
})

describe('getWrappedNative — chain-aware wrapped-native [SPRINT-9W]', () => {
  const MAINNET_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  const BASE_WETH = '0x4200000000000000000000000000000000000006'

  it('mainnet → mainnet WETH (byte-identical; default chain is mainnet)', () => {
    expect(getWrappedNative(1)).toBe(MAINNET_WETH)
    expect(getWrappedNative()).toBe(MAINNET_WETH)
  })

  it('Base → Base WETH 0x4200…0006 (single source of truth = the registry config)', () => {
    expect(getWrappedNative(8453)).toBe(BASE_WETH)
    expect(getWrappedNative(8453)).toBe(getChainConfig(8453).nativeCurrency.wrappedAddress)
  })

  it('unsupported chain → safe fallback to mainnet WETH, never throws', () => {
    expect(() => getWrappedNative(99999)).not.toThrow()
    expect(getWrappedNative(99999)).toBe(MAINNET_WETH)
  })
})

describe('chains/registry — Base env-driven FeeCollector [Sprint 45]', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('resolves Base feeCollector from NEXT_PUBLIC_BASE_FEE_COLLECTOR when set', async () => {
    // The registry reads the env var at module-load time, so re-import fresh.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_BASE_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')
    const { getChainConfig: freshGetChainConfig } = await import('./registry')
    expect(freshGetChainConfig(8453).contracts.feeCollector).toBe(
      '0x000000000000000000000000000000000000dEaD',
    )
  })

  it('falls back to null (not any hardcoded address) when the env var is unset', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_BASE_FEE_COLLECTOR', '')
    const { getChainConfig: freshGetChainConfig } = await import('./registry')
    expect(freshGetChainConfig(8453).contracts.feeCollector).toBeNull()
  })
})
