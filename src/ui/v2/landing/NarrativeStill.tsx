import type { NarrativePhotoId } from '../photos/narrative'
import { NARRATIVE_PHOTOS } from '../photos/narrative'

/**
 * [ADR-025] A baked `bg-*` photo painted inside one opaque landing section (Performance, bottom CTA). Same files and the
 * same constant veil (`--nar-veil`) as the scroll-narrative stack, so every landing background has one texture: none of
 * the round-4/5 CSS grade, duotone or halftone. Native lazy loading (an `<img>` in a `<picture>`), AVIF first, portrait
 * file at ≤ 600 px — like the stack. Static: nothing animates.
 */
export function NarrativeStill({ photoId }: { photoId: NarrativePhotoId }) {
  const photo = NARRATIVE_PHOTOS[photoId]
  return (
    <div aria-hidden="true" data-photo={photoId} data-ts-narrative-still="" className="ts-v2-nar-still">
      <picture>
        <source type="image/avif" media="(max-width: 600px)" srcSet={photo.avif.w1080} />
        <source type="image/avif" srcSet={photo.avif.w1920} />
        <source type="image/webp" media="(max-width: 600px)" srcSet={photo.webp.w1080} />
        <img src={photo.webp.w1920} alt="" loading="lazy" decoding="async" className="ts-v2-nar-still__img" />
      </picture>
      <div className="ts-v2-nar-still__veil" />
    </div>
  )
}
