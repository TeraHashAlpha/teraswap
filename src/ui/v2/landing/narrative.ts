import type { NarrativePhotoId } from '../photos/narrative'

/**
 * [ADR-025] Scroll narrative (round-6 MOTION-SPEC §2–§3): which photo sits behind which long-text section, and which
 * section is "active". Pure — NarrativeStack feeds it the measured rects, the tests feed it mocked ones.
 */
export const NARRATIVE_SECTIONS = ['security', 'experience', 'features', 'roadmap', 'docs'] as const
export type NarrativeSectionId = (typeof NARRATIVE_SECTIONS)[number]

/** MOTION-SPEC §2. Mobile (≤ 600 px) uses three photos: a section that shares its neighbour's photo does not fade. */
export const SECTION_PHOTO: Record<NarrativeSectionId, { desktop: NarrativePhotoId; mobile: NarrativePhotoId }> = {
  security: { desktop: 'highway', mobile: 'highway' },
  experience: { desktop: 'footbridge', mobile: 'highway' },
  features: { desktop: 'tunnel', mobile: 'tunnel' },
  roadmap: { desktop: 'archlight', mobile: 'tunnel' },
  docs: { desktop: 'underpass', mobile: 'underpass' },
}

/** The viewport width at and below which the mobile map, the portrait files and the footer-only credit apply. */
export const MOBILE_MAX_WIDTH = 600
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`

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

/**
 * The active section is the one that crosses the 40 % line. A narrative section still below the line is pre-selected
 * so no flat gap shows while it enters; nothing is active when no narrative section is in the viewport at all.
 */
export function pickActive(rects: readonly SectionRect[], viewportHeight: number, mobile: boolean): Pick {
  const line = viewportHeight * ACTIVE_LINE
  const anyVisible = rects.some((r) => r.bottom > 0 && r.top < viewportHeight)
  let hit = rects.find((r) => r.top <= line && r.bottom > line)
  if (!hit) hit = rects.find((r) => r.top > line && r.top < viewportHeight)
  return { photo: anyVisible && hit ? photoFor(hit.id, mobile) : null }
}
