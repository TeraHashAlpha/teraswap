/**
 * [P220] Adapter URL resolution (P217). chainId=1 must equal the legacy URLs.
 */
import { describe, it, expect } from 'vitest'
import { getAdapterApiUrl } from './adapter-urls'
import { getCowApiBase } from '@/lib/constants'

describe('chains/adapter-urls [P217]', () => {
  it('puts the chainId in the 1inch path', () => {
    expect(getAdapterApiUrl('1inch', 1)).toBe('https://api.1inch.dev/swap/v6.0/1')
    expect(getAdapterApiUrl('1inch', 8453)).toBe('https://api.1inch.dev/swap/v6.0/8453')
  })

  it('uses the chain slug in the KyberSwap path', () => {
    expect(getAdapterApiUrl('kyberswap', 1)).toBe('https://aggregator-api.kyberswap.com/ethereum')
    expect(getAdapterApiUrl('kyberswap', 8453)).toBe('https://aggregator-api.kyberswap.com/base')
  })

  it('maps the CoW API base to /base/ for chainId 8453', () => {
    expect(getCowApiBase(8453)).toBe('https://api.cow.fi/base/api/v1')
    expect(getAdapterApiUrl('cowswap', 8453)).toBe('https://api.cow.fi/base/api/v1')
    expect(getAdapterApiUrl('cowswap', 1)).toBe('https://api.cow.fi/mainnet/api/v1')
  })

  it('[SPRINT-46-ARBITRUM-CONFIG] maps the CoW API base to /arbitrum/ for chainId 42161', () => {
    expect(getCowApiBase(42161)).toBe('https://api.cow.fi/arbitrum/api/v1')
    expect(getAdapterApiUrl('cowswap', 42161)).toBe('https://api.cow.fi/arbitrum/api/v1')
  })

  it('[SPRINT-46-ARBITRUM-CONFIG] puts the chainId/slug in the path adapters for 42161', () => {
    expect(getAdapterApiUrl('1inch', 42161)).toBe('https://api.1inch.dev/swap/v6.0/42161')
    expect(getAdapterApiUrl('openocean', 42161)).toBe('https://open-api.openocean.finance/v4/42161')
    expect(getAdapterApiUrl('sushiswap', 42161)).toBe('https://api.sushi.com/swap/v7/42161')
    expect(getAdapterApiUrl('kyberswap', 42161)).toBe('https://aggregator-api.kyberswap.com/arbitrum')
  })

  it('defaults to the mainnet URL when chainId is omitted', () => {
    expect(getAdapterApiUrl('1inch')).toBe('https://api.1inch.dev/swap/v6.0/1')
    expect(getAdapterApiUrl('sushiswap')).toBe('https://api.sushi.com/swap/v7/1')
    expect(getAdapterApiUrl('openocean')).toBe('https://open-api.openocean.finance/v4/1')
  })
})
