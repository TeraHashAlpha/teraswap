// @vitest-environment jsdom
/**
 * [SPRINT-9Y] ChainSelector renders a bundled logo per chain (the Matcha look),
 * and switching chains is registry-driven.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useAccount: vi.fn(() => ({ chain: { id: 1, name: 'mainnet' } })),
}))

import { renderWithProviders, screen, fireEvent } from '@/test-utils/render'
import ChainSelector from './ChainSelector'

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
