// @vitest-environment jsdom
/**
 * [ADR-025] Photo background: every shipped image ≤ 200 KB (strict 200 000 B), credited, assigned per the pack,
 * tokens pinned to their CSS twin, and rendered as AVIF sources + next/image WebP fallback (no `priority` preload).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import credits from './credits.json'
import { PHOTO_TOKENS } from './photo-tokens'
import { PhotoBackground } from './PhotoBackground'
import { PHOTOS, TAB_PHOTO, photoForTab, urlOf } from './photos'
import { V2_TABS } from '../shell/tab-paths'

afterEach(cleanup)

const MAX_BYTES = 200_000
const IMAGES = readdirSync(__dirname).filter((f) => /\.(avif|webp)$/.test(f))
const CSS = readFileSync(join(__dirname, 'photo.css'), 'utf8')

describe('shipped photo files', () => {
  it('are AVIF + WebP at 1080 and 1920 for exactly the 4 shell photos (16 files)', () => {
    expect(IMAGES).toHaveLength(16)
    for (const p of credits.photos) {
      expect(p.files.map((f) => f.file).sort()).toEqual(
        IMAGES.filter((f) => f.includes(p.pexelsId)).sort(),
      )
      for (const w of [1080, 1920]) for (const ext of ['avif', 'webp']) {
        expect(IMAGES.some((f) => f.includes(p.pexelsId) && f.endsWith(`-${w}.${ext}`)), `${p.id} ${w} ${ext}`).toBe(true)
      }
    }
  })

  it.each(IMAGES)('%s ≤ 200 KB', (file) => {
    expect(statSync(join(__dirname, file)).size).toBeLessThanOrEqual(MAX_BYTES)
  })

  it.each(IMAGES)('%s has the right container signature', (file) => {
    const head = readFileSync(join(__dirname, file)).subarray(0, 16)
    if (file.endsWith('.webp')) expect(`${head.subarray(0, 4)}${head.subarray(8, 12)}`).toBe('RIFFWEBP')
    else expect(head.subarray(4, 12).toString('latin1')).toBe('ftypavif')
  })
})

describe('credits.json', () => {
  it('lists every shipped photo with photographer, Pexels URL, licence; byte counts match the files', () => {
    expect(credits.photos.map((p) => p.id).sort()).toEqual(['arch-night', 'trails', 'underpass', 'zakim'])
    for (const p of credits.photos) {
      expect(p.photographer.length).toBeGreaterThan(2)
      expect(p.pexelsUrl).toMatch(/^https:\/\/www\.pexels\.com\/photo\//)
      expect(p.license).toBe('Pexels License')
      expect(p.commercialUse).toBe(true)
      for (const f of p.files) expect(f.bytes).toBe(statSync(join(__dirname, f.file)).size)
    }
  })

  it('names the pack photographers', () => {
    const by = Object.fromEntries(credits.photos.map((p) => [p.id, p.photographer]))
    expect(by).toEqual({ zakim: 'Phil Evenden', underpass: 'Willbone Gallery', 'arch-night': 'Peter Dyllong', trails: 'Yakup Gökdeniz' })
  })
})

describe('tab → photo (pack round4 "Photo assignment")', () => {
  it('Swap=Zakim · DCA=Underpass · Portfolio/Orders/History=Arch night · Analytics=Trails', () => {
    expect(TAB_PHOTO).toMatchObject({ swap: 'zakim', dca: 'underpass', portfolio: 'arch-night', orders: 'arch-night', history: 'arch-night', analytics: 'trails' })
    for (const t of V2_TABS) expect(PHOTOS[TAB_PHOTO[t.id]]).toBeDefined()
  })
})

describe('tokens (photo-tokens.ts ⇄ photo.css)', () => {
  it('veil 45%, 96 px footer band, plate 92% appear identically in the CSS', () => {
    expect(PHOTO_TOKENS.veil).toBe(0.45)
    expect(PHOTO_TOKENS.footerBandPx).toBe(96)
    expect(CSS).toContain(`--photo-veil: ${PHOTO_TOKENS.veil};`)
    expect(CSS).toContain(`--photo-footer-band: ${PHOTO_TOKENS.footerBandPx}px;`)
    expect(CSS).toContain(`--photo-footer-band-alpha: ${PHOTO_TOKENS.footerBandAlpha};`)
    expect(CSS).toContain(`rgba(11, 13, 15, ${PHOTO_TOKENS.plateAlpha})`)
    expect(CSS).toContain(`contrast(${PHOTO_TOKENS.contrast}) brightness(${PHOTO_TOKENS.brightness})`)
    expect(CSS.toLowerCase()).toContain(PHOTO_TOKENS.duotoneWhite.toLowerCase())
  })

  it('falls back to the flat background for reduced transparency / more contrast / forced colours', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\), \(forced-colors: active\) \{[^}]*display: none/)
  })
})

describe('<PhotoBackground>', () => {
  it('one <picture>: AVIF 1080 (media) + AVIF 1920 sources, WebP <img>, decorative', () => {
    const { container } = render(<PhotoBackground tab="swap" />)
    const sources = container.querySelectorAll('picture source')
    expect(Array.from(sources).map((s) => [s.getAttribute('type'), s.getAttribute('media')])).toEqual([
      ['image/avif', '(max-width: 1080px)'],
      ['image/avif', null],
    ])
    expect(sources[0].getAttribute('srcset')).toBe(urlOf(photoForTab('swap').avif.w1080))
    expect(sources[1].getAttribute('srcset')).toBe(urlOf(photoForTab('swap').avif.w1920))
    const img = container.querySelector('picture img')!
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('srcset') ?? '').toContain('.webp')
    expect(container.querySelector('[data-photo="zakim"]')?.getAttribute('aria-hidden')).toBe('true')
    // The credit line is the footer's (PhotoCredit), not this layer's.
    expect(screen.queryByText(/Pexels/)).toBeNull()
  })

  it('above the fold → eager + fetchPriority high; otherwise lazy and not high', () => {
    const { container, rerender } = render(<PhotoBackground tab="dca" />)
    let img = container.querySelector('picture img')!
    expect([img.getAttribute('loading'), img.getAttribute('fetchpriority')]).toEqual(['eager', 'high'])
    rerender(<PhotoBackground tab="dca" aboveFold={false} />)
    img = container.querySelector('picture img')!
    expect([img.getAttribute('loading'), img.getAttribute('fetchpriority')]).toEqual(['lazy', 'auto'])
  })

  it('does not use next/image `priority` (its preload would fetch the WebP while AVIF browsers use the <source>)', () => {
    const src = readFileSync(join(__dirname, 'PhotoBackground.tsx'), 'utf8')
    expect(src).toMatch(/from 'next\/image'/)
    expect(src).not.toMatch(/\bpriority(=|\s*\/?>|\s*$)/m)
  })

  it('renders only the photo of the active tab', () => {
    const { container } = render(<PhotoBackground tab="analytics" />)
    expect(container.querySelectorAll('[data-photo]')).toHaveLength(1)
    expect(container.querySelector('[data-photo="trails"]')).not.toBeNull()
  })
})
