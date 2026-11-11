// @vitest-environment jsdom
/**
 * [ADR-025] Scroll narrative, commit 1 (round-6 MOTION-SPEC §2, §3, §6): the section → photo map, the 40 % line, the
 * IntersectionObserver-only trigger, the lazy photo requests and the credit that follows the active photo. The browser
 * pieces (IntersectionObserver, matchMedia, layout) are mocked at the edge, so the rects the picker sees are the test's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { escapeRegExp } from '@/test-utils/escape-regexp'
import { NARRATIVE_PHOTOS } from '../photos/narrative'
import { activeLayers, crossingIO, installBrowser, layer, mountPage, nearIO, scrollTo, section, setMobile, VH } from './narrative-harness'
import {
  ACTIVE_LINE,
  ACTIVE_THRESHOLDS,
  NARRATIVE_SECTIONS,
  NEAR_ROOT_MARGIN,
  PHOTO_SETTLE_MS,
  SECTION_PHOTO,
  STILL_PHOTO,
  photoFor,
  photosFor,
  pickActive,
  type SectionRect,
} from './narrative'

// ── pure picker ────────────────────────────────────────────────────────────────────────────────────────────────

/** `y` that puts section `id` at the top of the viewport. */
const atTop = (id: (typeof NARRATIVE_SECTIONS)[number]) => -900 * NARRATIVE_SECTIONS.indexOf(id)

/** Nine stacked 900 px sections (the whole landing) starting at `y` (the hero's top edge relative to the viewport). */
function rectsAt(y: number): SectionRect[] {
  return NARRATIVE_SECTIONS.map((id, i) => ({ id, top: y + i * 900, bottom: y + (i + 1) * 900 }))
}

describe('pickActive (mocked rects, 800 px viewport, line at 320 px)', () => {
  it('the section crossing the 40 % line is active', () => {
    expect(ACTIVE_LINE).toBe(0.4)
    const expected = ['overpass', 'tunnel', 'zakim', 'highway', 'footbridge', 'tunnel', 'archlight', 'highway', 'underpass']
    expect(NARRATIVE_SECTIONS.map((id) => pickActive(rectsAt(atTop(id)), VH, false).photo)).toEqual(expected)
  })

  it('switches exactly when the next section\'s top passes the line (320 px), not before', () => {
    expect(pickActive(rectsAt(-579.5), VH, false).photo).toBe('overpass') // performance top at 320.5: still below the line
    expect(pickActive(rectsAt(-580), VH, false).photo).toBe('tunnel') // top at 320 = on the line
  })

  it('a narrative section still below the line is pre-selected while it enters (no flat gap)', () => {
    const rects: SectionRect[] = [{ id: 'security', top: 500, bottom: 1400 }]
    expect(pickActive(rects, VH, false).photo).toBe('highway')
  })

  it('nothing is active when no narrative section is on screen (past the docs, the opaque footer owns the viewport)', () => {
    expect(pickActive([{ id: 'security', top: 2000, bottom: 2900 }], VH, false).photo).toBeNull()
    expect(pickActive([{ id: 'docs', top: -3000, bottom: -100 }], VH, false).photo).toBeNull()
  })

  it('a section that ended above the line with none below it in view → null', () => {
    expect(pickActive([{ id: 'roadmap', top: -900, bottom: 100 }], VH, false).photo).toBeNull() // bottom 100 < line 320, none below
  })

  it('the LAST section wins once it is entirely in view, even if it never reaches the line (short docs row above the footer)', () => {
    // 900 px viewport: the line is at 360. The docs row is 250 px tall at top 600, so its top never gets above the line on a page that ends here.
    const rects: SectionRect[] = [
      { id: 'cta', top: -400, bottom: 600 },
      { id: 'docs', top: 600, bottom: 850 },
    ]
    expect(pickActive(rects, 900, false).photo).toBe('underpass')
    // not yet entirely in view (bottom below the viewport): the section crossing the line still owns it
    expect(pickActive([{ id: 'cta', top: -400, bottom: 700 }, { id: 'docs', top: 700, bottom: 950 }], 900, false).photo).toBe('highway')
    // a tall last section is not "whole in view": the 40 % line rule applies as before
    expect(pickActive([{ id: 'cta', top: -2000, bottom: 100 }, { id: 'docs', top: 100, bottom: 1500 }], 900, false).photo).toBe('underpass')
    expect(pickActive([{ id: 'cta', top: -900, bottom: 500 }, { id: 'docs', top: 500, bottom: 1500 }], 900, false).photo).toBe('highway')
  })

  it('uses the mobile map at ≤ 600 px', () => {
    expect(pickActive(rectsAt(atTop('experience')), VH, true).photo).toBe('highway') // experience shares the previous section's photo on mobile
    expect(pickActive(rectsAt(atTop('roadmap')), VH, true).photo).toBe('tunnel') // roadmap shares features'
  })
})

