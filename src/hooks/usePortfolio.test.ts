// @vitest-environment jsdom
/**
 * [P168] usePortfolio — combines on-chain balances with USD prices.
 *
 * The hook is the seam between TokenSelector's balance-reading shape
 * and the new Portfolio tab; every branch worth pinning lives here:
 *
 *   - wallet disconnected → empty tokens, no fetch
 *   - wallet connected → ETH + ERC-20s with prices applied
 *   - zero-balance tokens are filtered out
 *   - sort order: known USD value descending, nulls last by symbol
 *   - DefiLlama failure → priceUsd/valueUsd null, totalValueUsd ignores nulls
 *   - isLoading transitions true → false after prices resolve
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// ─── Wagmi mocks (hoisted) ───────────────────────────────

interface AccountMock {
  address: `0x${string}` | undefined
  isConnected: boolean
  chain: { id: number; name: string }
}
let accountMock: AccountMock = {
  address: '0x1111111111111111111111111111111111111111',
  isConnected: true,
  chain: { id: 1, name: 'mainnet' },
}

interface BalanceMock {
  data: { value: bigint; decimals: number; symbol: string; formatted: string } | undefined
  isLoading: boolean
  isError: boolean
}
let balanceMock: BalanceMock = {
  data: { value: 2n * 10n ** 18n, decimals: 18, symbol: 'ETH', formatted: '2.0' },
  isLoading: false,
  isError: false,
}

interface ReadContractsMock {
  data: Array<{ status: 'success' | 'failure'; result?: bigint }> | undefined
  isLoading: boolean
  isError: boolean
}
let readContractsMock: ReadContractsMock = {
  data: undefined,
  isLoading: false,
  isError: false,
}

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => accountMock),
  useBalance: vi.fn(() => balanceMock),
  useReadContracts: vi.fn(() => readContractsMock),
}))

// ─── Tokens fixture ──────────────────────────────────────
// usePortfolio iterates DEFAULT_TOKENS in array order to map balances
// onto erc20Results positions. We pin a tiny known set here so the
// assertions don't depend on the production token list.

vi.mock('@/lib/tokens', async () => {
  const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
  const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const WBTC_ADDR = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
  const TOKENS = [
    { address: NATIVE_ETH, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: 'eth.png', category: 'Native' as const },
    { address: USDC_ADDR, symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: 'usdc.png', category: 'Stablecoin' as const },
    { address: WBTC_ADDR, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, logoURI: 'wbtc.png', category: 'Wrapped BTC' as const },
  ]
  return {
    DEFAULT_TOKENS: TOKENS,
    isNativeETH: (t: { address: string }) => t.address.toLowerCase() === NATIVE_ETH.toLowerCase(),
    CATEGORY_DISPLAY_ORDER: ['Native', 'Stablecoin', 'Wrapped BTC'],
  }
})

vi.mock('@/lib/constants', () => ({ CHAIN_ID: 1 }))

// ─── Module under test ───────────────────────────────────

import { usePortfolio } from './usePortfolio'

// ─── Helpers ─────────────────────────────────────────────

const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'.toLowerCase()
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase()
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'.toLowerCase()

const fetchMock = vi.fn()

beforeEach(() => {
  accountMock = {
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
    chain: { id: 1, name: 'mainnet' },
  }
  balanceMock = {
    data: { value: 2n * 10n ** 18n, decimals: 18, symbol: 'ETH', formatted: '2.0' },
    isLoading: false,
    isError: false,
  }
  readContractsMock = {
    data: [
      { status: 'success', result: 1_000_000n * 10n ** 6n }, // 1_000_000 USDC
      { status: 'success', result: 0n },                       // 0 WBTC → filtered out
    ],
    isLoading: false,
    isError: false,
  }
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      prices: { [NATIVE_ETH]: 3000, [USDC]: 1 },
    }),
  })
  // Replace the global fetch used by usePortfolio for /api/portfolio/prices.
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('usePortfolio', () => {
  it('returns no tokens when the wallet is disconnected', async () => {
    accountMock = { address: undefined, isConnected: false, chain: { id: 1, name: 'mainnet' } }
    balanceMock = { data: undefined, isLoading: false, isError: false }
    readContractsMock = { data: undefined, isLoading: false, isError: false }

    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.tokens).toEqual([])
    expect(result.current.totalValueUsd).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns held tokens with USD prices applied', async () => {
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.tokens.length).toBeGreaterThan(0))
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())

    const symbols = result.current.tokens.map((t) => t.token.symbol)
    expect(symbols).toContain('ETH')
    expect(symbols).toContain('USDC')
    const eth = result.current.tokens.find((t) => t.token.symbol === 'ETH')!
    expect(eth.priceUsd).toBe(3000)
    expect(eth.valueUsd).toBeCloseTo(6000, 5) // 2 ETH × $3000
  })

  it('filters out zero-balance tokens', async () => {
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.tokens.length).toBeGreaterThan(0))
    expect(result.current.tokens.find((t) => t.token.symbol === 'WBTC')).toBeUndefined()
  })

  it('sorts known USD value descending; tokens without a price drop to the bottom', async () => {
    // Give USDC a price but not ETH, so ETH falls to the bottom by symbol.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices: { [USDC]: 1 } }),
    })
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())

    const order = result.current.tokens.map((t) => t.token.symbol)
    expect(order[0]).toBe('USDC')
    expect(order[order.length - 1]).toBe('ETH')
    const eth = result.current.tokens.find((t) => t.token.symbol === 'ETH')!
    expect(eth.priceUsd).toBeNull()
    expect(eth.valueUsd).toBeNull()
  })

  it('handles DefiLlama API failure gracefully (all prices null)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.isError).toBe(true))
    // Tokens still come back because balances are independent of pricing.
    expect(result.current.tokens.length).toBeGreaterThan(0)
    for (const t of result.current.tokens) {
      expect(t.priceUsd).toBeNull()
      expect(t.valueUsd).toBeNull()
    }
    expect(result.current.totalValueUsd).toBeNull()
  })

  it('sums only non-null valueUsd into totalValueUsd', async () => {
    // ETH priced, USDC not priced — total should be 2 × 3000 only.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prices: { [NATIVE_ETH]: 3000 } }),
    })
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())
    expect(result.current.totalValueUsd).toBeCloseTo(6000, 5)
    const usdc = result.current.tokens.find((t) => t.token.symbol === 'USDC')!
    expect(usdc.valueUsd).toBeNull()
  })

  it('starts isLoading=true then settles to false once prices resolve', async () => {
    const { result } = renderHook(() => usePortfolio())
    // First render emits pricesLoading=true while the effect runs.
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.lastUpdated).toBeInstanceOf(Date)
  })
})
