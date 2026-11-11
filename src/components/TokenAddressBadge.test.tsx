// @vitest-environment jsdom
/**
 * TokenAddressBadge tests.
 *
 * Two concerns are pinned here:
 *  1. The Etherscan explorer link is guarded with `isAddress(address)` to
 *     prevent href injection (CodeQL CQL-10). These tests pin the guard
 *     semantics: valid addresses pass, anything else is rejected — including
 *     the malformed strings that the TS `0x${string}` template type cannot
 *     reject at runtime.
 *  2. The VERIFIED indicator is a GREEN SHIELD with a white ✓ that renders ONLY
 *     for curated/verified tokens. Imported/unverified tokens keep the neutral
 *     amber warning triangle (the import flow already warns).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { isAddress } from 'viem'

// Verification is chain-aware (isVerifiedToken) and resolved against the active
// chain (useQuoteChainId). Mock both so the verified vs imported branches are
// deterministic without a wallet/provider — matching the repo's hoisted-mock style.
let mockVerified = false
let mockExplorerBase = 'https://etherscan.io'
vi.mock('@/hooks/useChainId', () => ({
  useQuoteChainId: () => 1,
}))
vi.mock('@/lib/chains/tokens', () => ({
  isVerifiedToken: () => mockVerified,
  explorerTokenUrl: (address: string) => `${mockExplorerBase}/token/${address}`,
}))

import TokenAddressBadge from './TokenAddressBadge'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`

beforeEach(() => {
  cleanup()
  mockVerified = false
  mockExplorerBase = 'https://etherscan.io'
})

describe('TokenAddressBadge: explorer anchor (CodeQL js/xss-through-dom)', () => {
  const anchor = (c: HTMLElement) => c.querySelector('a[aria-label="View on block explorer"]')

  it('renders the explorer link for a valid address, href unchanged', () => {
    const { container } = render(<TokenAddressBadge address={USDC} />)
    const a = anchor(container)
    expect(a).not.toBeNull()
    expect(a!.getAttribute('href')).toBe(`https://etherscan.io/token/${USDC}`)
    expect(a!.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders no anchor for a malformed or hostile address (runtime, past the TS type)', () => {
    for (const bad of [
      'javascript:alert(1)',
      '0x0000000000000000000000000000000000000000/../evil',
      '0xdeadbeef',
      '',
    ]) {
      const { container, unmount } = render(<TokenAddressBadge address={bad as `0x${string}`} />)
      expect(anchor(container)).toBeNull()
      unmount()
    }
  })

  it('renders no anchor when the explorer base is not https: (javascript:, http:, garbage)', () => {
    for (const base of ['javascript:alert(1)//', 'http://etherscan.io', 'not a url']) {
      mockExplorerBase = base
      const { container, unmount } = render(<TokenAddressBadge address={USDC} />)
      expect(anchor(container)).toBeNull()
      unmount()
    }
  })

  it('renders no anchor when showExplorerLink is false', () => {
    const { container } = render(<TokenAddressBadge address={USDC} showExplorerLink={false} />)
    expect(anchor(container)).toBeNull()
  })
})

describe('TokenAddressBadge: Etherscan href guard (CQL-10)', () => {
  it('accepts a valid checksummed address', () => {
    expect(isAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true)
  })

  it('accepts a valid lowercase address', () => {
    expect(isAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true)
  })

  it('rejects a non-address string', () => {
    expect(isAddress('not-an-address')).toBe(false)
  })

  it('rejects a javascript: scheme injection attempt', () => {
    expect(isAddress('javascript:alert(1)')).toBe(false)
  })

  it('rejects an address with embedded path traversal', () => {
    expect(isAddress('0x0000000000000000000000000000000000000000/../evil')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isAddress('')).toBe(false)
  })

  it('rejects a short hex string', () => {
    expect(isAddress('0xdeadbeef')).toBe(false)
  })
})

describe('TokenAddressBadge: verified indicator (green shield ✓)', () => {
  it('renders a green-shield check for a verified/curated token', () => {
    mockVerified = true
    const { container } = render(<TokenAddressBadge address={USDC} />)

    // The verified branch is titled and tinted emerald (green).
    const indicator = container.querySelector('span[title^="Verified"]')
    expect(indicator).not.toBeNull()
    expect(indicator).toHaveClass('text-emerald-500')

    // White check stroke on top of the filled shield — and NOT an emoji.
    const svg = indicator!.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.querySelector('path[stroke="#fff"]')).not.toBeNull()
    expect(indicator!.textContent).toBe('')
  })

  it('renders the amber import warning (NOT the green shield) for an unverified/imported token', () => {
    mockVerified = false
    const { container } = render(<TokenAddressBadge address={USDC} />)

    // No green-shield "Verified" indicator for an imported token.
    expect(container.querySelector('span[title^="Verified"]')).toBeNull()
    expect(container.querySelector('.text-emerald-500')).toBeNull()

    // The neutral amber warning triangle stays as the imported indicator.
    const warn = container.querySelector('span[title^="Imported token"]')
    expect(warn).not.toBeNull()
    expect(warn).toHaveClass('text-amber-400')
  })

  it('honours an explicit isVerified prop (no catalog lookup needed)', () => {
    mockVerified = false // catalog says unverified…
    const { container } = render(<TokenAddressBadge address={USDC} isVerified />)
    // …but the explicit prop forces the green shield.
    const indicator = container.querySelector('span[title^="Verified"]')
    expect(indicator).not.toBeNull()
    expect(indicator).toHaveClass('text-emerald-500')
  })
})