// ── the shipped map ────────────────────────────────────────────────────────────────────────────────────────────

describe('section → photo map (MOTION-SPEC §2)', () => {
  it('desktop: all 9 landing sections, 7 distinct photos, no two neighbours share one (every boundary fades)', () => {
    const photos = NARRATIVE_SECTIONS.map((s) => photoFor(s, false))
    expect(photos).toEqual(['overpass', 'tunnel', 'zakim', 'highway', 'footbridge', 'tunnel', 'archlight', 'highway', 'underpass'])
    expect(NARRATIVE_SECTIONS).toHaveLength(9)
    expect(new Set(photos).size).toBe(7)
    photos.slice(1).forEach((p, i) => expect(p, `${NARRATIVE_SECTIONS[i]} → ${NARRATIVE_SECTIONS[i + 1]}`).not.toBe(photos[i]))
    expect(photosFor(false)).toEqual(['overpass', 'tunnel', 'zakim', 'highway', 'footbridge', 'archlight', 'underpass'])
  })

  it('mobile ≤ 600 px: 5 photos; a section that repeats its neighbour\'s photo does not fade', () => {
    const photos = NARRATIVE_SECTIONS.map((s) => photoFor(s, true))
    expect(photos).toEqual(['overpass', 'tunnel', 'zakim', 'highway', 'highway', 'tunnel', 'tunnel', 'highway', 'underpass'])
    expect(photosFor(true)).toEqual(['overpass', 'tunnel', 'zakim', 'highway', 'underpass'])
    // the same files the four opaque stills used to request on a phone, plus the docs photo: moving them into the stack adds no file
    expect(new Set(photosFor(true))).toEqual(new Set([...Object.values(STILL_PHOTO), 'underpass']))
  })

  it('every mapped photo ships, with its photographer', () => {
    const names = Object.fromEntries(Object.values(NARRATIVE_PHOTOS).map((p) => [p.id, p.photographer]))
    expect(names).toEqual({
      highway: 'Oleksiy Yeshtokyn',
      footbridge: 'Erik Mclean',
      tunnel: 'Владимир Николаевич',
      archlight: 'wal_ 172619',
      underpass: 'Willbone Gallery',
      // round 7 (owner addition): the app shell's per-tab photos share this set
      zakim: 'Phil Evenden',
      archnight: 'Peter Dyllong',
      overpass: 'MAG Photography',
    })
    for (const s of NARRATIVE_SECTIONS) for (const k of ['desktop', 'mobile'] as const) expect(NARRATIVE_PHOTOS[SECTION_PHOTO[s][k]]).toBeDefined()
  })
})

// ── the stack in a (mocked) browser ───────────────────────────────────────────────────────────────────────────

const settle = () => act(() => crossingIO().fire([]))

