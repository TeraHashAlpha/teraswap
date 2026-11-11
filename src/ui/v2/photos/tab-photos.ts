import type { V2TabId } from '../shell/tab-paths'
import type { V2DocsLegalPage } from '../shell/docs-legal-paths'
import { NARRATIVE_PHOTOS, type NarrativePhoto, type NarrativePhotoId } from './narrative'

/**
 * [ADR-025] The app shell's photo per tab — the round-5 map, applied on the owner's say-so (26 Oct preview review, round 7).
 * The photos are the landing's baked `bg-*` set (see `narrative.ts`), so the shell and the landing share one texture: no
 * CSS grade, no duotone, no halftone. Eight tabs, eight distinct photos. `light-trails` (Pexels 30180436) is REJECTED
 * everywhere: no tab maps to it and a test pins that.
 *
 *   Swap = Zakim 17102595 · Limit = highway 31514221 · SL/TP = arch-light 36192529 · DCA = underpass 32397093 ·
 *   Portfolio = tunnel 9221575 · Orders = arch-night 35632241 · History = footbridge 8936918 · Analytics = MAG overpass 37644721
 */
export const TAB_PHOTO: Record<V2TabId, NarrativePhotoId> = {
  swap: 'zakim',
  portfolio: 'tunnel',
  dca: 'underpass',
  limit: 'highway',
  sltp: 'archlight',
  orders: 'archnight',
  history: 'footbridge',
  analytics: 'overpass',
}

export function photoForTab(tab: V2TabId): NarrativePhoto {
  return NARRATIVE_PHOTOS[TAB_PHOTO[tab]]
}

/**
 * [feat/ui-v2-docs-legal] Docs/Terms/Privacy are not app tabs, so they get their own map, not a TAB_PHOTO entry.
 * Owner decision (5 Nov): temporary placeholders reusing existing tab photos — round 9 photos replace them later.
 * Kept here, next to TAB_PHOTO, so the whole photo-per-page assignment lives in one place.
 */
export const DOCS_LEGAL_PHOTO: Record<V2DocsLegalPage, NarrativePhotoId> = {
  docs: 'overpass', // Analytics overpass
  terms: 'archnight', // Orders arch-night
  privacy: 'footbridge', // History footbridge
}

export function photoForDocsLegalPage(page: V2DocsLegalPage): NarrativePhoto {
  return NARRATIVE_PHOTOS[DOCS_LEGAL_PHOTO[page]]
}
