import type { V2TabId } from '../shell/tab-paths'
import { PHOTO_TOKENS } from './photo-tokens'
import type { NarrativePhotoId } from './narrative'
import { TAB_PHOTO } from './tab-photos'

/**
 * [ADR-025] The app scrim PER PHOTO (B3 C3). Round 7's single `PHOTO_TOKENS.appScrim` (0.47) was set by the worst photo (DCA's
 * underpass); every other tab paid for it and its photo nearly vanished. Each value below is the LOWEST α (0.01 steps) of the
 * #0B0D0F scrim over the baked photo + constant veil (`PHOTO_TOKENS.bakedVeil`) at which every app text token keeps AA against
 * the 95th-percentile luminance of that photo — body/muted/cream/teal/green/amber/red ≥ 4.5, the large dim placeholder ≥ 3 —
 * at desktop (1920) and phone (1080, + the 35 % mobile veil), AVIF and WebP. `photo-scrim.test.ts` recomputes it from the shipped
 * files: a value below the minimum fails (AA), a value above it fails (not the lowest) — except DCA, which the owner keeps at
 * the round-7 0.47 (the measured minimum there is 0.40).
 *
 * Seven photos need no scrim at all (0): the baked grade plus the 17.6 % veil is already dark enough. p95 means the brightest
 * 5 % of pixels (street lamps, lit windows) may sit under AA text — the method the landing's narrative test uses too.
 */
export const photoScrim: Record<NarrativePhotoId, number> = {
  zakim: 0,
  tunnel: 0,
  underpass: PHOTO_TOKENS.appScrim, // DCA: owner keeps 0.47 (measured minimum 0.40)
  highway: 0,
  archlight: 0,
  archnight: 0,
  footbridge: 0,
  overpass: 0,
}

export function scrimForTab(tab: V2TabId): number {
  return photoScrim[TAB_PHOTO[tab]]
}
