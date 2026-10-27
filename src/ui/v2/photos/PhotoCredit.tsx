/**
 * [ADR-025] "PHOTO {AUTHOR} / PEXELS" (pack round4: dim mono, on a plate). It lives in the FOOTER's container, in
 * flow, left — never fixed to the viewport, where it collided with the floating "?" / ♫ (owner review, 26 Oct;
 * footer band, left, until round 5 re-places it). A page with several photos (the landing) names each author once.
 * Hidden with the photos themselves (reduced transparency etc.).
 *
 * `mobilePhotos` (the landing): at ≤ 600 px the scroll narrative's fixed credit is hidden — it could sit over card text
 * — so the footer band is the only place credits show there, as ONE line listing every photographer on the page. That
 * line is a second element (this one is hidden at ≤ 600 px), so the desktop credit stays exactly as it was.
 */
export function PhotoCredit({ photos, mobilePhotos }: { photos: readonly { photographer: string }[]; mobilePhotos?: readonly { photographer: string }[] }) {
  const authors = Array.from(new Set(photos.map((p) => p.photographer)))
  if (authors.length === 0) return null
  const mobileAuthors = mobilePhotos ? Array.from(new Set([...authors, ...mobilePhotos.map((p) => p.photographer)])) : null
  return (
    <>
      <p className={mobileAuthors ? 'ts-v2-photo-credit ts-v2-photo-credit--desktop ts-v2-plate' : 'ts-v2-photo-credit ts-v2-plate'}>
        Photo {authors.join(' · ')} / Pexels
      </p>
      {mobileAuthors ? (
        <p className="ts-v2-photo-credit ts-v2-photo-credit--mobile ts-v2-plate">Photo {mobileAuthors.join(' · ')} / Pexels</p>
      ) : null}
    </>
  )
}
