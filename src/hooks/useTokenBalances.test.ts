// @vitest-environment jsdom
/**
 * [SPRINT-9G G5 / M08] useTokenBalances must be chain-aware: on Base it should
 * fetch balances over the Base RPC (chainId 8453) for the Base token catalog,
 * gated by isChainActive — not the strict mainnet `chain.id === CHAIN_ID` check
 * that left Base balances permanently empty. Mainnet (chainId 1) stays
 * byte-identical (DEFAULT_TOKENS, enabled when connected).
 *
 * Mocking strategy: stub wagmi's useBalance/useReadContracts (capture their
 * options) plus the chain helpers, then renderHook and assert the chainId +
 * enabled flags that drive the reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useBalanceMock = vi.fn<(opts: unknown) => { data?: { value: bigint } | undefined; isLoading?: boolean; isError?: boolean }>(() => ({ data: undefined }))
const useReadContractsMock = vi.fn<(opts: unknown) => { data?: Array<{ status: string; result?: bigint }> | undefined; isLoading?: boolean; isError?: boolean }>(() => ({ data: undefined }))
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useBalance: (opts: unknown) => useBalanceMock(opts),
  useReadContracts: (opts: unknown) => useReadContractsMock(opts),
}))

const useActiveChainIdMock = vi.fn(() => 1)
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => useActiveChainIdMock() }))

const isChainActiveMock = vi.fn<(id: number) => boolean>(() => true)
vi.mock('@/lib/chains', () => ({
  isChainActive: (id: number) => isChainActiveMock(id),
  DEFAULT_CHAIN_ID: 1,
}))

// Address literals are inlined in the factories below (vi.mock is hoisted above
// any module-scope const, so a factory cannot reference one). These mirror them
// for the assertions, which run at test time and may reference module consts.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

vi.mock('@/lib/chains/tokens', () => ({
  getChainTokenList: (id: number) =>
    id === 8453
      ? [{ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 }]
      : [],
}))

vi.mock('@/lib/tokens', () => ({
  DEFAULT_TOKENS: [
    { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'ETH', name: 'Ether', decimals: 18 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
  isNativeETH: (t: { address: string }) =>
    t.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
}))

import { renderHook } from '@testing-library/react'
import { useTokenBalances } from './useTokenBalances'

beforeEach(() => {
  vi.clearAllMocks()
  useBalanceMock.mockReturnValue({ data: undefined })
  useReadContractsMock.mockReturnValue({ data: undefined })
  useActiveChainIdMock.mockReturnValue(1)
  isChainActiveMock.mockReturnValue(true)
  useAccountMock.mockReturnValue({
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
    chain: { id: 1 },
  })
})

describe('useTokenBalances — chain-aware [SPRINT-9G G5]', () => {
  it('fetches Base (8453) balances over the Base chain, gated by isChainActive', () => {
    useAccountMock.mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      isConnected: true,
      chain: { id: 8453 },
    })
    useActiveChainIdMock.mockReturnValue(8453)
    isChainActiveMock.mockReturnValue(true)

    renderHook(() => useTokenBalances())

    const balOpts = useBalanceMock.mock.calls[0][0] as { chainId?: number; query: { enabled: boolean } }
    expect(balOpts.chainId).toBe(8453)
    expect(balOpts.query.enabled).toBe(true)

    const rcOpts = useReadContractsMock.mock.calls[0][0] as {
      contracts: Array<{ address: string; chainId?: number }>
      query: { enabled: boolean }
    }
    expect(rcOpts.query.enabled).toBe(true)
    expect(rcOpts.contracts[0].chainId).toBe(8453)
    expect(rcOpts.contracts[0].address.toLowerCase()).toBe(BASE_USDC.toLowerCase())
  })

  it('mainnet (chainId 1) fetches over mainnet with DEFAULT_TOKENS (byte-identical)', () => {
    renderHook(() => useTokenBalances())

    const balOpts = useBalanceMock.mock.calls[0][0] as { chainId?: number; query: { enabled: boolean } }
    expect(balOpts.chainId).toBe(1)
    expect(balOpts.query.enabled).toBe(true)

    const rcOpts = useReadContractsMock.mock.calls[0][0] as {
      contracts: Array<{ address: string; chainId?: number }>
    }
    // DEFAULT_TOKENS ERC-20 (mainnet USDC), read on mainnet
    expect(rcOpts.contracts[0].chainId).toBe(1)
    expect(rcOpts.contracts[0].address.toLowerCase()).toBe(MAINNET_USDC.toLowerCase())
  })

  it('does not fetch when the active chain is not activated (coming-soon/unsupported)', () => {
    useAccountMock.mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      isConnected: true,
      chain: { id: 8453 },
    })
    useActiveChainIdMock.mockReturnValue(8453)
    isChainActiveMock.mockReturnValue(false)

    renderHook(() => useTokenBalances())

    const balOpts = useBalanceMock.mock.calls[0][0] as { query: { enabled: boolean } }
    expect(balOpts.query.enabled).toBe(false)
  })
})

describe('useTokenBalances — widened API for the portfolio fallback [E-3]', () => {
  it('returns { balances, isLoading, isError } (balances is the address→balance map)', () => {
    useBalanceMock.mockReturnValue({ data: { value: 2n * 10n ** 18n }, isLoading: false, isError: false })
    const { result } = renderHook(() => useTokenBalances())
    expect(result.current.balances).toBeInstanceOf(Map)
    expect(typeof result.current.isLoading).toBe('boolean')
    expect(typeof result.current.isError).toBe('boolean')
  })

  it('enabled=false disables every wagmi read (lets usePortfolio park the multicall while Alchemy works)', () => {
    renderHook(() => useTokenBalances(false))
    const balOpts = useBalanceMock.mock.calls[0][0] as { query: { enabled: boolean } }
    expect(balOpts.query.enabled).toBe(false)
    const rcOpts = useReadContractsMock.mock.calls[0][0] as { query: { enabled: boolean } }
    expect(rcOpts.query.enabled).toBe(false)
  })

  it('surfaces isError from either wagmi read', () => {
    useReadContractsMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    const { result } = renderHook(() => useTokenBalances())
    expect(result.current.isError).toBe(true)
  })
})
