/**
 * [ADR-025] v2 display, body + mono fonts, self-hosted via next/font/local (no CDN — same rule as #565).
 * Round 7 D1: the body face is IBM Plex Sans (one variable file, wght 400–700); v2 no longer reads the root layout's
 * body-font variable at all.
 * Files + OFL licences: src/ui/v2/fonts/ (provenance in its README). Loaded files are the Latin woff2 subsets in
 * fonts/latin/ (≤ 60 KB each, generated from the masters beside them; command in the README).
 */
import localFont from 'next/font/local'

// Headlines only, uppercase, Bold (foundation 00: "Barlow Condensed Bold · uppercase · headlines only").
const barlowCondensed = localFont({
  src: './fonts/latin/BarlowCondensed-Bold.latin.woff2',
  weight: '700',
  display: 'swap',
  variable: '--font-barlow',
})

// Body copy, labels, form text — one variable file covers 400…700 (Round 7 D1).
const ibmPlexSans = localFont({
  src: './fonts/latin/IBMPlexSans-wght400-700.latin.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-plex-sans',
})

// Numbers, addresses, eyebrows, buttons (Plex Mono 700).
const ibmPlexMono = localFont({
  src: [
    { path: './fonts/latin/IBMPlexMono-Regular.latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/latin/IBMPlexMono-Medium.latin.woff2', weight: '500', style: 'normal' },
    { path: './fonts/latin/IBMPlexMono-Bold.latin.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-plex-mono',
})

/** Put on the v2 root next to `ts-v2` so the CSS variables resolve. */
export const v2FontClassNames = `${barlowCondensed.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable}`

/**
 * The hashed @font-face family next/font registers for Plex Sans. Portalled UI (the RainbowKit modal) renders outside
 * `.ts-v2`, where the `--font-plex-sans` variable does not resolve; the family name itself does (the @font-face is global).
 */
export const v2BodyFontFamily = `${ibmPlexSans.style.fontFamily}, "IBM Plex Sans", system-ui, sans-serif`
