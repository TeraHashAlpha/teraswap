// @vitest-environment jsdom
/**
 * [SPRINT-9Y] ChainSelector renders a bundled logo per chain (the Matcha look),
 * and switching chains is registry-driven.
 * [CHORE-CHAIN-SELECTOR-UX] Relay/Uniswap-style search popover: search input
 * filters, keyboard nav (arrows/Enter/Esc), ARIA listbox/option semantics,
 * comingSoon rows are disabled (click never calls switchChain).
 * [BUG-MOBILE-CHAIN-SELECTOR] trigger reachable on mobile + with/without a
 * connected wallet; disconnected selection updates the display without
 * invoking wagmi's switchChain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const switchChainMock = vi.fn()

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChain: switchChainMock, isPending: false }),
  useAccount: vi.fn(() => ({ isConnected: true, chain: { id: 1, name: 'mainnet' } })),
}))

import { useAccount } from 'wagmi'

// Base's feeCollector is env-driven (NEXT_PUBLIC_BASE_FEE_COLLECTOR) and unset in the test
// environment, so Base is comingSoon here exactly like Arbitrum — leaving no SECOND live chain
// to exercise "keyboard-select a different chain" against. Only Base's gate is overridden
// (registry/activation logic itself is untouched — read-only per the spec) so the keyboard-nav
// test below can prove Enter really calls switchChain for the newly-highlighted row.
vi.mock('@/lib/chains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains')>()
  return {
    ...actual,
    getChainConfig: (chainId: number) => {
      const cfg = actual.getChainConfig(chainId)
      if (chainId === 8453) return { ...cfg, contracts: { ...cfg.contracts, feeCollector: '0x1111111111111111111111111111111111111111' } }
      return cfg
    },
  }
})

import { renderWithProviders, screen, fireEvent } from '@/test-utils/render'
import ChainSelector from './ChainSelector'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'

function openSelector() {
  fireEvent.click(screen.getByLabelText(/network/i))
  return screen.getByPlaceholderText(/search networks/i) as HTMLInputElement
}

beforeEach(() => {
  switchChainMock.mockClear()
  vi.mocked(useAccount).mockReturnValue({ isConnected: true, chain: { id: 1, name: 'mainnet' } } as ReturnType<typeof useAccount>)
  // [feat/quote-before-wallet] the disconnected-chain pick is now a shared store
  // (module-level), not per-render local state — reset it so a selection made in
  // one test can't leak into the next.
  useDisconnectedChainSelection.setState({ chainId: null })
})

describe('[9Y] ChainSelector — chain logos', () => {
  it('shows the active chain logo in the trigger', () => {
    renderWithProviders(<ChainSelector />)
    expect(screen.getByTestId('chain-icon-1')).toBeInTheDocument()
  })

  it('opening the selector renders a bundled logo for every supported chain (Ethereum + Base)', () => {
    renderWithProviders(<ChainSelector />)
    fireEvent.click(screen.getByLabelText(/network/i))
    expect(screen.getAllByTestId('chain-icon-1').length).toBeGreaterThan(0)
    expect(screen.getByTestId('chain-icon-8453')).toBeInTheDocument()
    // logos are bundled SVGs — there must be no <img> doing an external fetch
    expect(document.querySelector('img')).toBeNull()
  })
})

describe('[SPRINT-46-ARBITRUM-CONFIG] ChainSelector — Arbitrum registered dark (feeCollector null)', () => {
  // [CORRECTION] The dark-launch premise is NOT "absent from the chain selector" — this
  // component lists every registry-driven chain unconditionally (getSupportedChainIds().map)
  // and shows a "Soon" badge for any feeCollector === null entry. That IS the existing Base
  // pre-activation pattern this sprint mirrors exactly; Arbitrum appearing with a "Soon" badge
  // here is expected, unchanged behavior — not a UI activation. Quotes/swaps stay blocked
  // downstream by isChainActive(42161) === false regardless of what this list renders.
  it('Arbitrum appears with a "Soon" badge (generic icon, no crash) — same pattern as Base', () => {
    renderWithProviders(<ChainSelector />)
    fireEvent.click(screen.getByLabelText(/network/i))
    expect(screen.getByTestId('chain-icon-42161')).toBeInTheDocument()
    const options = screen.getAllByRole('option')
    const arbitrumOption = options.find((o) => /arbitrum/i.test(o.textContent ?? ''))
    expect(arbitrumOption).toBeDefined()
    expect(arbitrumOption?.textContent).toMatch(/soon/i)
  })

  it('clicking the comingSoon Arbitrum row does NOT call switchChain (not selectable)', () => {
    renderWithProviders(<ChainSelector />)
    fireEvent.click(screen.getByLabelText(/network/i))
    const options = screen.getAllByRole('option')
    const arbitrumOption = options.find((o) => /arbitrum/i.test(o.textContent ?? ''))!
    fireEvent.click(arbitrumOption)
    expect(switchChainMock).not.toHaveBeenCalled()
    // still in the document — the popover does not close on a no-op click
    expect(screen.getByPlaceholderText(/search networks/i)).toBeInTheDocument()
  })
})

describe('[CHORE-CHAIN-SELECTOR-UX] search popover — filter, ARIA, keyboard, Esc', () => {
  it('renders a search input with the reference placeholder, autofocused on open', () => {
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    expect(input).toHaveFocus()
  })

  it('typing filters the list case-insensitively by chain name', () => {
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(3)

    fireEvent.change(input, { target: { value: 'base' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toMatch(/base/i)

    fireEvent.change(input, { target: { value: 'ETHER' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getAllByRole('option')[0].textContent).toMatch(/ethereum/i)
  })

  it('a query matching nothing shows an empty state, not a crash', () => {
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    fireEvent.change(input, { target: { value: 'zzzznotachain' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/no networks found/i)).toBeInTheDocument()
  })

  it('the container is an ARIA listbox and the active chain option has aria-selected=true', () => {
    renderWithProviders(<ChainSelector />)
    openSelector()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    const options = screen.getAllByRole('option')
    const ethereumOption = options.find((o) => /ethereum/i.test(o.textContent ?? ''))!
    expect(ethereumOption).toHaveAttribute('aria-selected', 'true')
    const baseOption = options.find((o) => /base/i.test(o.textContent ?? ''))!
    expect(baseOption).toHaveAttribute('aria-selected', 'false')
  })

  it('the comingSoon option carries aria-disabled=true', () => {
    renderWithProviders(<ChainSelector />)
    openSelector()
    const arbitrumOption = screen.getAllByRole('option').find((o) => /arbitrum/i.test(o.textContent ?? ''))!
    expect(arbitrumOption).toHaveAttribute('aria-disabled', 'true')
  })

  it('Escape closes the popover', () => {
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByPlaceholderText(/search networks/i)).toBeNull()
  })

  it('ArrowDown + Enter selects the next selectable chain and calls switchChain', () => {
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    // Highlight starts on the active chain (Ethereum, index 0) — ArrowDown moves to Base.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(switchChainMock).toHaveBeenCalledTimes(1)
    expect(switchChainMock).toHaveBeenCalledWith({ chainId: 8453 })
  })

  it('Enter with no navigation re-selects the already-active chain harmlessly', () => {
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    fireEvent.keyDown(input, { key: 'Enter' })
    // Ethereum (already active) is disabled in the option button, so no switch fires.
    expect(switchChainMock).not.toHaveBeenCalled()
  })
})

describe('[CHORE-MOBILE-SELECTOR-POLISH] coarse-pointer autofocus + centered mobile modal', () => {
  function mockPointer(coarse: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(pointer: coarse)' ? coarse : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }

  it('autofocuses the search input on desktop (fine pointer)', () => {
    mockPointer(false)
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    expect(input).toHaveFocus()
  })

  it('does NOT autofocus the search input on a coarse (touch) pointer', () => {
    mockPointer(true)
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    expect(input).not.toHaveFocus()
  })

  it('renders a centered-modal container class for the popover', () => {
    renderWithProviders(<ChainSelector />)
    const input = openSelector()
    const modalWrapper = input.closest('[role="presentation"]')?.parentElement
    expect(modalWrapper?.className).toMatch(/flex items-center justify-center/)
    expect(input.closest('[role="presentation"]')?.className).toMatch(/max-w-sm/)
    expect(input.closest('[role="presentation"]')?.className).toMatch(/rounded-2xl/)
  })

  it('has a close affordance button in the mobile modal', () => {
    renderWithProviders(<ChainSelector />)
    openSelector()
    expect(screen.getByLabelText(/close network picker/i)).toBeInTheDocument()
  })
})

describe('[BUG-MOBILE-CHAIN-SELECTOR] trigger visibility', () => {
  it('the trigger has no viewport-hiding class (regression: was `hidden sm:block` on the whole component)', () => {
    renderWithProviders(<ChainSelector />)
    const trigger = screen.getByLabelText(/network/i)
    expect(trigger.className).not.toMatch(/\bhidden\b/)
    // the old bug hid the entire wrapping div below `sm` — walk up and confirm
    // no ancestor up to the component root carries a bare `hidden` class either.
    let node: HTMLElement | null = trigger.parentElement
    while (node) {
      expect(node.className).not.toMatch(/\bhidden\b/)
      node = node.parentElement
    }
  })

  it('the trigger renders when the wallet is disconnected', () => {
    vi.mocked(useAccount).mockReturnValue({ isConnected: false, chain: undefined } as ReturnType<typeof useAccount>)
    renderWithProviders(<ChainSelector />)
    expect(screen.getByLabelText(/network/i)).toBeInTheDocument()
  })
})

describe('[BUG-MOBILE-CHAIN-SELECTOR] disconnected vs connected selection', () => {
  it('selecting a chain while disconnected updates the trigger WITHOUT calling switchChain', () => {
    vi.mocked(useAccount).mockReturnValue({ isConnected: false, chain: undefined } as ReturnType<typeof useAccount>)
    renderWithProviders(<ChainSelector />)
    openSelector()
    const baseOption = screen.getAllByRole('option').find((o) => /base/i.test(o.textContent ?? ''))!
    fireEvent.click(baseOption)

    expect(switchChainMock).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Network: Base')).toBeInTheDocument()
  })

  it('selecting a chain while connected calls switchChain (existing behavior, unchanged)', () => {
    renderWithProviders(<ChainSelector />)
    openSelector()
    const baseOption = screen.getAllByRole('option').find((o) => /base/i.test(o.textContent ?? ''))!
    fireEvent.click(baseOption)

    expect(switchChainMock).toHaveBeenCalledWith({ chainId: 8453 })
  })

  it('the comingSoon Arbitrum row stays non-selectable while disconnected too', () => {
    vi.mocked(useAccount).mockReturnValue({ isConnected: false, chain: undefined } as ReturnType<typeof useAccount>)
    renderWithProviders(<ChainSelector />)
    openSelector()
    const arbitrumOption = screen.getAllByRole('option').find((o) => /arbitrum/i.test(o.textContent ?? ''))!
    fireEvent.click(arbitrumOption)
    expect(switchChainMock).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/network: ethereum/i)).toBeInTheDocument()
  })
})
