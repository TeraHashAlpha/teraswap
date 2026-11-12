import type { CSSProperties } from 'react'
import type { NarrativePhotoId } from '../photos/narrative'

/**
 * [ADR-025] Scroll narrative (round-6 MOTION-SPEC §2–§3): which photo sits behind which landing section, and which
 * section is "active". Pure — NarrativeStack feeds it the measured rects, the tests feed it mocked ones.
 *
 * [fix/ui-v2-walkthrough-polish C2] EVERY landing section is in this list, in page order. Before, the hero, Performance,
 * "Why" and the bottom CTA were opaque bands with a static photo of their own and no `data-ts-narrative`: they covered
 * the fixed stack, so the boundaries around them were hard cuts (no photo cross-fade, no reveal) while the five long-text
 * sections between and after them cross-faded. Same motion at every boundary now: the section id is also the DOM id.
 */
export const NARRATIVE_SECTIONS = ['hero', 'performance', 'why-teraswap', 'security', 'experience', 'features', 'roadmap', 'cta', 'docs'] as const
export type NarrativeSectionId = (typeof NARRATIVE_SECTIONS)[number]

/**
 * The photos the first four sections used to paint as stills. Design review 1 (owner, 5 Nov): no section is a dark band;
 * the hero is the pack's overpass (MAG Photography, Pexels 37644721: round-6 MOTION-SPEC §2 "the overpass (hero and §8)"),
 * "Why" is the pack's P4 proposal, Zakim (round-7 `p4-why-zakim`). Neither neighbour shares its photo (hero overpass ·
 * §2 tunnel · §3 zakim · §4 highway). The footer still names these authors (it is the only credit at ≤ 600 px).
 */
export const STILL_PHOTO = { hero: 'overpass', performance: 'tunnel', why: 'zakim', cta: 'highway' } as const satisfies Record<string, NarrativePhotoId>

/** MOTION-SPEC §2. Mobile (≤ 600 px) uses fewer photos: a section that shares its neighbour's photo does not fade. */
export const SECTION_PHOTO: Record<NarrativeSectionId, { desktop: NarrativePhotoId; mobile: NarrativePhotoId }> = {
  hero: { desktop: STILL_PHOTO.hero, mobile: STILL_PHOTO.hero },
  performance: { desktop: STILL_PHOTO.performance, mobile: STILL_PHOTO.performance },
  'why-teraswap': { desktop: STILL_PHOTO.why, mobile: STILL_PHOTO.why },
  security: { desktop: 'highway', mobile: 'highway' },
  experience: { desktop: 'footbridge', mobile: 'highway' },
  features: { desktop: 'tunnel', mobile: 'tunnel' },
  roadmap: { desktop: 'archlight', mobile: 'tunnel' },
  cta: { desktop: STILL_PHOTO.cta, mobile: STILL_PHOTO.cta },
  docs: { desktop: 'underpass', mobile: 'underpass' },
}

/** The photo behind the first section: the stack starts on it (and server-renders it), so the hero never paints on a bare background. */
export const FIRST_PHOTO: NarrativePhotoId = SECTION_PHOTO.hero.desktop

/** The viewport width at and below which the mobile map, the portrait files and the footer-only credit apply. */
export const MOBILE_MAX_WIDTH = 600
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`

/**
 * How long a replaced photo layer stays `data-leaving`: just over `--t-photo-scale` (1600 ms, tokens.css), its slowest
 * transition. A test pins the two together. Reduced motion has no stack, so nothing waits on it.
 */
export const PHOTO_SETTLE_MS = 1700

/** A section is active while it crosses this fraction of the viewport height (MOTION-SPEC §3 "Trigger"). */
export const ACTIVE_LINE = 0.4
/** Entrance IO margin: a line at ACTIVE_LINE (MOTION-SPEC §4). */
export const ENTER_ROOT_MARGIN = '-40% 0px -60% 0px'
/** Lazy-load IO margin: a photo is requested once its section is within one viewport (MOTION-SPEC §6). */
export const NEAR_ROOT_MARGIN = '0px 0px 100% 0px'
/** Threshold ladder 0, 0.05 … 1: re-pick whenever a section's visible share changes. */
export const ACTIVE_THRESHOLDS: readonly number[] = Array.from({ length: 21 }, (_, i) => i / 20)

export const photoFor = (section: NarrativeSectionId, mobile: boolean): NarrativePhotoId =>
  SECTION_PHOTO[section][mobile ? 'mobile' : 'desktop']

/** Distinct photos used for a viewport class, in page order — one stack layer each. */
export function photosFor(mobile: boolean): NarrativePhotoId[] {
  return Array.from(new Set(NARRATIVE_SECTIONS.map((s) => photoFor(s, mobile))))
}

export interface SectionRect {
  id: NarrativeSectionId
  top: number
  bottom: number
}

export interface Pick {
  /** The photo to show; null = no narrative section is on screen, so the opaque sections own the viewport. */
  photo: NarrativePhotoId | null
}

/** A section that is entirely inside the viewport. */
export const isWhollyInView = (r: { top: number; bottom: number }, viewportHeight: number): boolean => r.top >= 0 && r.bottom <= viewportHeight

/**
 * The active section is the one that crosses the 40 % line. A narrative section still below the line is pre-selected
 * so no flat gap shows while it enters; nothing is active when no narrative section is in the viewport at all.
 *
 * The LAST section is active as soon as it is entirely in view: the docs row is short and the footer follows it, so on a tall
 * viewport the page ends before the docs row ever reaches the line, and without this rule the last boundary would never fade.
 */
export function pickActive(rects: readonly SectionRect[], viewportHeight: number, mobile: boolean): Pick {
  const line = viewportHeight * ACTIVE_LINE
  const anyVisible = rects.some((r) => r.bottom > 0 && r.top < viewportHeight)
  let hit = rects.find((r) => r.top <= line && r.bottom > line)
  if (!hit) hit = rects.find((r) => r.top > line && r.top < viewportHeight)
  const last = rects[rects.length - 1]
  if (last && isWhollyInView(last, viewportHeight)) hit = last
  return { photo: anyVisible && hit ? photoFor(hit.id, mobile) : null }
}

// ── entrance (MOTION-SPEC §4) ─────────────────────────────────────────────────────────────────────────────────

/** 40 ms per element, capped at index 4: the last starts at 160 ms and the whole sequence ends by 320 ms. */
export const STAGGER_MS = 40
export const STAGGER_MAX_INDEX = 4
export const staggerDelayMs = (index: number): number => Math.min(Math.max(index, 0), STAGGER_MAX_INDEX) * STAGGER_MS

/** `style` for a `.ts-v2-rv` element: its place in the section's stagger (CSS reads `--i`). */
export const rvAt = (index: number): CSSProperties => ({ '--i': index }) as CSSProperties

/** The three "give me a flat page" preferences (MOTION-SPEC §5): no photo, no credit, flat `--bg`. */
export const FLAT_QUERIES = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'] as const
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** `stack`: fixed cross-fading stack · `static`: each section paints its own photo (reduced motion) · `flat`: no photo. */
export type NarrativeMode = 'stack' | 'static' | 'flat'
