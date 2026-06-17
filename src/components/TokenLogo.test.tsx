// @vitest-environment jsdom
/**
 * [SPRINT token-selector-ux P1] <TokenLogo> fallback chain. The TokenSelector used
 * to drop a bare <img onError={display:none}>, leaving a blank circle when the
 * catalog logoURI 404'd (the old 1inch icons are mainnet-keyed → 404 on Base).
 * TokenLogo now walks a de-duplicated chain of RELIABLE sources first —
 * logoURI → /api/token-logo route (chainId-aware) → Trust Wallet CDN → generated
 * avatar — so a token ALWAYS shows a real logo where one exists and the initials
 * avatar is a rare, true last resort. The route resolves via the per-chain CoinGecko
 * list server-side and falls back to DefiLlama internally.
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

  // (b) An empty logoURI advances to the ROUTE <img> (chainId + lowercase addr)
  //     BEFORE any avatar — the /api/token-logo route is the first reliable candidate.
  it('advances to the /api/token-logo <img> (chainId + lowercase) before any avatar', () => {
    render(<TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />)
    const img = screen.getByRole('img', { name: 'USDC' })
    const src = img.getAttribute('src') ?? ''
    expect(src).toContain('/api/token-logo?chainId=1')
    expect(src).toContain(`address=${USDC.toLowerCase()}`) // lowercase address — no checksum pitfall
    // Still an <img>, NOT the initials avatar.
    expect(screen.queryByText('US')).toBeNull()
  })

  // logoURI → route: a present-but-broken logoURI falls through to the route before
  // Trust Wallet.
  it('falls from a broken logoURI to the /api/token-logo <img>', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    const src = screen.getByRole('img', { name: 'USDC' }).getAttribute('src') ?? ''
    expect(src).toContain('/api/token-logo?chainId=1')
    expect(src).toContain(`address=${USDC.toLowerCase()}`)
  })

  // route → Trust Wallet: after logoURI + route error, the per-chain Trust Wallet
  // (EIP-55 checksummed) <img> is the last image candidate.
  it('advances logoURI → /api/token-logo → Trust Wallet <img>', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // logoURI → route
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // route → Trust Wallet
    const src = screen.getByRole('img', { name: 'USDC' }).getAttribute('src') ?? ''
    expect(src).toContain('trustwallet/assets')
    expect(src).toContain(USDC) // checksummed (EIP-55) address preserved
  })

  // (c) Only after logoURI + route + Trust Wallet ALL error does the initials avatar
  //     appear (no <img> left, initials text present).
  it('renders the GENERATED AVATAR only once logoURI + route + Trust Wallet all error', () => {
    render(
      <TokenLogo
        token={{ address: USDC, symbol: 'USDC', logoURI: 'https://example.com/usdc.png', chainId: 1 }}
      />,
    )
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // logoURI → route
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // route → Trust Wallet
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // Trust Wallet → avatar
    // No <img> left; the avatar shows the symbol's initials as visible text.
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('US')).toBeInTheDocument()
  })

  // (d) A Base token (chainId 8453) produces the 'chainId=8453' route path — chainId
  //     is honored end-to-end.
  it('honors chainId: a Base (8453) token produces the chainId=8453 route path', () => {
    // A Base address (USDbC) — empty logoURI so the route is the first <img>.
    const USDbC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as const
    render(<TokenLogo token={{ address: USDbC, symbol: 'USDbC', logoURI: '', chainId: 8453 }} />)
    const src = screen.getByRole('img', { name: 'USDbC' }).getAttribute('src') ?? ''
    expect(src).toContain('/api/token-logo?chainId=8453')
    expect(src).toContain(`address=${USDbC.toLowerCase()}`)
  })

  it('reaches the generated avatar once every image candidate errors (initials visible, not blank)', () => {
    render(<TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: '', chainId: 1 }} />)
    // empty logoURI is skipped → route img, then Trust Wallet img, then avatar.
    fireEvent.error(screen.getByRole('img', { name: 'USDC' })) // route → Trust Wallet
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
    // The 0xeeee… sentinel is a checksummable lowercase address, so both the route and
    // Trust Wallet steps are attempted (they just won't resolve). The fallback must
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
    // The route uses .toLowerCase() (no checksum), so it still emits one img; once that
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

  // Dedupe: a catalog logoURI that ALREADY equals the route URL must not be pushed
  // (and retried) twice — one error should advance past it straight to Trust Wallet,
  // not re-render the identical route src. The catalog `logo()` helper produces this
  // EXACT byte-for-byte format, so this is the real-world dedupe case.
  it('dedupes a logoURI that already equals the /api/token-logo URL (no double retry)', () => {
    const route = `/api/token-logo?chainId=1&address=${USDC.toLowerCase()}`
    render(<TokenLogo token={{ address: USDC, symbol: 'USDC', logoURI: route, chainId: 1 }} />)
    // First src is the (deduped) route URL.
    expect(screen.getByRole('img', { name: 'USDC' }).getAttribute('src')).toBe(route)
    // One error must skip the duplicate and land on Trust Wallet — not the same URL.
    fireEvent.error(screen.getByRole('img', { name: 'USDC' }))
    const src = screen.getByRole('img', { name: 'USDC' }).getAttribute('src') ?? ''
    expect(src).toContain('trustwallet/assets')
    expect(src).not.toBe(route)
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
