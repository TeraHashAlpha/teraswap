// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FloorTierBadge from '../FloorTierBadge'

describe('FloorTierBadge [FEAT-DCA-FLOOR-TIERS]', () => {
  it('renders nothing for on-chain-feed, null and undefined', () => {
    const { container, rerender } = render(<FloorTierBadge tier="onchain-feed" />)
    expect(container.firstChild).toBeNull()
    rerender(<FloorTierBadge tier={null} />)
    expect(container.firstChild).toBeNull()
    rerender(<FloorTierBadge />)
    expect(container.firstChild).toBeNull()
  })
  it('marks each weaker tier distinctly', () => {
    const { rerender } = render(<FloorTierBadge tier="offchain-price" />)
    expect(screen.getByTestId('floor-tier-badge').getAttribute('data-tier')).toBe('offchain-price')
    rerender(<FloorTierBadge tier="unpriced" />)
    expect(screen.getByTestId('floor-tier-badge').getAttribute('data-tier')).toBe('unpriced')
  })
})
