import type { ShellPhoto } from './photos'

/**
 * [ADR-025] "PHOTO {AUTHOR} / PEXELS" (pack round4: dim mono, on a plate). It lives in the FOOTER's container, in
 * flow, left — never fixed to the viewport, where it collided with the floating "?" / ♫ (owner review, 26 Oct;
 * footer band, left, until round 5 re-places it). Hidden with the photo itself (reduced transparency etc.).
 */
export function PhotoCredit({ photo }: { photo: ShellPhoto }) {
  return <p className="ts-v2-photo-credit ts-v2-plate">Photo {photo.photographer} / Pexels</p>
}
