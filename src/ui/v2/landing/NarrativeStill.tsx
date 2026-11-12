import type { NarrativePhotoId } from '../photos/narrative'
import { NARRATIVE_PHOTOS } from '../photos/narrative'

/**
 * [fix/ui-v2-walkthrough-polish C2] NOT USED BY THE LANDING ANY MORE. The hero, Performance, "Why" and the bottom CTA are
 * narrative sections now (their photo is a layer of the cross-fading stack), so no landing section paints a static still
 * and every section boundary moves the same way. Kept in place (CLAUDE.md "Do NOT" 4) for a surface that wants one photo.
 *
 * [ADR-025] A baked `bg-*` photo painted inside one opaque landing section (Performance, bottom CTA). Same files and the
 * same constant veil (`--nar-veil`) as the scroll-narrative stack, so every landing background has one texture: none of
 * the round-4/5 CSS grade, duotone or halftone. Native lazy loading (an `<img>` in a `<picture>`), AVIF first, portrait
 * file at ≤ 600 px — like the stack. Static: nothing animates.
 */
export function NarrativeStill({ photoId, eager = false }: { photoId: NarrativePhotoId; /** the hero: above the fold, so eager + high priority (it is the LCP image) */ eager?: boolean }) {
  const photo = NARRATIVE_PHOTOS[photoId]
  return (
    <div aria-hidden="true" data-photo={photoId} data-ts-narrative-still="" className="ts-v2-nar-still">
      <picture>
        <source type="image/avif" media="(max-width: 600px)" srcSet={photo.avif.w1080} />
        <source type="image/avif" srcSet={photo.avif.w1920} />
        <source type="image/webp" media="(max-width: 600px)" srcSet={photo.webp.w1080} />
        <img src={photo.webp.w1920} alt="" loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : 'auto'} decoding="async" className="ts-v2-nar-still__img" />
      </picture>
      <div className="ts-v2-nar-still__veil" />
    </div>
  )
}
