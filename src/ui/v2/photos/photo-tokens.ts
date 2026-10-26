/**
 * [ADR-025] Photo-background tokens (pack round4 README "Rules applied" + photo-style recipe). The CSS twin is
 * photo.css (`.ts-v2 { --photo-… }`); photo.test.ts pins both to these numbers so neither can drift alone.
 */
export const PHOTO_TOKENS = {
  /** Extra #0B0D0F veil over the graded photo — 45% (owner spec). */
  veil: 0.45,
  /** Extra veil below 640 px (pack round4 "Mobile": 35%). */
  veilMobile: 0.35,
  /** Solid footer band, last 96 px of the page (recipe step 7: #0B0D0F, alpha 240/255). */
  footerBandPx: 96,
  footerBandAlpha: 0.94,
  /** Text plate: #0B0D0F at 92% (README §4 "bg plate"). */
  plateAlpha: 0.92,
  /** Grade filter (recipe steps 1–2): grayscale, contrast ×1.15, brightness. */
  contrast: 1.15,
  brightness: 0.5,
  /** Cream multiply layer = the duotone's white point (#EADFB6). */
  duotoneWhite: '#EADFB6',
} as const
