// @vitest-environment jsdom
/**
 * [ADR-025] Scroll narrative, commit 1 (round-6 MOTION-SPEC §2, §3, §6): the section → photo map, the 40 % line, the
 * IntersectionObserver-only trigger, the lazy photo requests and the credit that follows the active photo. The browser
 * pieces (IntersectionObserver, matchMedia, layout) are mocked at the edge, so the rects the picker sees are the test's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NARRATIVE_PHOTOS } from '../photos/narrative'
import { NarrativeStack } from './NarrativeStack'
import {
  ACTIVE_LINE,
  ACTIVE_THRESHOLDS,
  NARRATIVE_SECTIONS,
  NEAR_ROOT_MARGIN,
  SECTION_PHOTO,
  photoFor,
  photosFor,
  pickActive,
  type NarrativeSectionId,
  type SectionRect,
} from './narrative'

const VH = 800

// ── pure picker ────────────────────────────────────────────────────────────────────────────────────────────────

/** Five stacked 900 px sections starting at `y` (their top edge relative to the viewport). */
function rectsAt(y: number): SectionRect[] {
  return NARRATIVE_SECTIONS.map((id, i) => ({ id, top: y + i * 900, bottom: y + (i + 1) * 900 }))
}

describe('pickActive (mocked rects, 800 px viewport, line at 320 px)', () => {
  it('the section crossing the 40 % line is active', () => {
    expect(ACTIVE_LINE).toBe(0.4)
    expect(pickActive(rectsAt(0), VH, false).photo).toBe('highway') // security 0–900
    expect(pickActive(rectsAt(-900), VH, false).photo).toBe('footbridge')
    expect(pickActive(rectsAt(-1800), VH, false).photo).toBe('tunnel')
    expect(pickActive(rectsAt(-2700), VH, false).photo).toBe('archlight')
    expect(pickActive(rectsAt(-3600), VH, false).photo).toBe('underpass')
  })

  it('switches exactly when the next section\'s top passes the line (320 px), not before', () => {
    expect(pickActive(rectsAt(-579.5), VH, false).photo).toBe('highway') // experience top at 320.5: still below the line
    expect(pickActive(rectsAt(-580), VH, false).photo).toBe('footbridge') // top at 320 = on the line
  })

  it('a narrative section still below the line is pre-selected while it enters (no flat gap)', () => {
    const rects: SectionRect[] = [{ id: 'security', top: 500, bottom: 1400 }]
    expect(pickActive(rects, VH, false).photo).toBe('highway')
  })

  it('nothing is active when no narrative section is on screen (the opaque sections own the viewport)', () => {
    expect(pickActive([{ id: 'security', top: 2000, bottom: 2900 }], VH, false).photo).toBeNull()
    expect(pickActive([{ id: 'docs', top: -3000, bottom: -100 }], VH, false).photo).toBeNull()
  })

  it('an opaque section crossing the line with no narrative section below it in view → null', () => {
    expect(pickActive([{ id: 'roadmap', top: -900, bottom: 100 }], VH, false).photo).toBeNull() // bottom 100 < line 320, none below
  })

  it('uses the mobile map at ≤ 600 px', () => {
    expect(pickActive(rectsAt(-900), VH, true).photo).toBe('highway') // experience shares security's photo on mobile
    expect(pickActive(rectsAt(-2700), VH, true).photo).toBe('tunnel') // roadmap shares features'
  })
})

// ── the shipped map ────────────────────────────────────────────────────────────────────────────────────────────

describe('section → photo map (MOTION-SPEC §2)', () => {
  it('desktop: 5 sections, 5 distinct photos, no two neighbours share one', () => {
    const photos = NARRATIVE_SECTIONS.map((s) => photoFor(s, false))
    expect(photos).toEqual(['highway', 'footbridge', 'tunnel', 'archlight', 'underpass'])
    expect(new Set(photos).size).toBe(5)
    expect(photosFor(false)).toEqual(photos)
  })

  it('mobile ≤ 600 px: at most 3 photos; a section that repeats its neighbour\'s photo does not fade', () => {
    const photos = NARRATIVE_SECTIONS.map((s) => photoFor(s, true))
    expect(photos).toEqual(['highway', 'highway', 'tunnel', 'tunnel', 'underpass'])
    expect(photosFor(true)).toEqual(['highway', 'tunnel', 'underpass'])
    expect(photosFor(true).length).toBeLessThanOrEqual(3)
  })

  it('every mapped photo ships, with its photographer', () => {
    const names = Object.fromEntries(Object.values(NARRATIVE_PHOTOS).map((p) => [p.id, p.photographer]))
    expect(names).toEqual({
      highway: 'Oleksiy Yeshtokyn',
      footbridge: 'Erik Mclean',
      tunnel: 'Владимир Николаевич',
      archlight: 'wal_ 172619',
      underpass: 'Willbone Gallery',
    })
    for (const s of NARRATIVE_SECTIONS) for (const k of ['desktop', 'mobile'] as const) expect(NARRATIVE_PHOTOS[SECTION_PHOTO[s][k]]).toBeDefined()
  })
})

