import credits from './credits.json'
import { urlOf } from './photos'

import archlight1080Avif from './narrative/bg-archlight-1080.avif'
import archlight1080Webp from './narrative/bg-archlight-1080.webp'
import archlight1920Avif from './narrative/bg-archlight-1920.avif'
import archlight1920Webp from './narrative/bg-archlight-1920.webp'
import archnight1080Avif from './narrative/bg-archnight-1080.avif'
import archnight1080Webp from './narrative/bg-archnight-1080.webp'
import archnight1920Avif from './narrative/bg-archnight-1920.avif'
import archnight1920Webp from './narrative/bg-archnight-1920.webp'
import overpass1080Avif from './narrative/bg-overpass-1080.avif'
import overpass1080Webp from './narrative/bg-overpass-1080.webp'
import overpass1920Avif from './narrative/bg-overpass-1920.avif'
import overpass1920Webp from './narrative/bg-overpass-1920.webp'
import zakim1080Avif from './narrative/bg-zakim-1080.avif'
import zakim1080Webp from './narrative/bg-zakim-1080.webp'
import zakim1920Avif from './narrative/bg-zakim-1920.avif'
import zakim1920Webp from './narrative/bg-zakim-1920.webp'
import footbridge1080Avif from './narrative/bg-footbridge-1080.avif'
import footbridge1080Webp from './narrative/bg-footbridge-1080.webp'
import footbridge1920Avif from './narrative/bg-footbridge-1920.avif'
import footbridge1920Webp from './narrative/bg-footbridge-1920.webp'
import highway1080Avif from './narrative/bg-highway-1080.avif'
import highway1080Webp from './narrative/bg-highway-1080.webp'
import highway1920Avif from './narrative/bg-highway-1920.avif'
import highway1920Webp from './narrative/bg-highway-1920.webp'
import tunnel1080Avif from './narrative/bg-tunnel-1080.avif'
import tunnel1080Webp from './narrative/bg-tunnel-1080.webp'
import tunnel1920Avif from './narrative/bg-tunnel-1920.avif'
import tunnel1920Webp from './narrative/bg-tunnel-1920.webp'
import underpass1080Avif from './narrative/bg-underpass-1080.avif'
import underpass1080Webp from './narrative/bg-underpass-1080.webp'
import underpass1920Avif from './narrative/bg-underpass-1920.avif'
import underpass1920Webp from './narrative/bg-underpass-1920.webp'

/**
 * [ADR-025] The landing's scroll-narrative photos (round-6 MOTION-SPEC §2/§3). Unlike the shell's photos these are
 * pre-graded derivatives (recipe steps 1–3 baked in), so a layer needs no CSS filter and the veil can stay constant
 * while two layers cross-fade. 1920 is the landscape size for desktop, 1080 the portrait size for ≤ 600 px.
 * Round 7 (owner addition): the app shell's per-tab photo (`tab-photos.ts`) uses this same set, so `zakim`, `archnight` and
 * `overpass` join the landing's five. The landing's scroll narrative only ever uses the ids `SECTION_PHOTO` names.
 */
export type NarrativePhotoId = 'highway' | 'footbridge' | 'tunnel' | 'archlight' | 'underpass' | 'zakim' | 'archnight' | 'overpass'

export interface NarrativePhoto {
  id: NarrativePhotoId
  photographer: string
  avif: { w1080: string; w1920: string }
  webp: { w1080: string; w1920: string }
}

function narrative(
  id: NarrativePhotoId,
  avif1080: string | { src: string },
  avif1920: string | { src: string },
  webp1080: string | { src: string },
  webp1920: string | { src: string },
): NarrativePhoto {
  const credit = credits.narrative.find((p) => p.id === id)
  if (!credit) throw new Error(`narrative photo ${id} has no credit entry`)
  return {
    id,
    photographer: credit.photographer,
    avif: { w1080: urlOf(avif1080), w1920: urlOf(avif1920) },
    webp: { w1080: urlOf(webp1080), w1920: urlOf(webp1920) },
  }
}

export const NARRATIVE_PHOTOS: Record<NarrativePhotoId, NarrativePhoto> = {
  highway: narrative('highway', highway1080Avif, highway1920Avif, highway1080Webp, highway1920Webp),
  footbridge: narrative('footbridge', footbridge1080Avif, footbridge1920Avif, footbridge1080Webp, footbridge1920Webp),
  tunnel: narrative('tunnel', tunnel1080Avif, tunnel1920Avif, tunnel1080Webp, tunnel1920Webp),
  archlight: narrative('archlight', archlight1080Avif, archlight1920Avif, archlight1080Webp, archlight1920Webp),
  underpass: narrative('underpass', underpass1080Avif, underpass1920Avif, underpass1080Webp, underpass1920Webp),
  zakim: narrative('zakim', zakim1080Avif, zakim1920Avif, zakim1080Webp, zakim1920Webp),
  archnight: narrative('archnight', archnight1080Avif, archnight1920Avif, archnight1080Webp, archnight1920Webp),
  overpass: narrative('overpass', overpass1080Avif, overpass1920Avif, overpass1080Webp, overpass1920Webp),
}

/** `image-set()` value for one size: AVIF first, WebP as the fallback (MOTION-SPEC §6). */
export function imageSetFor(photo: NarrativePhoto, size: 'w1080' | 'w1920'): string {
  return `image-set(url("${photo.avif[size]}") type("image/avif"), url("${photo.webp[size]}") type("image/webp"))`
}
