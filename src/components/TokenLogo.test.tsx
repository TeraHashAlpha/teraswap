// @vitest-environment jsdom
/**
 * [SPRINT token-selector-ux P1] <TokenLogo> fallback chain. The TokenSelector used
 * to drop a bare <img onError={display:none}>, leaving a blank circle when the
 * catalog logoURI 404'd (the old 1inch icons are mainnet-keyed → 404 on Base).
 * TokenLogo now walks a de-duplicated chain of RELIABLE sources first —
 * logoURI → DefiLlama (chainId-aware) → Trust Wallet CDN → generated avatar — so a
 * token ALWAYS shows a real logo where one exists and the initials avatar is a rare,
 * true last resort.
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
  // (a) A token WITH a real logoURI renders that <img>, NOT the avatar.
  it('renders the logoURI <img> when present (not the avatar)', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    const img = screen.getByRole('img', { name: 'USDC' })
    expect(img).toHaveAttribute('src', 'https://example.com/usdc.png')
    // Reliable source first — no premature avatar.
    expect(screen.queryByText('US')).toBeNull()
  })

  // (b) An empty logoURI advances to the DefiLlama <img> (chainId + lowercase addr)
  //     BEFORE any avatar — DefiLlama is the first reliable candidate.
  it('advances to the DefiLlama <img> (chainId + lowercase) before any avatar', () => {
    render(<TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />)
    const img = screen.getByRole('img', { name: 'USDC' })
    const src = img.getAttribute('src') ?? ''
    expect(src).toContain('token-icons.llamao.fi')
    expect(src).toContain('/1/') // chainId honored
    expect(src).toContain(USDC.toLowerCase()) // lowercase address — no checksum pitfall
    // Still an <img>, NOT the initials avatar.
    expect(screen.queryByText('US')).toBeNull()
  })

  // logoURI → DefiLlama: a present-but-broken logoURI falls through to DefiLlama
  // before Trust Wallet.
  it('falls from a broken logoURI to the DefiLlama <img>', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    const src = screen.getByRole('img', { name: 'USDC' }).getAttribute('src') ?? ''
    expect(src).toContain('token-icons.llamao.fi')
    expect(src).toContain(USDC.toLowerCase())
  })

  // DefiLlama → Trust Wallet: after logoURI + DefiLlama error, the per-chain Trust
  // Wallet (EIP-55 checksummed) <img> is the last image candidate.
  it('advances logoURI → DefiLlama → Trust Wallet <img>', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // logoURI → DefiLlama
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // DefiLlama → Trust Wallet
    const src = screen.getByRole('img', { name: 'USDC' }).getAttribute('src') ?? ''
    expect(src).toContain('trustwallet/assets')
    expect(src).toContain(USDC) // checksummed (EIP-55) address preserved
  })

  // (c) Only after logoURI + DefiLlama + Trust Wallet ALL error does the initials
  //     avatar appear (no <img> left, initials text present).
  it('renders the GENERATED AVATAR only once logoURI + DefiLlama + Trust Wallet all error', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // logoURI → DefiLlama
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // DefiLlama → Trust Wallet
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // Trust Wallet → avatar
    // No <img> left; the avatar shows the symbol's initials as visible text.
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('US')).toBeInTheDocument()
  })

  // (d) A Base token (chainId 8453) produces the '/8453/' DefiLlama path — chainId
  //     is honored end-to-end.
  it('honors chainId: a Base (8453) token produces the /8453/ DefiLlama path', () => {
    // A Base address (USDbC) — empty logoURI so DefiLlama is the first <img>.
    const USDbC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as const
    render(<TokenLogo token={{ address: USDbC, symbol: 'USDbC', logoURI: '', chainId: 8453 }} />)
    const src = screen.getByRole('img', { name: 'USDbC' }).getAttribute('src') ?? ''
    expect(src).toContain('token-icons.llamao.fi')
    expect(src).toContain('/8453/')
    expect(src).toContain(USDbC.toLowerCase())
  })

  it('reaches the generated avatar once every image candidate errors (initials visible, not blank)', () => {
    render(<TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />)
    // empty logoURI is skipped → DefiLlama img, then Trust Wallet img, then avatar.
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // DefiLlama → Trust Wallet
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // Trust Wallet → avatar
    expect(screen.queryByRole('img')).toBeNull()
    const avatar = screen.getByText('US')
    expect(avatar).toBeInTheDocument()
    // Not display:none / not blank — it carries a deterministic background colour.
    expect(avatar.style.backgroundColor).not.toBe('')
    expect(avatar.style.display).not.toBe('none')
  })

  it('produces a deterministic avatar background for a given address (same address ⇒ same colour)', () => {
    const exhaust = () => {
      // Drive every image candidate to error → avatar.
      let img = screen.queryByRole('img')
      while (img) {
        fireEvent.error(img)
        img = screen.queryByRole('img')
      }
    }
    const { unmount } = render(
      <TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />,
    )
    exhaust()
    const colorA = screen.getByText('US').style.backgroundColor
    unmount()

    // Same address, different symbol → colour is derived from the ADDRESS, so it
    // must be identical across renders.
    render(<TokenLogo token={{ address: USDC, symbol: 'XYZ', logoURI: '', chainId: 1 }} />)
    exhaust()
    const colorB = screen.getByText('XY').style.backgroundColor

    expect(colorA).not.toBe('')
    expect(colorB).toBe(colorA)
  })

  it('does not crash on the native ETH pseudo-address and still reaches a visible avatar', () => {
    // The 0xeeee… sentinel is a checksummable lowercase address, so both the DefiLlama
    // and Trust Wallet steps are attempted (they just won't resolve). The fallback must
    // still terminate safely on the deterministic avatar — never a blank circle.
    render(<TokenLogo token={{ address: NATIVE_ETH, symbol: 'ETH', logoURI: '', chainId: 1 }} />)
    let img = screen.queryByRole('img', { name: 'ETH' })
    while (img) {
      fireEvent.error(img)
      img = screen.queryByRole('img', { name: 'ETH' })
    }
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('ET')).toBeInTheDocument()
  })

  it('does not crash on a garbage / non-0x address and reaches the avatar', () => {
    // getAddress() throws on an unparseable address → Trust Wallet step is skipped.
    // DefiLlama uses .toLowerCase() (no checksum), so it still emits one img; once that
    // errors the avatar renders.
    render(<TokenLogo token={{ address: 'not-an-address' as `0x${string}`, symbol: 'Z', logoURI: '' }} />)
    let img = screen.queryByRole('img', { name: 'Z' })
    while (img) {
      fireEvent.error(img)
      img = screen.queryByRole('img', { name: 'Z' })
    }
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Z')).toBeInTheDocument()
  })

  // Dedupe: a catalog logoURI that ALREADY equals the DefiLlama URL must not be
  // pushed (and retried) twice — one error should advance past it straight to Trust
  // Wallet, not re-render the identical DefiLlama src.
  it('dedupes a logoURI that already equals the DefiLlama URL (no double retry)', () => {
    const defiLlama = `https://token-icons.llamao.fi/icons/tokens/1/${USDC.toLowerCase()}?h=48&w=48`
    render(<TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: defiLlama, chainId: 1 }} />)
    // First src is the (deduped) DefiLlama URL.
    expect(screen.getByRole('img', { name: 'USDC' }).getAttribute('src')).toBe(defiLlama)
    // One error must skip the duplicate and land on Trust Wallet — not the same URL.
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    const src = screen.getByRole('img', { name: 'USDC' }).getAttribute('src') ?? ''
    expect(src).toContain('trustwallet/assets')
    expect(src).not.toBe(defiLlama)
  })

  // (e) #207: resets the fallback when the token changes IN PLACE — no stale avatar.
  it('resets the fallback when the token changes in place — no stale avatar (guards the trigger)', () => {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
    const { rerender } = render(
      <TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />,
    )
    // Exhaust USDC down to the generated avatar.
    let img = screen.queryByRole('img', { name: 'USDC' })
    while (img) {
      fireEvent.error(img)
      img = screen.queryByRole('img', { name: 'USDC' })
    }
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
