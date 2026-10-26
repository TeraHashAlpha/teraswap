/**
 * [ADR-025] v2 display + mono fonts, self-hosted via next/font/local (no CDN — same rule as #565).
 * Inter is NOT loaded here: v2 reuses the `--font-inter` variable already set on <html> by the root layout.
 * Files + OFL licences: src/ui/v2/fonts/ (provenance in its README). Loaded files are the Latin woff2 subsets in
 * fonts/latin/ (≤ 60 KB each, generated from the TTF masters beside them; command in the README).
 */
import localFont from 'next/font/local'

// Headlines only, uppercase, Bold (foundation 00: "Barlow Condensed Bold · uppercase · headlines only").
const barlowCondensed = localFont({
  src: './fonts/latin/BarlowCondensed-Bold.latin.woff2',
  weight: '700',
  display: 'swap',
  variable: '--font-barlow',
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
export const v2FontClassNames = `${barlowCondensed.variable} ${ibmPlexMono.variable}`
