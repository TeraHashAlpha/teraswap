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
  // URL-aware mock. The hook now hits two endpoints: discovery first
  // (/api/portfolio/tokens) and prices second (/api/portfolio/prices).
  // The base mock returns 503 for discovery so the existing test cases
  // exercise the multicall fallback path (Sprint 31 behaviour). Tests
  // that want to exercise the Alchemy path override the discovery
  // response per-case.
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/portfolio/tokens')) {
      return Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({ error: 'unavailable' }),
      })
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({
        prices: { [NATIVE_ETH]: 3000, [USDC]: 1 },
      }),
    })
  })
  // Replace the global fetch used by usePortfolio.
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
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/portfolio/tokens')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ prices: { [USDC]: 1 } }),
      })
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
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/portfolio/tokens')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) })
    })
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
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/portfolio/tokens')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ prices: { [NATIVE_ETH]: 3000 } }),
      })
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

  // ── [P182] Alchemy discovery path ────────────────────────
  //
  // These tests flip the discovery endpoint to a 200 OK response. When
  // discovery is "available", the hook should:
  //   - source held tokens from /api/portfolio/tokens
  //   - keep DEFAULT_TOKENS metadata for curated addresses (better logos)
  //   - assign category 'Other' to non-default discoveries
  //   - NOT fire the wagmi multicall (the existing wagmi mocks must not be
  //     consulted in a way that produces results)

  const UNK = '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef'

  function discoveryAvailable(tokens: Array<{
    address: string
    symbol: string
    name: string
    decimals: number
    logoURI: string | null
    balance: string
    isDefault: boolean
  }>, prices: Record<string, number>) {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/portfolio/tokens')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tokens }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ prices }) })
    })
  }

  it('Alchemy available: discovered tokens appear in output', async () => {
    discoveryAvailable(
      [
        {
          address: USDC,
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: 6,
          logoURI: 'usdc.png',
          balance: String(2000n * 10n ** 6n),
          isDefault: true,
        },
        {
          address: UNK.toLowerCase(),
          symbol: 'UNK',
          name: 'Unknown Coin',
          decimals: 18,
          logoURI: null,
          balance: String(10n * 10n ** 18n),
          isDefault: false,
        },
      ],
      { [USDC]: 1, [UNK.toLowerCase()]: 0.5 },
    )
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())
    const symbols = result.current.tokens.map((t) => t.token.symbol)
    expect(symbols).toContain('USDC')
    expect(symbols).toContain('UNK')
  })

  it('Alchemy available: DEFAULT tokens use curated metadata, not Alchemy metadata', async () => {
    discoveryAvailable(
      [
        {
          address: USDC,
          // Deliberately wrong metadata to prove curated overrides win.
          symbol: 'WRONG_USDC',
          name: 'Wrong Name',
          decimals: 99,
          logoURI: 'fake.png',
          balance: String(2000n * 10n ** 6n),
          isDefault: true,
        },
      ],
      { [USDC]: 1 },
    )
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.tokens.length).toBeGreaterThan(0))
    const usdc = result.current.tokens.find((t) => t.token.address.toLowerCase() === USDC)!
    // The curated DEFAULT_TOKENS entry — mocked above as { symbol: 'USDC',
    // decimals: 6 } — must win over what Alchemy returned.
    expect(usdc.token.symbol).toBe('USDC')
    expect(usdc.token.decimals).toBe(6)
  })

  it("Alchemy available: non-default tokens are assigned category 'Other'", async () => {
    discoveryAvailable(
      [
        {
          address: UNK.toLowerCase(),
          symbol: 'UNK',
          name: 'Unk',
          decimals: 18,
          logoURI: null,
          balance: String(1n * 10n ** 18n),
          isDefault: false,
        },
      ],
      {},
    )
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.tokens.length).toBeGreaterThan(0))
    const unk = result.current.tokens.find((t) => t.token.symbol === 'UNK')!
    expect(unk.token.category).toBe('Other')
  })

  it('Alchemy 503: falls back to the multicall path (Sprint 31 behaviour)', async () => {
    // Default beforeEach mock already returns 503 for /tokens. We assert
    // that the multicall fixture (2 ETH + 1M USDC) is what surfaces.
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())
    const eth = result.current.tokens.find((t) => t.token.symbol === 'ETH')
    const usdc = result.current.tokens.find((t) => t.token.symbol === 'USDC')
    expect(eth).toBeDefined()
    expect(usdc).toBeDefined()
  })

  it('Alchemy available: multicall (useReadContracts) is not consulted', async () => {
    discoveryAvailable(
      [
        {
          address: USDC,
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: 6,
          logoURI: 'usdc.png',
          balance: String(1n * 10n ** 6n),
          isDefault: true,
        },
      ],
      { [USDC]: 1 },
    )
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())
    // After P195 the Alchemy path also reads native ETH via useBalance(),
    // so ETH appears alongside the discovered USDC. The load-bearing
    // assertion is that the ERC-20 multicall (useReadContracts) is NOT
    // consulted — the USDC balance must be the discovery value (1 unit),
    // NOT the multicall fixture (1_000_000 units).
    const usdc = result.current.tokens.find((t) => t.token.symbol === 'USDC')!
    expect(usdc.balance).toBe(1n * 10n ** 6n)
    expect(result.current.tokens.find((t) => t.token.symbol === 'WBTC')).toBeUndefined()
  })

  it('Alchemy available: discovered token addresses are included in the price fetch', async () => {
    discoveryAvailable(
      [
        {
          address: UNK.toLowerCase(),
          symbol: 'UNK',
          name: 'Unk',
          decimals: 18,
          logoURI: null,
          balance: String(1n * 10n ** 18n),
          isDefault: false,
        },
      ],
      { [UNK.toLowerCase()]: 3 },
    )
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())
    // The non-default discovered address must have been passed to the
    // prices endpoint. Look through the fetch call log for a /prices URL
    // containing the address.
    const pricesCalls = fetchMock.mock.calls.filter((args: unknown[]) => {
      const u = args[0]
      return typeof u === 'string' && u.startsWith('/api/portfolio/prices')
    })
    expect(pricesCalls.length).toBeGreaterThan(0)
    // [P195] ETH is prepended on the Alchemy path so the UNK address may
    // land in any of the prices batches; we assert that some call contains
    // it rather than pinning to the first one.
    const concatenated = pricesCalls.map((c: unknown[]) => c[0] as string).join('|')
    expect(concatenated).toContain(UNK.toLowerCase())
  })

  it('Alchemy available: balance string is parsed to bigint correctly', async () => {
    const expectedBalance = 12_345_678_900_000_000n
    discoveryAvailable(
      [
        {
          address: UNK.toLowerCase(),
          symbol: 'UNK',
          name: 'Unk',
          decimals: 18,
          logoURI: null,
          balance: String(expectedBalance),
          isDefault: false,
        },
      ],
      {},
    )
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.tokens.length).toBeGreaterThan(0))
    const unk = result.current.tokens.find((t) => t.token.symbol === 'UNK')!
    expect(unk.balance).toBe(expectedBalance)
  })

  it('Alchemy available: >100 tokens triggers multiple batched price fetches', async () => {
    const many = []
    for (let i = 0; i < 150; i++) {
      const hex = (i + 1).toString(16).padStart(40, '0')
      many.push({
        address: `0x${hex}`,
        symbol: `T${i}`,
        name: `Token ${i}`,
        decimals: 18,
        logoURI: null,
        balance: String(1n * 10n ** 18n),
        isDefault: false,
      })
    }
    discoveryAvailable(many, {})
    const { result } = renderHook(() => usePortfolio())
    await waitFor(() => expect(result.current.lastUpdated).not.toBeNull())
    const pricesCalls = fetchMock.mock.calls.filter((args: unknown[]) => {
      const u = args[0]
      return typeof u === 'string' && u.startsWith('/api/portfolio/prices')
    })
    // 150 + native ETH = 151 addresses → 2+ batches (the post-P195 Alchemy
    // path adds an ETH-arrival re-render that may emit a third batched
    // fetch). The load-bearing assertion is that batching happens at all;
    // a relaxed lower bound keeps the test stable across that re-render.
    expect(pricesCalls.length).toBeGreaterThanOrEqual(2)
  })
})

