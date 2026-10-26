'use client'

import Image from 'next/image'
import './photo.css'
import { photoForTab } from './photos'
import type { V2TabId } from '../shell/tab-paths'

/**
 * [ADR-025] The photo layer behind the shell (pack round4). AVIF `<source>`s (1080 / 1920) with a WebP `next/image`
 * fallback inside one `<picture>`; the loader maps next/image's requested width onto the two shipped sizes, so no
 * optimizer round-trip and no re-encode. Only the photo that is on screen is rendered. `aboveFold` (the shell: always)
 * makes it eager + `fetchPriority="high"`; otherwise it is lazy. next/image's own `priority` is NOT used: it emits a
 * preload for the <img> (WebP) while AVIF browsers take the `<source>`, i.e. a wasted second download of the hero.
 */
export function PhotoBackground({ tab, aboveFold = true }: { tab: V2TabId; aboveFold?: boolean }) {
  const photo = photoForTab(tab)
  return (
    <>
      <div aria-hidden="true" data-photo={photo.id} className="ts-v2-photo">
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
        <div className="ts-v2-photo__layer ts-v2-photo__fade" />
        <div className="ts-v2-photo__layer ts-v2-photo__dots" />
        <div className="ts-v2-photo__band" />
      </div>
      <p className="ts-v2-photo-credit ts-v2-plate">Photo {photo.photographer} / Pexels</p>
    </>
  )
}
