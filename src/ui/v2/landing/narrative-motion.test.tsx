// @vitest-environment jsdom
/**
 * [ADR-025] Scroll narrative, commit 2 (round-6 MOTION-SPEC §4, §5): the once-only entrance (12 px + fade, 160 ms,
 * 40 ms stagger capped at index 4, underline 600 ms after --t-base), sections already above the line shown at once, and
 * the three preference modes — prefers-reduced-motion (photos painted on the sections, no stack, text immediate) and
 * reduced transparency / more contrast / forced colours (flat --bg, no photo). matchMedia is mocked per query.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeLayers,
  crossingIO,
  enterIO,
  installBrowser,
  mountPage,
  nearIO,
  scrollTo,
  section,
  setMedia,
  setMobile,
} from './narrative-harness'
import {
  ENTER_ROOT_MARGIN,
  FLAT_QUERIES,
  NARRATIVE_SECTIONS,
  REDUCED_MOTION_QUERY,
  STAGGER_MAX_INDEX,
  STAGGER_MS,
  staggerDelayMs,
} from './narrative'

const CSS = readFileSync(join(__dirname, 'narrative.css'), 'utf8')
const TOKENS = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')

beforeEach(() => installBrowser())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const entered = () => NARRATIVE_SECTIONS.filter((id) => section(id).hasAttribute('data-nar-in'))
const settle = () => act(() => crossingIO().fire([]))
const nearAll = () => act(() => nearIO().fire(NARRATIVE_SECTIONS.map((id) => ({ target: section(id), isIntersecting: true }))))

describe('entrance: plays once when the section crosses the 40 % line', () => {
  it('takes the sections over (data-nar-js) and shows none below the line', () => {
    mountPage()
    for (const id of NARRATIVE_SECTIONS) expect(section(id).hasAttribute('data-nar-js')).toBe(true)
    expect(entered()).toEqual([])
    expect(enterIO().options?.rootMargin).toBe(ENTER_ROOT_MARGIN)
    expect(ENTER_ROOT_MARGIN).toBe('-40% 0px -60% 0px')
  })

  it('crossing the line shows the section and unobserves it — once, never replayed', () => {
    mountPage()
    expect(enterIO().observed.has(section('security'))).toBe(true)
    act(() => enterIO().fire([{ target: section('security'), isIntersecting: true }]))
    expect(entered()).toEqual(['security'])
    expect(enterIO().observed.has(section('security'))).toBe(false)
    expect(enterIO().observed.size).toBe(4)
    // a section that is not crossing stays hidden
    act(() => enterIO().fire([{ target: section('docs'), isIntersecting: false }]))
    expect(section('docs').hasAttribute('data-nar-in')).toBe(false)
  })

  it('a section already above the line on load (deep link) is shown at once, and is not observed', () => {
    scrollTo(-1000) // security −1000…−100, experience −100…800 (crossing), features 800…
    mountPage()
    expect(entered()).toEqual(['security', 'experience'])
    expect(enterIO().observed.has(section('security'))).toBe(false)
    expect(enterIO().observed.has(section('features'))).toBe(true)
  })

  it('a section jumped over without ever crossing the line is still shown (no hidden content left behind)', () => {
    mountPage()
    scrollTo(-3000)
    settle()
    expect(entered()).toEqual(['security', 'experience', 'features', 'roadmap'])
    expect(section('docs').hasAttribute('data-nar-in')).toBe(false)
  })

  it('stagger: 40 ms per element, capped at index 4 — the last starts at 160 ms, the sequence ends by 320 ms', () => {
    expect(STAGGER_MS).toBe(40)
    expect(STAGGER_MAX_INDEX).toBe(4)
    expect([0, 1, 2, 3, 4, 5, 8, 20].map(staggerDelayMs)).toEqual([0, 40, 80, 120, 160, 160, 160, 160])
    expect(staggerDelayMs(99) + 160).toBe(320)
    expect(CSS).toMatch(/--stagger:\s*40ms;\s*--stagger-max:\s*4;/)
    expect(CSS).toMatch(/transition-delay:\s*calc\(min\(var\(--i,\s*0\),\s*var\(--stagger-max\)\)\s*\*\s*var\(--stagger\)\)/)
  })

  it('motion: opacity 0 + translateY(12px) → in, --t-base on --ease-out; the tokens carry 160 ms / the curve', () => {
    expect(CSS).toMatch(/--enter-y:\s*12px/)
    expect(CSS).toMatch(/\[data-nar-js\] \.ts-v2-rv\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(var\(--enter-y\)\);\s*\}/)
    expect(CSS).toMatch(/transition:\s*opacity var\(--t-base\) var\(--ease-out\),\s*transform var\(--t-base\) var\(--ease-out\)/)
    expect(TOKENS).toMatch(/--t-base:160ms/)
    expect(TOKENS).toMatch(/--ease-out:cubic-bezier\(0\.2,0\.8,0\.2,1\)/)
  })

  it('underline: clip-reveals once over --t-underline (600 ms), starting after --t-base; no looping animation', () => {
    expect(CSS).toMatch(/h2 svg\s*\{\s*clip-path:\s*inset\(-50% 100% -50% -4px\);\s*\}/)
    expect(CSS).toMatch(/transition:\s*clip-path var\(--t-underline\) var\(--ease-out\) var\(--t-base\)/)
    expect(TOKENS).toMatch(/--t-underline:600ms/)
    // the only keyframe in the file is the photo layer's one-shot settle (narrative.test.tsx pins it); nothing loops
    expect(CSS).not.toMatch(/infinite|animation-iteration-count/)
    expect(Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1])).toEqual(['ts-v2-nar-in'])
    expect(Array.from(CSS.matchAll(/(?<![\w-])animation:\s*([^;}]+)/g), (m) => m[1].split(' ')[0])).toEqual(['ts-v2-nar-in'])
  })

  it('without IntersectionObserver nothing is hidden (no data-nar-js)', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    mountPage()
    for (const id of NARRATIVE_SECTIONS) expect(section(id).hasAttribute('data-nar-js')).toBe(false)
  })
})

describe('prefers-reduced-motion: no stack, photos painted on the sections, text immediate', () => {
  beforeEach(() => setMedia(REDUCED_MOTION_QUERY, true))

  it('renders no fixed stack and no fixed credit', () => {
    mountPage()
    expect(document.querySelector('.ts-v2-nar')).toBeNull()
    expect(document.querySelector('.ts-v2-nar-credit')).toBeNull()
    expect(activeLayers()).toEqual([])
  })

  it('shows every section at once (text immediate), including those far below', () => {
    mountPage()
    expect(entered()).toEqual([...NARRATIVE_SECTIONS])
  })

  it('a section paints its photo + the constant veil only once it is within one viewport; far sections request nothing', () => {
    mountPage()
    expect(document.body.innerHTML).not.toMatch(/bg-|image-set/)
    act(() => nearIO().fire([{ target: section('experience'), isIntersecting: true }]))
    const style = section('experience').getAttribute('style')!
    expect(section('experience').hasAttribute('data-nar-static')).toBe(true)
    expect(style).toMatch(/--nar-d: image-set\(url\("[^"]*bg-footbridge-1920\.avif"\) type\("image\/avif"\), url\("[^"]*bg-footbridge-1920\.webp"\) type\("image\/webp"\)\)/)
    expect(style).toMatch(/--nar-m: image-set\(url\("[^"]*bg-footbridge-1080\.avif"\)/) // desktop map here: the size var follows the photo
    expect(section('docs').hasAttribute('data-nar-static')).toBe(false)
    expect(section('docs').getAttribute('style')).toBeNull()
    expect(CSS).toMatch(/\[data-nar-static\]\s*\{\s*background:\s*linear-gradient\(var\(--nar-veil\), var\(--nar-veil\)\), var\(--nar-d\) center \/ cover no-repeat/)
  })

  it('mobile uses the mobile map (experience shares the Highway photo, so no second file)', () => {
    setMobile(true)
    mountPage()
    nearAll()
    expect(section('experience').getAttribute('style')).toMatch(/--nar-m: image-set\(url\("[^"]*bg-highway-1080\.avif/)
    expect(document.body.innerHTML).not.toMatch(/footbridge|archlight/)
  })

  it('CSS: text and underline are static (no transform, transition or clip), the stack and credit are hidden', () => {
    const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS)![1]
    expect(rm).toMatch(/\.ts-v2-nar, \.ts-v2-nar-credit\s*\{\s*display:\s*none;/)
    expect(rm).toMatch(/\.ts-v2-rv\s*\{\s*opacity:\s*1 !important;\s*transform:\s*none !important;\s*transition:\s*none !important;/)
    expect(rm).toMatch(/h2 svg\s*\{\s*clip-path:\s*none !important;\s*transition:\s*none !important;/)
    expect(TOKENS).toMatch(/--t-underline:0ms/)
  })

  it('turning it on while the page is open removes the stack and shows the text; turning it off brings the stack back', () => {
    setMedia(REDUCED_MOTION_QUERY, false)
    mountPage()
    expect(document.querySelector('.ts-v2-nar')).not.toBeNull()
    expect(entered()).toEqual([])
    act(() => setMedia(REDUCED_MOTION_QUERY, true))
    expect(document.querySelector('.ts-v2-nar')).toBeNull()
    expect(entered()).toEqual([...NARRATIVE_SECTIONS])
    act(() => setMedia(REDUCED_MOTION_QUERY, false))
    expect(document.querySelector('.ts-v2-nar')).not.toBeNull()
  })
})

describe.each(FLAT_QUERIES)('%s: flat --bg, no photo, no credit', (query) => {
  beforeEach(() => setMedia(query, true))

  it('renders no stack and no credit, and nothing is ever requested', () => {
    mountPage()
    nearAll()
    scrollTo(0)
    settle()
    expect(document.querySelector('.ts-v2-nar')).toBeNull()
    expect(document.querySelector('.ts-v2-nar-credit')).toBeNull()
    expect(document.body.innerHTML).not.toMatch(/bg-|\.avif|\.webp|image-set/)
    for (const id of NARRATIVE_SECTIONS) expect(section(id).hasAttribute('data-nar-static')).toBe(false)
  })

  it('wins over reduced motion: even with both set, no section paints a photo', () => {
    setMedia(REDUCED_MOTION_QUERY, true)
    mountPage()
    nearAll()
    expect(document.body.innerHTML).not.toMatch(/bg-|image-set/)
    expect(entered()).toEqual([...NARRATIVE_SECTIONS]) // reduced motion still shows the text at once
  })

  it('switching it off while the page is open brings the stack back and requests the near photos', () => {
    mountPage()
    nearAll()
    act(() => setMedia(query, false))
    expect(document.querySelector('.ts-v2-nar')).not.toBeNull()
    expect(document.querySelectorAll('.ts-v2-nar__layer[data-loaded]')).toHaveLength(5)
  })
})

describe('CSS: flat modes', () => {
  it('one media block for the three preferences hides the stack and the credit and clears the section background', () => {
    const block = /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\), \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/.exec(CSS)![1]
    expect(block).toMatch(/\.ts-v2-nar, \.ts-v2-nar-credit, \.ts-v2-nar-still\s*\{\s*display:\s*none;/)
    expect(block).toMatch(/\[data-nar-static\]\s*\{\s*background:\s*none;/)
  })
})
