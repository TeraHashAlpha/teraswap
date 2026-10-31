'use client'

import Image from 'next/image'
import './photo.css'
import { PHOTOS, type PhotoId } from './photos'
import { photoForTab } from './tab-photos'
import { photoScrim } from './photo-scrim'
import type { V2TabId } from '../shell/tab-paths'

/**
 * [ADR-025] The photo layer behind the shell (pack round4). AVIF `<source>`s (1080 / 1920) with a WebP `next/image`
 * fallback inside one `<picture>`; the loader maps next/image's requested width onto the two shipped sizes, so no
 * optimizer round-trip and no re-encode. Only the photo that is on screen is rendered. The credit line is not here: it
 * is `PhotoCredit`, rendered inside the footer. `aboveFold` (the shell: always)
 * makes it eager + `fetchPriority="high"`; otherwise it is lazy. next/image's own `priority` is NOT used: it emits a
 * preload for the <img> (WebP) while AVIF browsers take the `<source>`, i.e. a wasted second download of the hero.
 *
 * Two kinds of photo. A `tab` (the shell) paints the landing's baked `bg-*` set (round 7, owner addition): the grade is in
 * the file, so the layers are just a constant veil, the app scrim, the fades and the footer band — no CSS grade, duotone or
 * halftone. A `photoId` (the landing hero's round-4 raster) keeps the original CSS-graded recipe.
 */
export function PhotoBackground({
  tab,
  photoId,
  aboveFold = true,
  section = false,
  appScrim = false,
}: {
  /** The shell: one fixed photo per tab (pack round4 assignment). */
  tab?: V2TabId
  /** A named photo instead of a tab's — the landing places photos per section. */
  photoId?: PhotoId
  aboveFold?: boolean
  /** Fill the nearest positioned ancestor (a landing section) instead of the viewport; no footer band. */
  section?: boolean
  /** Round 7: the app shell's uniform scrim (content sits on the photo with no box). The landing uses local scrims instead. */
  appScrim?: boolean
}) {
  if (!photoId) {
    const baked = photoForTab(tab ?? 'swap')
    return (
      <div aria-hidden="true" data-photo={baked.id} data-photo-baked="" className={section ? 'ts-v2-photo ts-v2-photo--section' : 'ts-v2-photo'}>
        <picture>
          <source type="image/avif" media="(max-width: 600px)" srcSet={baked.avif.w1080} />
          <source type="image/avif" srcSet={baked.avif.w1920} />
          <source type="image/webp" media="(max-width: 600px)" srcSet={baked.webp.w1080} />
          <img
            src={baked.webp.w1920}
            alt=""
            loading={aboveFold ? 'eager' : 'lazy'}
            fetchPriority={aboveFold ? 'high' : 'auto'}
            decoding="async"
            className="ts-v2-photo__img ts-v2-photo__img--baked"
          />
        </picture>
        <div className="ts-v2-photo__layer ts-v2-photo__baked-veil" />
        <div className="ts-v2-photo__layer ts-v2-photo__veil-mobile" />
        {appScrim ? (
          // B3 C3: this photo's own scrim (photo-scrim.ts), not one value for all eight
          <div
            data-photo-scrim={photoScrim[baked.id]}
            className="ts-v2-photo__layer ts-v2-photo__scrim"
            style={{ ['--photo-app-scrim' as string]: photoScrim[baked.id] }}
          />
        ) : null}
        <div className="ts-v2-photo__layer ts-v2-photo__fade" />
        {section ? null : <div className="ts-v2-photo__band" />}
      </div>
    )
  }
  const photo = PHOTOS[photoId]
  return (
    <div aria-hidden="true" data-photo={photo.id} className={section ? 'ts-v2-photo ts-v2-photo--section' : 'ts-v2-photo'}>
      <picture>
        <source type="image/avif" media="(max-width: 1080px)" srcSet={photo.avif.w1080} />
        <source type="image/avif" srcSet={photo.avif.w1920} />
        <Image
          src={photo.webp.w1920}
          alt=""
          fill
          sizes="100vw"
          loader={({ width }) => (width <= 1080 ? photo.webp.w1080 : photo.webp.w1920)}
          loading={aboveFold ? 'eager' : 'lazy'}
          fetchPriority={aboveFold ? 'high' : 'auto'}
          className="ts-v2-photo__img"
        />
      </picture>
      <div className="ts-v2-photo__layer ts-v2-photo__tone" />
      <div className="ts-v2-photo__layer ts-v2-photo__veil" />
      <div className="ts-v2-photo__layer ts-v2-photo__veil-mobile" />
      {appScrim ? <div data-photo-scrim="" className="ts-v2-photo__layer ts-v2-photo__scrim" /> : null}
      <div className="ts-v2-photo__layer ts-v2-photo__fade" />
      <div className="ts-v2-photo__layer ts-v2-photo__dots" />
      {section ? null : <div className="ts-v2-photo__band" />}
    </div>
  )
}
