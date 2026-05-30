// @vitest-environment node
/**
 * [P227] buildSimulationTx — per-chain FeeCollector address resolution (P225).
 *
 * getChainConfig is mocked so each case controls the resolved FeeCollector; the
 * mainnet case uses the real FEE_COLLECTOR_ADDRESS value to pin the unchanged
 * behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'
import type { Token } from '@/lib/tokens'
import type { NormalizedQuote } from '@/lib/api'

const mockGetChainConfig = vi.fn<(id: number) => unknown>()
vi.mock('@/lib/chains/registry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains/registry')>('@/lib/chains/registry')
  return { ...actual, getChainConfig: (id: number) => mockGetChainConfig(id) }
})

import { buildSimulationTx } from './swap-simulation'

const WETH: Token = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '', category: 'Native' }
const USDC: Token = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin' }
const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582'

function makeSwapData(): NormalizedQuote {
  return {
    source: '1inch', toAmount: '1000000000', estimatedGas: 200_000, gasUsd: 5, routes: [],
    tx: { to: ROUTER as `0x${string}`, data: '0xabcdef' as `0x${string}`, value: '0', gas: 200_000 },
  }
}

function params(over: Record<string, unknown> = {}) {
  return {
    swapData: makeSwapData(),
    routeViaFeeCollector: true,
    isNativeIn: false,
    tokenIn: WETH,
    tokenOut: USDC,
    rawAmount: 1_000_000_000_000_000_000n,
    slippage: 0.5,
    fromAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    source: '1inch',
    chainId: 1,
    ...over,
  } as Parameters<typeof buildSimulationTx>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: mainnet FeeCollector.
  mockGetChainConfig.mockReturnValue({ contracts: { feeCollector: FEE_COLLECTOR_ADDRESS } })
})

describe('swap-simulation — buildSimulationTx FeeCollector address [P225]', () => {
  it('uses the mainnet FeeCollector for chainId=1', () => {
    const tx = buildSimulationTx(params({ chainId: 1 }))
    expect(tx.to.toLowerCase()).toBe(FEE_COLLECTOR_ADDRESS.toLowerCase())
  })

  it('uses the Base FeeCollector for chainId=8453', () => {
    const BASE_FC = '0x1234567890123456789012345678901234567890'
    mockGetChainConfig.mockReturnValue({ contracts: { feeCollector: BASE_FC } })
    const tx = buildSimulationTx(params({ chainId: 8453 }))
    expect(tx.to.toLowerCase()).toBe(BASE_FC.toLowerCase())
  })

  it('throws when the FeeCollector is null and the route is fee-collected', () => {
    mockGetChainConfig.mockReturnValue({ contracts: { feeCollector: null } })
    expect(() => buildSimulationTx(params({ chainId: 8453 }))).toThrow(/FeeCollector/i)
  })
})
