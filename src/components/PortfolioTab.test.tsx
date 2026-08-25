// @vitest-environment jsdom
/**
 * [P168] PortfolioTab — render branches.
 *
 * We mock usePortfolio outright (cleanest seam: the hook itself is
 * covered by its own test file). That lets each render branch be
 * exercised by mutating one variable per test, no wagmi plumbing
 * required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Token } from '@/lib/tokens'
import type { PortfolioData, PortfolioToken } from '@/hooks/usePortfolio'

// ─── Wagmi mocks ─────────────────────────────────────────

let isConnected = true
let activeChainId = 1
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: isConnected ? '0x1111111111111111111111111111111111111111' : undefined,
    isConnected,
    chain: { id: activeChainId, name: 'mainnet' },
  })),
}))

// ─── usePortfolio mock ───────────────────────────────────

const refreshSpy = vi.fn()
let portfolioState: PortfolioData = makePortfolio({ tokens: [] })

vi.mock('@/hooks/usePortfolio', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/usePortfolio')>(
    '@/hooks/usePortfolio',
  )
  return {
    ...actual,
    usePortfolio: () => portfolioState,
  }
})

// ─── Module under test ───────────────────────────────────

import PortfolioTab from './PortfolioTab'

// ─── Fixtures / helpers ──────────────────────────────────

function _token(opts: Partial<Token> & Pick<Token, 'symbol' | 'address'>): Token {
  return {
    name: opts.symbol,
    decimals: 18,
    logoURI: `${opts.symbol.toLowerCase()}.png`,
    category: 'Other',
    ...opts,
  } as Token
}

function entry(opts: {
  symbol: string
  name: string
  address: `0x${string}`
  category?: Token['category']
  decimals?: number
  balance: bigint
  balanceFormatted: string
  priceUsd: number | null
  valueUsd: number | null
}): PortfolioToken {
  return {
    token: {
      address: opts.address,
      symbol: opts.symbol,
      name: opts.name,
      decimals: opts.decimals ?? 18,
      logoURI: `${opts.symbol.toLowerCase()}.png`,
      category: opts.category ?? 'Other',
    },
    balance: opts.balance,
    balanceFormatted: opts.balanceFormatted,
    priceUsd: opts.priceUsd,
    valueUsd: opts.valueUsd,
  }
}

function makePortfolio(over: Partial<PortfolioData>): PortfolioData {
  return {
    tokens: [],
    totalValueUsd: null,
    isLoading: false,
    isError: false,
    lastUpdated: new Date(),
    refresh: refreshSpy,
    isChainSupported: true,
    ...over,
  }
}

const ETH = entry({
  symbol: 'ETH',
  name: 'Ether',
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  category: 'Native',
  balance: 2n * 10n ** 18n,
  balanceFormatted: '2',
  priceUsd: 3000,
  valueUsd: 6000,
})
const USDC = entry({
  symbol: 'USDC',
  name: 'USD Coin',
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  category: 'Stablecoin',
  decimals: 6,
  balance: 1500_000000n,
  balanceFormatted: '1.5K',
  priceUsd: 1,
  valueUsd: 1500,
})
const UNI = entry({
  symbol: 'UNI',
  name: 'Uniswap',
  address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  category: 'DeFi',
  balance: 100n * 10n ** 18n,
  balanceFormatted: '100',
  priceUsd: null,
  valueUsd: null,
})

beforeEach(() => {
  isConnected = true
  activeChainId = 1
  refreshSpy.mockReset()
  portfolioState = makePortfolio({ tokens: [] })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('PortfolioTab', () => {
  it('renders the connect-wallet empty state when not connected', () => {
    isConnected = false
    render(<PortfolioTab />)
    expect(
      screen.getByText(/Connect your wallet to view your portfolio/i),
    ).toBeTruthy()
  })

  it('renders the token list with formatted balances when connected', () => {
    portfolioState = makePortfolio({
      tokens: [ETH, USDC],
      totalValueUsd: 7500,
    })
    render(<PortfolioTab />)
    expect(screen.getByText('ETH')).toBeTruthy()
    expect(screen.getByText('USDC')).toBeTruthy()
    // Total formatted as currency
    expect(screen.getByText('$7,500.00')).toBeTruthy()
    expect(screen.getByText('$6,000.00')).toBeTruthy()
    expect(screen.getByText('$1,500.00')).toBeTruthy()
  })

  it('renders skeleton placeholders while loading and no tokens yet', () => {
    portfolioState = makePortfolio({
      tokens: [],
      isLoading: true,
      lastUpdated: null,
    })
    const { container } = render(<PortfolioTab />)
    const skeletons = container.querySelectorAll('.animate-pulse')
    expect(skeletons.length).toBe(4)
  })

  it('renders the error banner with a working retry button', () => {
    portfolioState = makePortfolio({
      tokens: [],
      isError: true,
    })
    render(<PortfolioTab />)
    expect(screen.getByText(/Failed to load portfolio/i)).toBeTruthy()
    const retry = screen.getByRole('button', { name: /try again/i })
    fireEvent.click(retry)
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  // [FIX-CHAIN-SCOPED-FEATURE-MESSAGES] Arbitrum One (42161) is active for swaps but is not in
  // ALCHEMY_BASE_BY_CHAIN, so usePortfolio reports isChainSupported: false. The component must
  // show an availability state naming the chain instead of the generic error/empty states.
  it('shows a chain-availability state naming the selected chain when the chain has no portfolio support', () => {
    activeChainId = 42161
    portfolioState = makePortfolio({ tokens: [], isChainSupported: false })
    render(<PortfolioTab />)
    expect(screen.getByTestId('portfolio-chain-unavailable').textContent).toMatch(/Arbitrum One/i)
    expect(screen.queryByText(/Failed to load portfolio/i)).toBeNull()
    expect(screen.queryByText(/No tokens found/i)).toBeNull()
  })

  it('names the selected (non-mainnet) chain in the empty-state string when the chain IS supported', () => {
    // A hardcoded "Ethereum mainnet" string would fail this: chain 8453 is Base, and it IS in
    // ALCHEMY_BASE_BY_CHAIN, so this exercises the ordinary empty state, not the availability one.
    activeChainId = 8453
    portfolioState = makePortfolio({ tokens: [], isChainSupported: true })
    render(<PortfolioTab />)
    expect(screen.getByText(/No tokens found in this wallet on Base\./i)).toBeTruthy()
    expect(screen.queryByText(/Ethereum mainnet/i)).toBeNull()
  })

  it('calls onSwapToken with the row token when its Swap button is clicked', () => {
    portfolioState = makePortfolio({
      tokens: [ETH, USDC],
      totalValueUsd: 7500,
    })
    const onSwapToken = vi.fn()
    render(<PortfolioTab onSwapToken={onSwapToken} />)
    fireEvent.click(screen.getByRole('button', { name: /Swap ETH/ }))
    expect(onSwapToken).toHaveBeenCalledTimes(1)
    expect(onSwapToken.mock.calls[0][0].symbol).toBe('ETH')
  })

  it('renders an em-dash for tokens with no USD price', () => {
    portfolioState = makePortfolio({
      tokens: [UNI],
      totalValueUsd: null,
    })
    render(<PortfolioTab />)
    // The row's value column shows "—" and the header total likewise.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1)
  })

  it('groups tokens by category with a section header for each', () => {
    portfolioState = makePortfolio({
      tokens: [ETH, USDC, UNI],
      totalValueUsd: 7500,
    })
    render(<PortfolioTab />)
    expect(screen.getByText(/^NATIVE$/i)).toBeTruthy()
    expect(screen.getByText(/^STABLECOIN$/i)).toBeTruthy()
    expect(screen.getByText(/^DEFI$/i)).toBeTruthy()
  })

  // ── [P182] Discovered tokens UI ───────────────────────
  //
  // A "discovered" token in this sense is a PortfolioToken whose address
  // is NOT in the production DEFAULT_TOKENS list. The component splits
  // on that — Set lookup against DEFAULT_TOKENS.address. We use a clearly
  // bogus address (no risk of accidental DEFAULT_TOKENS collision) and
  // assert the section's visual + behavioural contract.

  const DISCOVERED_ADDR = '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef' as `0x${string}`
  const discovered = entry({
    symbol: 'UNK',
    name: 'Unknown Token',
    address: DISCOVERED_ADDR,
    category: 'Other',
    balance: 1n * 10n ** 18n,
    balanceFormatted: '1',
    priceUsd: 0.5,
    valueUsd: 0.5,
  })

  it('renders the "Discovered in Wallet" section header when a non-default token is present', () => {
    portfolioState = makePortfolio({
      tokens: [ETH, discovered],
      totalValueUsd: 6000.5,
    })
    render(<PortfolioTab />)
    expect(screen.getByText(/Discovered in Wallet/i)).toBeTruthy()
  })

  it('renders the truncated 0x… address only for discovered tokens', () => {
    portfolioState = makePortfolio({
      tokens: [ETH, discovered],
      totalValueUsd: 6000.5,
    })
    render(<PortfolioTab />)
    // 0xDeadBe…BeEf — first 6 + last 4 chars per shortenAddress().
    expect(
      screen.getByText(`${DISCOVERED_ADDR.slice(0, 6)}…${DISCOVERED_ADDR.slice(-4)}`),
    ).toBeTruthy()
  })

  it('renders an "Add" button (not "Swap") for discovered tokens', () => {
    portfolioState = makePortfolio({
      tokens: [ETH, discovered],
      totalValueUsd: 6000.5,
    })
    render(<PortfolioTab onSwapToken={vi.fn()} />)
    // The Swap button exists for ETH but not for UNK.
    expect(screen.getByRole('button', { name: /Swap ETH/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add UNK to tokens/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Swap UNK$/ })).toBeNull()
  })

  it('does NOT render the "Discovered" section when every token is in DEFAULT_TOKENS', () => {
    portfolioState = makePortfolio({
      tokens: [ETH, USDC],
      totalValueUsd: 7500,
    })
    render(<PortfolioTab />)
    expect(screen.queryByText(/Discovered in Wallet/i)).toBeNull()
  })

  it('does NOT render the "Discovered" section when the hook returns no tokens (fallback mode)', () => {
    // Fallback (no Alchemy) emits only DEFAULT_TOKENS multicall results.
    // A connected wallet with no balances has tokens.length === 0 — the
    // empty-state message is shown and no Discovered section appears.
    portfolioState = makePortfolio({ tokens: [], totalValueUsd: null })
    render(<PortfolioTab />)
    expect(screen.queryByText(/Discovered in Wallet/i)).toBeNull()
    expect(screen.getByText(/No tokens found in this wallet/i)).toBeTruthy()
  })
})
