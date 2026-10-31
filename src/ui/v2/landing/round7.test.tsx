// @vitest-environment jsdom
/**
 * [ADR-025] Round 7 (owner decisions D2–D4): the no-box landing language. Pieces that need no page mock live here — the
 * route race (D4 §2), its CSS contract, and a source sweep that no box class / opaque plate is left in the landing or the
 * shell. The mounted-page checks (features list, scrims, button roles) are in landing.test.tsx next to their mocks.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config/product-claims', async () => {
  const actual = await vi.importActual<typeof import('@/config/product-claims')>('@/config/product-claims')
  return { ...actual, INTEGRATED_DEX_SOURCE_COUNT: 8 }
})

import { INTEGRATED_DEX_SOURCE_NAMES } from '@/config/product-claims'
import { RACE_ILLUSTRATIVE_LABEL, RouteRace, routeRaceWidths } from './RouteRace'

const CSS = readFileSync(join(__dirname, 'landing.css'), 'utf8')
const TOKENS = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('routeRaceWidths', () => {
  it('is the approved sample curve for eight sources', () => {
    expect(routeRaceWidths(8)).toEqual([100, 95, 91, 87, 83, 74, 62, 48])
  })

  it.each(Array.from({ length: 26 }, (_, i) => i))('n = %i: n bars, the winner full width, never increasing', (n) => {
    const w = routeRaceWidths(n)
    expect(w).toHaveLength(n)
    if (n > 0) expect(w[0]).toBe(100)
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThanOrEqual(w[i - 1])
    for (const x of w) expect(x).toBeGreaterThan(0)
  })

  it('a count that is not 8 resamples along the same curve (ends at the curve\'s end)', () => {
    const w = routeRaceWidths(11)
    expect(w[0]).toBe(100)
    expect(w[10]).toBe(48)
  })
})

describe('RouteRace (D4)', () => {
  it('draws 8 ranked bars, the first is the cream winner, and the figure says it is illustrative', () => {
    render(<RouteRace />)
    const rows = Array.from(document.querySelectorAll('.ts-v2-race__row'))
    expect(rows).toHaveLength(8)
    expect(rows.filter((r) => r.hasAttribute('data-win'))).toEqual([rows[0]])
    expect(rows[0].textContent).toBe('BEST · ROUTE A')
    expect(rows[7].textContent).toBe('ROUTE H')
    const widths = rows.map((r) => (r.querySelector('i') as HTMLElement).style.width)
    expect(widths).toEqual(['100%', '95%', '91%', '87%', '83%', '74%', '62%', '48%'])
    expect(RACE_ILLUSTRATIVE_LABEL).toBe('ILLUSTRATIVE · NOT A LIVE QUOTE')
    expect(document.querySelector('[data-race-label]')!.textContent).toBe('ILLUSTRATIVE · NOT A LIVE QUOTE')
    expect(screen.getByRole('img', { name: /Illustrative route race.*Not a live quote/ })).toBeTruthy()
    expect(CSS).toMatch(/\.ts-v2-race__row\[data-win\] \.ts-v2-race__bar \{ background: var\(--cream\); \}/)
  })

  it('carries no figures and no venue → bar mapping', () => {
    render(<RouteRace />)
    const rows = Array.from(document.querySelectorAll('.ts-v2-race__row'))
    for (const r of rows) {
      expect(r.textContent).not.toMatch(/\d|%|\$/)
      for (const name of INTEGRATED_DEX_SOURCE_NAMES) expect(r.textContent!.toLowerCase()).not.toContain(name.toLowerCase())
    }
    // the bars list as a whole is digit-free; the only other digits are the source count in the caption (a claims slot)
    // and venue names in the sources line ("uniswapv3", "0x")
    expect(document.querySelector('ol')!.textContent).not.toMatch(/\d/)
  })

  it('lists the sources once, from product-claims', () => {
    render(<RouteRace />)
    expect(document.querySelector('figure')!.textContent).toContain(`SOURCES QUERIED: ${INTEGRATED_DEX_SOURCE_NAMES.join(' · ')}`)
    expect(document.querySelector('figcaption')!.textContent).toContain('NET OUTPUT AFTER GAS · 8 SOURCES')
  })

  it('bars grow in on approach: collapsed only once armed, released when the figure is within a viewport, never again', () => {
    const observers: { cb: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn>; opts?: IntersectionObserverInit }[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        disconnect = vi.fn()
        constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
          observers.push({ cb, disconnect: this.disconnect, opts })
        }
        observe() {}
        unobserve() {}
      },
    )
    render(<RouteRace />)
    const fig = document.querySelector('figure')!
    expect(fig.hasAttribute('data-race-js')).toBe(true)
    expect(fig.hasAttribute('data-race-near')).toBe(false)
    expect(observers[0].opts?.rootMargin).toBe('0px 0px 100% 0px') // one viewport ahead, the narrative's lazy-load margin
    act(() => observers[0].cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(fig.hasAttribute('data-race-near')).toBe(false)
    act(() => observers[0].cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(fig.hasAttribute('data-race-near')).toBe(true)
    expect(observers[0].disconnect).toHaveBeenCalled()
  })

  it('without IntersectionObserver nothing is hidden (bars stay full width)', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    render(<RouteRace />)
    const fig = document.querySelector('figure')!
    expect(fig.hasAttribute('data-race-js')).toBe(false)
    expect(CSS).toMatch(/\.ts-v2-race\[data-race-js\]:not\(\[data-race-near\]\) \.ts-v2-race__bar \{ transform: scaleX\(0\.05\); \}/)
  })

  it('CSS: the grow-in uses the --bar-dur / --bar-ease tokens and is static under reduced motion', () => {
    expect(CSS).toMatch(/transition: transform var\(--bar-dur\) var\(--bar-ease\)/)
    expect(TOKENS).toMatch(/--bar-dur:900ms; --bar-ease:cubic-bezier\(\.2,\.7,\.2,1\);/)
    const rm = /@media \(prefers-reduced-motion: reduce\) \{\s*\.ts-v2-race__bar[^}]*\}[^}]*\}/.exec(CSS)?.[0] ?? ''
    expect(rm).toMatch(/transform: none !important/)
    expect(rm).toMatch(/transition: none !important/)
  })
})

describe('local scrims (landing.css)', () => {
  it('each variant paints a token gradient from ::after at z-index 1 (above the photo, below the content wrapper)', () => {
    expect(CSS).toMatch(/\.ts-v2-scrim::after \{[^}]*z-index: 1;[^}]*background: var\(--scrim-left\);/)
    expect(CSS).toMatch(/\.ts-v2-scrim--race::after \{ background: var\(--scrim-left-race\); \}/)
    expect(CSS).toMatch(/\.ts-v2-scrim--features::after \{ background: var\(--scrim-left-features\); \}/)
    expect(CSS).toMatch(/\.ts-v2-scrim--center::after \{ background: var\(--scrim-down\); \}/)
  })

  it('≤ 600 px every scrim turns vertical (the mobile pair)', () => {
    const mobile = /@media \(max-width: 600px\) \{\s*\.ts-v2-scrim::after[^}]*\}[^}]*\}/.exec(CSS)?.[0] ?? ''
    expect(mobile).toMatch(/var\(--scrim-down\)/)
    expect(mobile).toMatch(/\.ts-v2-scrim--features::after \{ background: var\(--scrim-down-features\); \}/)
  })

  it('badges are text labels with a "· " lead — no chip', () => {
    expect(CSS).toMatch(/\.ts-v2-badge::before \{ content: "· "; \}/)
    const badge = /\.ts-v2-badge \{[^}]*\}/.exec(CSS)?.[0] ?? ''
    expect(badge).not.toMatch(/border|background|padding/)
    expect(CSS).toMatch(/\.ts-v2-badge--soon \{ color: var\(--muted\); \}/) // muted, not dim: dim fails 4.5 on a scrim
  })
})

describe('no-box source sweep (D2): the landing and the shell', () => {
  const root = join(__dirname, '..')
  const tsx = (dir: string) =>
    readdirSync(join(root, dir)).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) && !/harness/.test(f)).map((f) => ({ f: `${dir}/${f}`, src: readFileSync(join(root, dir, f), 'utf8') }))
  const files = [...tsx('landing'), ...tsx('shell')]
  // a filled surface, a border colour, or a radius on content (rounded-full = the FAB ring / avatar / switch is allowed)
  const BOX = /\b(bg-v2-surface2?(\/\d+)?|border-v2-border|rounded-v2-(card|control|chip))\b|ts-v2-plate|<Panel\b/

  it('covers the landing and the shell (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it.each(files.map((x) => [x.f, x.src] as const))('%s uses no box class and no opaque plate', (_f, src) => {
    expect(src.match(BOX)?.[0]).toBeUndefined()
  })

  it('the only plate left is the credit chip (kept: FUNCTIONAL-CONTAINERS 19)', () => {
    const photos = readFileSync(join(root, 'photos', 'PhotoCredit.tsx'), 'utf8')
    expect(photos).toMatch(/ts-v2-plate/)
  })

  const stat = (p: string) => statSync(p).isFile()
  it('the shell has no solid mobile column and no rounded pill left (D2)', () => {
    expect(files.filter((x) => /AppShell/.test(x.f)).every((x) => !/bg-v2-bg sm:bg-transparent/.test(x.src))).toBe(true)
    expect(stat(join(root, 'shell', 'AppShell.tsx'))).toBe(true)
  })
})