// ── the stack in a (mocked) browser ───────────────────────────────────────────────────────────────────────────

class MockIO {
  static all: MockIO[] = []
  observed = new Set<Element>()
  constructor(
    public cb: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    MockIO.all.push(this)
  }
  observe = (el: Element) => void this.observed.add(el)
  unobserve = (el: Element) => void this.observed.delete(el)
  disconnect = () => void this.observed.clear()
  takeRecords = () => []
  fire(entries: Partial<IntersectionObserverEntry>[]) {
    this.cb(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}
const nearIO = () => MockIO.all.find((o) => o.options?.rootMargin === NEAR_ROOT_MARGIN)!
const crossingIO = () => MockIO.all.find((o) => Array.isArray(o.options?.threshold))!

let mobile = false
const rects: Partial<Record<NarrativeSectionId, { top: number; bottom: number }>> = {}
const scrollTo = (y: number) => NARRATIVE_SECTIONS.forEach((id, i) => (rects[id] = { top: y + i * 900, bottom: y + (i + 1) * 900 }))
const section = (id: string) => document.querySelector<HTMLElement>(`[data-ts-narrative="${id}"]`)!

function mountPage() {
  return render(
    <div data-ts-landing="">
      <NarrativeStack />
      <main>
        {NARRATIVE_SECTIONS.map((id) => (
          <section key={id} id={id} data-ts-narrative={id} />
        ))}
      </main>
    </div>,
  )
}
const layer = (id: string) => document.querySelector<HTMLElement>(`.ts-v2-nar__layer[data-photo="${id}"]`)
const activeLayers = () => Array.from(document.querySelectorAll('.ts-v2-nar__layer[data-active]')).map((l) => l.getAttribute('data-photo'))
const settle = () => act(() => crossingIO().fire([]))

beforeEach(() => {
  MockIO.all = []
  mobile = false
  vi.stubGlobal('IntersectionObserver', MockIO)
  vi.stubGlobal('innerHeight', VH)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('600px') ? mobile : false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = rects[this.getAttribute('data-ts-narrative') as NarrativeSectionId] ?? { top: 99999, bottom: 100899 }
    return { ...r, left: 0, right: 0, width: 0, height: r.bottom - r.top, x: 0, y: r.top, toJSON: () => ({}) }
  })
  scrollTo(2400) // scroll 0: the first narrative section starts well below the first screen
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NarrativeStack: observers and lazy photos', () => {
  it('uses IntersectionObserver only — no scroll or wheel listener anywhere', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const addDoc = vi.spyOn(document, 'addEventListener')
    mountPage()
    const events = [...add.mock.calls, ...addDoc.mock.calls].map((c) => c[0])
    expect(events).not.toContain('scroll')
    expect(events).not.toContain('wheel')
    expect(events).not.toContain('touchmove')
    expect(crossingIO().options?.threshold).toEqual([...ACTIVE_THRESHOLDS])
    expect(ACTIVE_THRESHOLDS).toHaveLength(21)
    expect(NEAR_ROOT_MARGIN).toBe('0px 0px 100% 0px')
    expect(crossingIO().observed.size).toBe(5)
    expect(nearIO().observed.size).toBe(5)
  })

  it('scroll 0: five layers, none with an image — no bg-* URL exists in the DOM, nothing is active or credited', () => {
    mountPage()
    expect(document.querySelectorAll('.ts-v2-nar__layer')).toHaveLength(5)
    for (const l of document.querySelectorAll('.ts-v2-nar__layer')) {
      expect(l.hasAttribute('data-loaded')).toBe(false)
      expect(l.getAttribute('style')).toBeNull()
    }
    expect(document.body.innerHTML).not.toMatch(/bg-|\.avif|\.webp|image-set/)
    expect(activeLayers()).toEqual([])
    expect(document.querySelector('.ts-v2-nar-credit')!.hasAttribute('data-active')).toBe(false)
  })

