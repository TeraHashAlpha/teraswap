import credits from './credits.json'
import type { V2TabId } from '../shell/tab-paths'

import zakim1080Avif from './pexels-17102595-phil-evenden-zakim-bridge-night-1080.avif'
import zakim1080Webp from './pexels-17102595-phil-evenden-zakim-bridge-night-1080.webp'
import zakim1920Avif from './pexels-17102595-phil-evenden-zakim-bridge-night-1920.avif'
import zakim1920Webp from './pexels-17102595-phil-evenden-zakim-bridge-night-1920.webp'
import underpass1080Avif from './pexels-32397093-willbone-gallery-underpass-night-1080.avif'
import underpass1080Webp from './pexels-32397093-willbone-gallery-underpass-night-1080.webp'
import underpass1920Avif from './pexels-32397093-willbone-gallery-underpass-night-1920.avif'
import underpass1920Webp from './pexels-32397093-willbone-gallery-underpass-night-1920.webp'
import arch1080Avif from './pexels-35632241-peter-dyllong-arch-night-1080.avif'
import arch1080Webp from './pexels-35632241-peter-dyllong-arch-night-1080.webp'
import arch1920Avif from './pexels-35632241-peter-dyllong-arch-night-1920.avif'
import arch1920Webp from './pexels-35632241-peter-dyllong-arch-night-1920.webp'
import trails1080Avif from './pexels-30180436-yakup-gokdeniz-light-trails-1080.avif'
import trails1080Webp from './pexels-30180436-yakup-gokdeniz-light-trails-1080.webp'
import trails1920Avif from './pexels-30180436-yakup-gokdeniz-light-trails-1920.avif'
import trails1920Webp from './pexels-30180436-yakup-gokdeniz-light-trails-1920.webp'

export type PhotoId = 'zakim' | 'underpass' | 'arch-night' | 'trails'

type Asset = string | { src: string }
/** Next's bundler hands back `{ src, width, height }`; plain tooling (vitest) hands back the URL itself. */
export const urlOf = (a: Asset): string => (typeof a === 'string' ? a : a.src)

export interface ShellPhoto {
  id: PhotoId
  photographer: string
  avif: { w1080: string; w1920: string }
  webp: { w1080: string; w1920: string }
}

function photo(id: PhotoId, avif1080: Asset, avif1920: Asset, webp1080: Asset, webp1920: Asset): ShellPhoto {
  const credit = credits.photos.find((p) => p.id === id)
  if (!credit) throw new Error(`photo ${id} has no credit entry`)
  return {
    id,
    photographer: credit.photographer,
    avif: { w1080: urlOf(avif1080), w1920: urlOf(avif1920) },
    webp: { w1080: urlOf(webp1080), w1920: urlOf(webp1920) },
  }
}

export const PHOTOS: Record<PhotoId, ShellPhoto> = {
  zakim: photo('zakim', zakim1080Avif, zakim1920Avif, zakim1080Webp, zakim1920Webp),
  underpass: photo('underpass', underpass1080Avif, underpass1920Avif, underpass1080Webp, underpass1920Webp),
  'arch-night': photo('arch-night', arch1080Avif, arch1920Avif, arch1080Webp, arch1920Webp),
  trails: photo('trails', trails1080Avif, trails1920Avif, trails1080Webp, trails1920Webp),
}

/** Pack round4 README "Photo assignment": one photo per section. Limit / SL-TP (tabs are "Soon") take Swap's. */
export const TAB_PHOTO: Record<V2TabId, PhotoId> = {
  swap: 'zakim',
  limit: 'zakim',
  sltp: 'zakim',
  dca: 'underpass',
  portfolio: 'arch-night',
  orders: 'arch-night',
  history: 'arch-night',
  analytics: 'trails',
}

export function photoForTab(tab: V2TabId): ShellPhoto {
  return PHOTOS[TAB_PHOTO[tab]]
}
