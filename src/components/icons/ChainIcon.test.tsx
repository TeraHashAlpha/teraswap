// @vitest-environment jsdom
/**
 * [SPRINT-9Y] Chain logos are bundled inline SVGs — no external fetch.
 */
import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '@/test-utils/render'
import ChainIcon from './ChainIcon'

describe('[9Y] ChainIcon — bundled static chain logos (no external fetch)', () => {
  it('renders an inline SVG (not an <img>) for Ethereum (chainId 1)', () => {
    const { container } = renderWithProviders(<ChainIcon chainId={1} />)
    expect(screen.getByTestId('chain-icon-1')).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull() // bundled — never hits the network
  })

  it('renders a distinct bundled icon for Base (chainId 8453)', () => {
    const { container } = renderWithProviders(<ChainIcon chainId={8453} />)
    expect(screen.getByTestId('chain-icon-8453')).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('falls back to a generic icon for an unknown chain (never throws)', () => {
    renderWithProviders(<ChainIcon chainId={999} />)
    expect(screen.getByTestId('chain-icon-999')).toBeInTheDocument()
  })
})