beforeEach(() => installBrowser())
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
    expect(crossingIO().observed.size).toBe(9)
    expect(nearIO().observed.size).toBe(9)
  })

  it('scroll 0: seven layers; only the hero\'s overpass has an image (it is on screen), and it is active and credited', () => {
    mountPage()
    expect(document.querySelectorAll('.ts-v2-nar__layer')).toHaveLength(7)
    for (const l of document.querySelectorAll('.ts-v2-nar__layer')) {
      const hero = l.getAttribute('data-photo') === 'overpass'
      expect(l.hasAttribute('data-loaded'), l.getAttribute('data-photo')!).toBe(hero)
      expect(l.getAttribute('style') === null, l.getAttribute('data-photo')!).toBe(!hero)
    }
    // no other photo URL exists in the DOM
    expect(document.body.innerHTML.match(/bg-[a-z]+-\d+/g)!.every((m) => m.startsWith('bg-overpass-'))).toBe(true)
    expect(activeLayers()).toEqual(['overpass'])
    expect(document.querySelector('.ts-v2-nar-credit')!.hasAttribute('data-active')).toBe(true)
    expect(document.querySelector('.ts-v2-nar-credit')!.textContent).toBe('Photo MAG Photography / Pexels')
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
    for (const [id, photo] of [
      ['hero', 'overpass'],
      ['performance', 'tunnel'],
      ['why-teraswap', 'zakim'],
      ['security', 'highway'],
      ['experience', 'footbridge'],
      ['features', 'tunnel'],
      ['roadmap', 'archlight'],
      ['cta', 'highway'],
      ['docs', 'underpass'],
    ] as const) {
      scrollTo(atTop(id))
      settle()
      seen.push(activeLayers())
      expect(activeLayers()).toEqual([photo])
      expect(layer(photo)!.hasAttribute('data-loaded')).toBe(true) // the active photo is always requested
    }
    // scrolled past everything: nothing active → the layers fade out and the opaque footer owns the viewport
    scrollTo(-9000)
    settle()
    expect(activeLayers()).toEqual([])
  })

  it('the layer a photo replaces is `data-leaving` in the same commit (so its fade + scale run), then released after the scale', () => {
    vi.useFakeTimers()
    try {
      const leavingLayers = () => Array.from(document.querySelectorAll('.ts-v2-nar__layer[data-leaving]')).map((l) => l.getAttribute('data-photo'))
      mountPage()
      scrollTo(0)
      settle()
      expect(activeLayers()).toEqual(['overpass'])
      expect(leavingLayers()).toEqual([]) // nothing was replaced yet

      scrollTo(atTop('performance')) // the FIRST boundary, hero → Performance, fades like every later one
      settle()
      expect(activeLayers()).toEqual(['tunnel'])
      expect(leavingLayers()).toEqual(['overpass']) // never a commit where overpass is neither active nor leaving

      scrollTo(atTop('why-teraswap')) // a second switch inside the settle window: both outgoing layers keep their transition
      settle()
      expect(leavingLayers().sort()).toEqual(['overpass', 'tunnel'])

      act(() => void vi.advanceTimersByTime(PHOTO_SETTLE_MS))
      expect(leavingLayers()).toEqual([])
      expect(activeLayers()).toEqual(['zakim'])

      scrollTo(-9000) // nothing active: the last photo leaves
      settle()
      expect(activeLayers()).toEqual([])
      expect(leavingLayers()).toEqual(['zakim'])

      scrollTo(atTop('why-teraswap')) // scrolling back to a leaving photo makes it active again, not leaving
      settle()
      expect(activeLayers()).toEqual(['zakim'])
      expect(leavingLayers()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('PHOTO_SETTLE_MS outlasts --t-photo-scale (the slowest layer transition) by a margin, not by a magic number', () => {
    const tokens = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')
    const scaleMs = Number(/--t-photo-scale:(\d+)ms/.exec(tokens)![1])
    expect(PHOTO_SETTLE_MS).toBeGreaterThan(scaleMs)
    expect(PHOTO_SETTLE_MS - scaleMs).toBeLessThanOrEqual(200)
  })

  it('the credit follows the active photo (and keeps the last name while it fades out)', () => {
    mountPage()
    const credit = () => document.querySelector('.ts-v2-nar-credit')!
    scrollTo(atTop('experience'))
    settle()
    expect(credit().textContent).toBe('Photo Erik Mclean / Pexels')
    expect(credit().hasAttribute('data-active')).toBe(true)
    expect(credit().hasAttribute('aria-hidden')).toBe(false)
    scrollTo(atTop('roadmap'))
    settle()
    expect(credit().textContent).toBe('Photo wal_ 172619 / Pexels')
    scrollTo(-9000)
    settle()
    expect(credit().hasAttribute('data-active')).toBe(false)
    expect(credit().getAttribute('aria-hidden')).toBe('true') // invisible → not announced
    expect(credit().textContent).toBe('Photo wal_ 172619 / Pexels')
  })

  it('mobile ≤ 600 px: five layers, and requesting every section never loads more than five photos', () => {
    setMobile(true)
    mountPage()
    expect(Array.from(document.querySelectorAll('.ts-v2-nar__layer')).map((l) => l.getAttribute('data-photo'))).toEqual(['overpass', 'tunnel', 'zakim', 'highway', 'underpass'])
    act(() => nearIO().fire(NARRATIVE_SECTIONS.map((id) => ({ target: section(id), isIntersecting: true }))))
    expect(document.querySelectorAll('.ts-v2-nar__layer[data-loaded]')).toHaveLength(5)
    expect(document.body.innerHTML).not.toMatch(/footbridge|archlight/)
  })

  it('no IntersectionObserver (old browser, jsdom SSR check): renders the stack on the hero photo and does not throw', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    expect(() => mountPage()).not.toThrow()
    expect(activeLayers()).toEqual(['overpass']) // the server-rendered state: nothing moves it without an observer
  })
})

describe('narrative.css (what is allowed to animate)', () => {
  const CSS = readFileSync(join(__dirname, 'narrative.css'), 'utf8')
  const rule = (sel: string) => new RegExp(`${escapeRegExp(sel)}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? ''

  it('layer states: idle has no transition; active and leaving carry opacity 900 ms (--t-photo, --ease-inout) + transform 1600 ms (--t-photo-scale, --ease-out)', () => {
    const idle = rule('.ts-v2-nar__layer')
    expect(idle).toMatch(/opacity:\s*0/)
    expect(idle).toMatch(/transform:\s*scale\(1\.04\)/) // rest: the incoming layer starts here
    expect(idle).not.toMatch(/transition|animation|will-change|filter/) // the move back to idle never animates
    const moving = rule('.ts-v2-nar__layer[data-active], .ts-v2-nar__layer[data-leaving]')
    const transitions = Array.from(moving.matchAll(/transition:\s*([^;]+);/g)).map((m) => m[1].trim())
    expect(transitions).toEqual(['opacity var(--t-photo) var(--ease-inout), transform var(--t-photo-scale) var(--ease-out)'])
    expect(CSS).not.toMatch(/var\(--t-slow\)/) // the 180 ms token is not used anywhere in the stack any more
  })

  it('incoming settles 1.04 → 1.00, outgoing drifts 1.00 → 1.03: opacity + transform only', () => {
    expect(rule('.ts-v2-nar__layer[data-active]')).toMatch(/opacity:\s*1;\s*transform:\s*scale\(1\)/)
    // its own rule (the combined `[data-active], [data-leaving]` selector above only carries the transition)
    expect(/\n\.ts-v2-nar__layer\[data-leaving\]\s*\{\s*transform:\s*scale\(1\.03\);\s*\}/.test(CSS)).toBe(true)
    expect(CSS).not.toMatch(/@keyframes|animation/) // plain transitions: a keyframe hand-off to a transition does not run in Chromium
  })

  it('the veil is a constant: BG at alpha 45/255, no transition, never toggled', () => {
    expect(CSS).toMatch(/--nar-veil:\s*rgba\(11, 13, 15, 0\.176\)/)
    expect(Math.round(0.176 * 255)).toBe(45)
    expect(rule('.ts-v2-nar__veil')).toMatch(/background:\s*var\(--nar-veil\)/)
    expect(rule('.ts-v2-nar__veil')).not.toMatch(/transition|opacity/)
  })

  it('credit: desktop right 32 px / bottom 70 px, centred on its baseline (translateY 50%); hidden at ≤ 600 px', () => {
    const credit = rule('.ts-v2-nar-credit')
    expect(credit).toMatch(/position:\s*fixed/)
    expect(credit).toMatch(/right:\s*32px/)
    expect(credit).toMatch(/bottom:\s*70px/)
    expect(credit).toMatch(/transform:\s*translateY\(50%\)/)
    expect(credit).toMatch(/z-index:\s*12/) // over the section wrapper (z-10): a card must not cover it; under the header (z-20)
    expect(credit).toMatch(/transition:\s*opacity var\(--t-photo\) var\(--ease-inout\)/) // fades with the photo's token
    const mobile = /@media \(max-width: 600px\)\s*\{\s*\.ts-v2-nar-credit\s*\{([^}]*)\}/.exec(CSS)![1]
    expect(mobile).toMatch(/display:\s*none/)
    expect(mobile).not.toMatch(/bottom|left|right/) // no mobile placement left to collide with the cards
  })

  it('no scroll-linked effects: no scroll-snap, scroll-timeline, parallax, or background-attachment', () => {
    expect(CSS).not.toMatch(/scroll-snap|scroll-timeline|animation-timeline|background-attachment|parallax/)
  })
})
