// @vitest-environment jsdom
/**
 * [CHORE-DCA-UX-FIXES] useTokenBalance — direct on-chain balance for a SINGLE selected token
 * (curated OR imported), for a given token + chain. Unlike useTokenBalances (curated-catalog
 * multicall), this reads balanceOf for any ERC-20 address, so imported/unverified tokens that
 * are absent from the catalog still show a balance + drive the DCA quick-fill presets.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAccountMock = vi.fn()
const useReadContractMock = vi.fn<(opts: unknown) => { data: unknown; isLoading: boolean; isError: boolean }>()
const useBalanceMock = vi.fn<(opts: unknown) => { data: unknown; isLoading: boolean; isError: boolean }>()

vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useReadContract: (opts: unknown) => useReadContractMock(opts),
  useBalance: (opts: unknown) => useBalanceMock(opts),
}))

import { renderHook } from '@testing-library/react'
import { useTokenBalance } from './useTokenBalance'
import { NATIVE_ETH } from '@/lib/constants'
import type { Token } from '@/lib/tokens'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const ETHFI: Token = {
  address: '0x6c240ca4a1a3d8c4c2c7e6b8d6f6e8a4b4c2a2a2',
  symbol: 'ETHFI',
  name: 'Ether.fi',
  decimals: 18,
  logoURI: '',
  category: 'Imported',
  chainId: 8453,
}
const NATIVE: Token = {
  address: NATIVE_ETH,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useReadContractMock.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  useBalanceMock.mockReturnValue({ data: undefined, isLoading: false, isError: false })
})

describe('useTokenBalance — arbitrary ERC-20 (imported token)', () => {
  it('reads balanceOf for the selected token + chain and reports the raw + formatted balance', () => {
    useReadContractMock.mockReturnValue({ data: 123_000000000000000000n, isLoading: false, isError: false })
    const { result } = renderHook(() => useTokenBalance(ETHFI, 8453))
    expect(result.current.raw).toBe(123_000000000000000000n)
    expect(result.current.hasValue).toBe(true)
    expect(result.current.formatted).toBe('123')
    expect(result.current.isLoading).toBe(false)
  })

  it('queries balanceOf with the token address, the wallet, and the FROZEN chainId', () => {
    renderHook(() => useTokenBalance(ETHFI, 8453))
    const call = useReadContractMock.mock.calls.find(
      c => (c[0] as { functionName?: string })?.functionName === 'balanceOf',
    )!
    const opts = call[0] as { address: string; chainId: number; args: unknown[]; query: { enabled: boolean } }
    expect(opts.address).toBe(ETHFI.address)
    expect(opts.chainId).toBe(8453)
    expect(opts.args).toEqual([ADDRESS])
    expect(opts.query.enabled).toBe(true)
  })

  it('reports hasValue=false (and disables the read) when the wallet is disconnected', () => {
    useAccountMock.mockReturnValue({ address: undefined, isConnected: false })
    const { result } = renderHook(() => useTokenBalance(ETHFI, 8453))
    expect(result.current.hasValue).toBe(false)
    expect(result.current.raw).toBe(0n)
    const call = useReadContractMock.mock.calls.find(
      c => (c[0] as { functionName?: string })?.functionName === 'balanceOf',
    )!
    expect((call[0] as { query: { enabled: boolean } }).query.enabled).toBe(false)
  })

  it('respects the enabled:false option (no fetch even when connected)', () => {
    renderHook(() => useTokenBalance(ETHFI, 8453, { enabled: false }))
    const call = useReadContractMock.mock.calls.find(
      c => (c[0] as { functionName?: string })?.functionName === 'balanceOf',
    )!
    expect((call[0] as { query: { enabled: boolean } }).query.enabled).toBe(false)
  })

  it('surfaces the loading state from the read', () => {
    useReadContractMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    const { result } = renderHook(() => useTokenBalance(ETHFI, 8453))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.hasValue).toBe(false)
  })
})

describe('useTokenBalance — native token', () => {
  it('reads native ETH via useBalance (not balanceOf) for a native token', () => {
    useBalanceMock.mockReturnValue({ data: { value: 500000000000000000n }, isLoading: false, isError: false })
    const { result } = renderHook(() => useTokenBalance(NATIVE, 1))
    expect(result.current.raw).toBe(500000000000000000n)
    expect(result.current.hasValue).toBe(true)
    // The ERC-20 balanceOf read must be DISABLED for a native token.
    const erc20 = useReadContractMock.mock.calls.find(
      c => (c[0] as { functionName?: string })?.functionName === 'balanceOf',
    )!
    expect((erc20[0] as { query: { enabled: boolean } }).query.enabled).toBe(false)
  })
})
