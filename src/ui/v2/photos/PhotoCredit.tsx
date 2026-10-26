import type { ShellPhoto } from './photos'

/**
 * [ADR-025] "PHOTO {AUTHOR} / PEXELS" (pack round4: dim mono, on a plate). It lives in the FOOTER's container, in
 * flow, left — never fixed to the viewport, where it collided with the floating "?" / ♫ (owner review, 26 Oct;
 * footer band, left, until round 5 re-places it). A page with several photos (the landing) names each author once.
 * Hidden with the photos themselves (reduced transparency etc.).
 */
export function PhotoCredit({ photos }: { photos: readonly ShellPhoto[] }) {
  const authors = Array.from(new Set(photos.map((p) => p.photographer)))
  if (authors.length === 0) return null
  return <p className="ts-v2-photo-credit ts-v2-plate">Photo {authors.join(' · ')} / Pexels</p>
}
