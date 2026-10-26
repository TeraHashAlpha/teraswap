// @vitest-environment jsdom
/**
 * [ADR-025] Mobile (375): the tab strip scrolls horizontally with edge fades + chevrons and keeps the active tab in
 * view; the photo shows only behind header + tabs (solid column below, extra 35% veil); v1's own ♫ is hidden under v2.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBlockNumber: () => ({ data: 1n }),
  useBalance: () => ({ data: undefined }),
  useEnsName: () => ({ data: undefined }),
  useEnsAvatar: () => ({ data: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))
vi.mock('wagmi/chains', () => ({ mainnet: { id: 1 } }))
vi.mock('@rainbow-me/rainbowkit', async () => {
  const actual = await vi.importActual<typeof import('@rainbow-me/rainbowkit')>('@rainbow-me/rainbowkit')
  return {
    darkTheme: actual.darkTheme,
    RainbowKitProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ConnectButton: { Custom: ({ children }: { children: (p: unknown) => React.ReactNode }) => children({ account: undefined, chain: undefined, openConnectModal: vi.fn(), mounted: true }) },
  }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/portfolio', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars' }))

import { AppShell } from './AppShell'

const SHELL_CSS = readFileSync(join(__dirname, 'shell.css'), 'utf8')
const PHOTO_CSS = readFileSync(join(__dirname, '..', 'photos', 'photo.css'), 'utf8')
const scrollIntoView = vi.fn()

function setMetrics(el: HTMLElement, m: { scrollLeft: number; clientWidth: number; scrollWidth: number }) {
  for (const [k, v] of Object.entries(m)) Object.defineProperty(el, k, { configurable: true, value: v })
}

beforeEach(() => {
  scrollIntoView.mockClear()
  Element.prototype.scrollIntoView = scrollIntoView
})
afterEach(cleanup)

describe('tab strip scroll', () => {
  it('is a horizontal scroller (no scrollbar) around the tablist', () => {
    render(<AppShell />)
    const scroller = document.querySelector('[data-tab-scroller]') as HTMLElement
    expect(scroller.className).toContain('overflow-x-auto')
    expect(scroller.contains(screen.getByRole('tablist'))).toBe(true)
    expect(SHELL_CSS).toMatch(/\.ts-v2-tabscroll \{[^}]*scrollbar-width: none/)
  })

  it('scrolls the ACTIVE tab into view on mount and when it changes', () => {
    render(<AppShell tab="portfolio" />)
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: 'center', block: 'nearest' }))
    expect((scrollIntoView.mock.contexts.at(-1) as HTMLElement).getAttribute('data-tab-id')).toBe('portfolio')
  })

  it('edge fades + chevrons follow the scroll position (right only → both → left only)', () => {
    render(<AppShell />)
    const scroller = document.querySelector('[data-tab-scroller]') as HTMLElement
    const edges = () => [scroller.getAttribute('data-edge-left'), scroller.getAttribute('data-edge-right')]
    const chevrons = () => Array.from(document.querySelectorAll('[data-tab-chevron]')).map((c) => c.getAttribute('data-tab-chevron'))

    act(() => {
      setMetrics(scroller, { scrollLeft: 0, clientWidth: 343, scrollWidth: 640 })
      fireEvent.scroll(scroller)
    })
    expect(edges()).toEqual(['false', 'true'])
    expect(chevrons()).toEqual(['right'])

    act(() => {
      setMetrics(scroller, { scrollLeft: 120, clientWidth: 343, scrollWidth: 640 })
      fireEvent.scroll(scroller)
    })
    expect(edges()).toEqual(['true', 'true'])
    expect(chevrons()).toEqual(['left', 'right'])

    act(() => {
      setMetrics(scroller, { scrollLeft: 297, clientWidth: 343, scrollWidth: 640 })
      fireEvent.scroll(scroller)
    })
    expect(edges()).toEqual(['true', 'false'])
    expect(chevrons()).toEqual(['left'])
  })

  it('no fades or chevrons when everything fits (desktop)', () => {
    render(<AppShell />)
    const scroller = document.querySelector('[data-tab-scroller]') as HTMLElement
    act(() => {
      setMetrics(scroller, { scrollLeft: 0, clientWidth: 1376, scrollWidth: 1376 })
      fireEvent.scroll(scroller)
    })
    expect([scroller.getAttribute('data-edge-left'), scroller.getAttribute('data-edge-right')]).toEqual(['false', 'false'])
    expect(document.querySelectorAll('[data-tab-chevron]')).toHaveLength(0)
  })

  it('CSS draws the fades with a mask on the scroller, keyed by the data-edge attributes', () => {
    expect(SHELL_CSS).toMatch(/\[data-edge-left="true"\][^{]*\{[^}]*mask-image: linear-gradient\(to right/)
    expect(SHELL_CSS).toMatch(/\[data-edge-right="true"\][^{]*\{[^}]*mask-image: linear-gradient\(to left/)
  })
})

describe('mobile photo treatment', () => {
  it('the column below the tabs is solid on mobile with 12 px side margins, transparent from sm up', () => {
    render(<AppShell />)
    const col = document.querySelector('[data-ts-column]') as HTMLElement
    expect(col.className).toMatch(/\bmx-3\b/)
    expect(col.className).toMatch(/\bbg-v2-bg\b/)
    expect(col.className).toMatch(/sm:mx-0/)
    expect(col.className).toMatch(/sm:bg-transparent/)
    expect(col.contains(screen.getByRole('contentinfo'))).toBe(true)
  })

  it('extra 35% veil is a token, shown only below 640 px', () => {
    expect(PHOTO_CSS).toContain('--photo-veil-mobile: 0.35;')
    expect(PHOTO_CSS).toMatch(/@media \(max-width: 639px\) \{ \.ts-v2-photo__veil-mobile \{ display: block; \} \}/)
    render(<AppShell />)
    expect(document.querySelector('.ts-v2-photo__veil-mobile')).not.toBeNull()
  })
})

describe('v1 ♫ under v2', () => {
  it('v1 BackgroundMusic still labels its button "… background music" (the selector the hide rule relies on)', () => {
    const v1 = readFileSync(join(__dirname, '..', '..', '..', 'components', 'BackgroundMusic.tsx'), 'utf8')
    expect(v1).toMatch(/aria-label=\{enabled \? 'Mute background music' : 'Unmute background music'\}/)
    expect(SHELL_CSS).toContain('body:has([data-ts-ui="v2"]) button[aria-label$="background music"] { display: none; }')
  })

  it('the v2 ♫ never matches that selector, so it stays visible', () => {
    render(<AppShell />)
    expect(document.querySelectorAll('button[aria-label$="background music"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-v2-music-toggle]')).toHaveLength(1)
  })
})
