// @vitest-environment jsdom
/**
 * [P82/M-01 Phase 2] TokenSelector — popular chips, search, balances.
 *
 * Mocks wagmi balance hooks at the boundary; mocks the address-badge
 * + import-token helpers as inert stubs so we can focus on selection /
 * filtering behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
    chain: { id: 1, name: 'mainnet' },
  })),
  useBalance: vi.fn(() => ({
    data: { value: 5n * 10n ** 18n, decimals: 18, symbol: 'ETH', formatted: '5.0' },
    isLoading: false,
    isError: false,
  })),
  useReadContracts: vi.fn(() => ({ data: [], isLoading: false, isError: false })),
}))

vi.mock('./TokenAddressBadge', () => ({
  default: ({ address }: { address: string }) => <div data-testid="address-badge">{address}</div>,
}))

vi.mock('@/hooks/useTokenImport', () => ({
  useTokenImport: () => ({
    importToken: vi.fn(),
    importing: false,
    error: null,
  }),
}))

import { renderWithProviders, fireEvent, screen, within } from '@/test-utils/render'
import TokenSelector from './TokenSelector'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TokenSelector — trigger button', () => {
  it('renders a "Select" placeholder when no token is chosen', () => {
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    expect(screen.getByText('Select')).toBeInTheDocument()
  })

  it('renders the symbol when a token is selected', () => {
    const token = {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      logoURI: '',
      category: 'Stablecoin' as const,
    }
    renderWithProviders(<TokenSelector selected={token} onSelect={vi.fn()} />)
    expect(screen.getByText('USDC')).toBeInTheDocument()
  })
})

describe('TokenSelector — modal interactions', () => {
  it('opens the modal when the trigger button is clicked', () => {
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByText('Select'))
    expect(screen.getByText(/Select token/i)).toBeInTheDocument()
  })

  it('renders popular tokens as quick-select chips in the modal', () => {
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByText('Select'))
    // ETH and USDC are in POPULAR_SYMBOLS.
    const modal = screen.getByText(/Select token/i).closest('div')!.parentElement!
    expect(within(modal).getAllByText('ETH').length).toBeGreaterThan(0)
    expect(within(modal).getAllByText('USDC').length).toBeGreaterThan(0)
  })

  it('clicking a popular chip calls onSelect with the matching token', () => {
    const onSelect = vi.fn()
    renderWithProviders(<TokenSelector selected={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Select'))
    // Find USDC chip (first match in the popular row).
    const usdcButtons = screen.getAllByText('USDC')
    fireEvent.click(usdcButtons[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].symbol).toBe('USDC')
  })

  it('typing in the search box filters the visible list by symbol', () => {
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByText('Select'))
    const input = screen.getByPlaceholderText(/search name, symbol/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'wbtc' } })
    // "1 result" / "N results" heading appears for searches.
    expect(screen.getByText(/result/)).toBeInTheDocument()
  })

  it('disabledAddress excludes the matching token from the popular chips', () => {
    const usdcAddr = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    renderWithProviders(
      <TokenSelector selected={null} onSelect={vi.fn()} disabledAddress={usdcAddr} />,
    )
    fireEvent.click(screen.getByText('Select'))
    // USDC should not be in the popular chip row. It might still appear
    // in the full list under "Stablecoin" category — so we look only
    // inside the chip wrapper (first non-search row).
    const dialog = screen.getByText(/Select token/).closest('div')!.parentElement!
    // The chips row is the first flex-wrap container after the header.
    const chipRow = dialog.querySelector('.flex-wrap')!
    expect(within(chipRow as HTMLElement).queryByText('USDC')).toBeNull()
  })
})

describe('[9Y] TokenSelector — expanded catalog + chain-scoped long-tail search', () => {
  async function setChain(id: number) {
    const wagmi = await import('wagmi')
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      isConnected: true,
      chain: { id, name: id === 1 ? 'mainnet' : 'base' },
    })
  }

  afterEach(async () => {
    await setChain(1) // restore mainnet default
  })

  function openAndSearch(value: string) {
    fireEvent.click(screen.getByText('Select'))
    fireEvent.change(screen.getByPlaceholderText(/search name, symbol/i), { target: { value } })
  }

  it('mainnet: searching a long-tail symbol (ACX) that is NOT a default token shows a result', () => {
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    openAndSearch('ACX')
    expect(screen.getAllByText('ACX').length).toBeGreaterThan(0)
  })

  it('Base: the default view shows expanded suggested majors (AERO, DEGEN)', async () => {
    await setChain(8453)
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByText('Select'))
    const modal = screen.getByText(/Select token/i).closest('div')!.parentElement!
    expect(within(modal).getAllByText('AERO').length).toBeGreaterThan(0)
    expect(within(modal).getAllByText('DEGEN').length).toBeGreaterThan(0)
  })

  it('Base: searching a long-tail symbol (ZRX) finds it in the catalog', async () => {
    await setChain(8453)
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    openAndSearch('ZRX')
    expect(screen.getAllByText('ZRX').length).toBeGreaterThan(0)
  })

  it('search is chain-scoped: a Base-only token (AERO) is NOT found on mainnet', () => {
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    openAndSearch('AERO')
    // AERO is Base-native and absent from the mainnet catalog → no result row.
    expect(screen.queryByText('AERO')).toBeNull()
  })

  it('selecting a long-tail search result calls onSelect with the real catalog token', async () => {
    await setChain(8453)
    const onSelect = vi.fn()
    renderWithProviders(<TokenSelector selected={null} onSelect={onSelect} />)
    openAndSearch('ZRX')
    fireEvent.click(screen.getAllByText('ZRX')[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].symbol).toBe('ZRX')
    expect(onSelect.mock.calls[0][0].address.toLowerCase()).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

describe('TokenSelector — wallet disconnected', () => {
  it('still renders the trigger when wallet is not connected', async () => {
    const wagmi = await import('wagmi')
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValue({
      address: undefined,
      isConnected: false,
      chain: { id: 1, name: 'mainnet' },
    })
    renderWithProviders(<TokenSelector selected={null} onSelect={vi.fn()} />)
    expect(screen.getByText('Select')).toBeInTheDocument()
    // Restore default.
    ;(wagmi.useAccount as ReturnType<typeof vi.fn>).mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      isConnected: true,
      chain: { id: 1, name: 'mainnet' },
    })
  })
})