  it('a layer gets image-set(AVIF, WebP) at both sizes only when its section is within one viewport', () => {
    mountPage()
    act(() => nearIO().fire([{ target: section('security'), isIntersecting: true }]))
    const highway = layer('highway')!
    expect(highway.hasAttribute('data-loaded')).toBe(true)
    const style = highway.getAttribute('style')!
    expect(style).toMatch(/--nar-d: image-set\(url\("[^"]*bg-highway-1920\.avif"\) type\("image\/avif"\), url\("[^"]*bg-highway-1920\.webp"\) type\("image\/webp"\)\)/)
    expect(style).toMatch(/--nar-m: image-set\(url\("[^"]*bg-highway-1080\.avif"\) type\("image\/avif"\), url\("[^"]*bg-highway-1080\.webp"\) type\("image\/webp"\)\)/)
    expect(layer('footbridge')!.hasAttribute('data-loaded')).toBe(false)
    // not intersecting → nothing new
    act(() => nearIO().fire([{ target: section('docs'), isIntersecting: false }]))
    expect(layer('underpass')!.hasAttribute('data-loaded')).toBe(false)
  })

  it('exactly one layer is active; it follows the section crossing the line and the others fade out', () => {
    mountPage()
    const seen: (string | null)[][] = []
    for (const [y, expected] of [
      [0, ['highway']],
      [-900, ['footbridge']],
      [-1800, ['tunnel']],
      [-2700, ['archlight']],
      [-3600, ['underpass']],
    ] as const) {
      scrollTo(y)
      settle()
      seen.push(activeLayers())
      expect(activeLayers()).toEqual(expected)
      expect(layer(expected[0])!.hasAttribute('data-loaded')).toBe(true) // the active photo is always requested
    }
    // scrolled past everything: nothing active → the layers fade out and the opaque sections own the viewport
    scrollTo(-6000)
    settle()
    expect(activeLayers()).toEqual([])
  })

  it('the credit follows the active photo (and keeps the last name while it fades out)', () => {
    mountPage()
    const credit = () => document.querySelector('.ts-v2-nar-credit')!
    scrollTo(-900)
    settle()
    expect(credit().textContent).toBe('Photo Erik Mclean / Pexels')
    expect(credit().hasAttribute('data-active')).toBe(true)
    scrollTo(-2700)
    settle()
    expect(credit().textContent).toBe('Photo wal_ 172619 / Pexels')
    scrollTo(-6000)
    settle()
    expect(credit().hasAttribute('data-active')).toBe(false)
    expect(credit().textContent).toBe('Photo wal_ 172619 / Pexels')
  })

  it('mobile ≤ 600 px: three layers, and requesting every section never loads more than three photos', () => {
    mobile = true
    mountPage()
    expect(Array.from(document.querySelectorAll('.ts-v2-nar__layer')).map((l) => l.getAttribute('data-photo'))).toEqual(['highway', 'tunnel', 'underpass'])
    act(() => nearIO().fire(NARRATIVE_SECTIONS.map((id) => ({ target: section(id), isIntersecting: true }))))
    expect(document.querySelectorAll('.ts-v2-nar__layer[data-loaded]')).toHaveLength(3)
    expect(document.body.innerHTML).not.toMatch(/footbridge|archlight/)
  })

  it('no IntersectionObserver (old browser, jsdom SSR check): renders the inert stack and does not throw', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    expect(() => mountPage()).not.toThrow()
    expect(activeLayers()).toEqual([])
  })
})

describe('narrative.css (what is allowed to animate)', () => {
  const CSS = readFileSync(join(__dirname, 'narrative.css'), 'utf8')
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? ''

  it('a layer animates only `opacity`, with --t-slow and --ease-inout', () => {
    const layerRule = rule('.ts-v2-nar__layer')
    const transitions = Array.from(layerRule.matchAll(/transition:\s*([^;]+);/g)).map((m) => m[1].trim())
    expect(transitions).toEqual(['opacity var(--t-slow) var(--ease-inout)'])
    expect(layerRule).not.toMatch(/transform|filter|animation|will-change/)
  })

  it('the veil is a constant: BG at alpha 45/255, no transition, never toggled', () => {
    expect(CSS).toMatch(/--nar-veil:\s*rgba\(11, 13, 15, 0\.176\)/)
    expect(Math.round(0.176 * 255)).toBe(45)
    expect(rule('.ts-v2-nar__veil')).toMatch(/background:\s*var\(--nar-veil\)/)
    expect(rule('.ts-v2-nar__veil')).not.toMatch(/transition|opacity/)
  })

  it('no scroll-linked effects: no scroll-snap, scroll-timeline, parallax, or background-attachment', () => {
    expect(CSS).not.toMatch(/scroll-snap|scroll-timeline|animation-timeline|background-attachment|parallax/)
  })
})
