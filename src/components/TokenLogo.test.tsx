// @vitest-environment jsdom
/**
 * [SPRINT token-selector-ux P1] <TokenLogo> fallback chain. The TokenSelector used
 * to drop a bare <img onError={display:none}>, leaving a blank circle when the
 * catalog logoURI 404'd. TokenLogo walks logoURI → Trust Wallet CDN → generated
 * avatar, so a token ALWAYS shows something visible.
 *
 * jsdom never actually loads images, so we drive the fallback by firing onError on
 * the rendered <img> — no network is touched.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TokenLogo from './TokenLogo'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const

describe('TokenLogo [SPRINT token-selector-ux P1]', () => {
  it('renders the logoURI <img> when present', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    const img = screen.getByRole('img', { name: 'USDC' })
    expect(img).toHaveAttribute('src', 'https://example.com/usdc.png')
  })

  it('advances to the Trust Wallet CDN <img> when the logoURI errors', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    const img = screen.getByRole('img', { name: 'USDC' })
    // Different source from the catalog 1inch URL: Trust Wallet, EIP-55 checksummed.
    expect(img.getAttribute('src')).toContain('trustwallet/assets')
    expect(img.getAttribute('src')).toContain(USDC) // checksummed address preserved
  })

  it('renders the GENERATED AVATAR (initials, not blank) once both CDN imgs error', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    // logoURI errors → Trust Wallet img; Trust Wallet errors → generated avatar.
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    // No <img> left; the avatar shows the symbol's initials as visible text.
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('US')).toBeInTheDocument()
  })

  it('reaches the generated avatar directly when logoURI is empty (initials visible, not blank)', () => {
    render(<TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />)
    // empty logoURI is skipped; first candidate is the Trust Wallet img.
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    expect(screen.queryByRole('img')).toBeNull()
    const avatar = screen.getByText('US')
    expect(avatar).toBeInTheDocument()
    // Not display:none / not blank — it carries a deterministic background colour.
    expect(avatar.style.backgroundColor).not.toBe('')
    expect(avatar.style.display).not.toBe('none')
  })

  it('produces a deterministic avatar background for a given address (same address ⇒ same colour)', () => {
    const { unmount } = render(
      <TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    const colorA = screen.getByText('US').style.backgroundColor
    unmount()

    // Same address, different symbol → colour is derived from the ADDRESS, so it
    // must be identical across renders.
    render(<TokenLogo token={{ address: USDC, symbol: 'XYZ', logoURI: '', chainId: 1 }} />)
    fireEvent.error(screen.getByRole('img', { name: 'XYZ' }))
    const colorB = screen.getByText('XY').style.backgroundColor

    expect(colorA).not.toBe('')
    expect(colorB).toBe(colorA)
  })

  it('does not crash on the native ETH pseudo-address and still reaches a visible avatar', () => {
    // The 0xeeee… sentinel is a checksummable address, so the Trust Wallet step is
    // attempted (it just won't resolve). The fallback must still terminate safely:
    // on that img's error the deterministic avatar renders — never a blank circle.
    render(<TokenLogo token={{ address: NATIVE_ETH, symbol: 'ETH', logoURI: '', chainId: 1 }} />)
    const img = screen.queryByRole('img', { name: 'ETH' })
    if (img) fireEvent.error(img)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('ET')).toBeInTheDocument()
  })

  it('does not crash on a garbage / non-0x address and reaches the avatar', () => {
    // getAddress() throws on an unparseable address → Trust Wallet step is skipped,
    // so with an empty logoURI the avatar renders directly (no img candidate).
    render(<TokenLogo token={{ address: 'not-an-address' as `0x${string}`, symbol: 'Z', logoURI: '' }} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Z')).toBeInTheDocument()
  })

  it('resets the fallback when the token changes in place — no stale avatar (guards the trigger)', () => {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
    const { rerender } = render(
      <TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />,
    )
    // Exhaust USDC down to the generated avatar.
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    expect(screen.getByText('US')).toBeInTheDocument()
    // Swap the token IN PLACE (same instance — exactly the trigger's case). The new
    // token has a working logoURI, so it must render that <img>, NOT the stale avatar.
    rerender(
      <TokenLogo token={{ address: WETH, symbol: 'WETH', logoURI: 'https://example.com/weth.png', chainId: 1 }} />,
    )
    expect(screen.getByRole('img', { name: 'WETH' })).toHaveAttribute('src', 'https://example.com/weth.png')
    expect(screen.queryByText('US')).toBeNull()
  })
})
