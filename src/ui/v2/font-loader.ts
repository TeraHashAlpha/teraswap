/**
 * [ADR-025] v2 display + mono fonts, self-hosted via next/font/local (no CDN — same rule as #565).
 * Inter is NOT loaded here: v2 reuses the `--font-inter` variable already set on <html> by the root layout.
 * Files + OFL licences: src/ui/v2/fonts/ (provenance in its README).
 */
import localFont from 'next/font/local'

// Headlines only, uppercase, Bold (foundation 00: "Barlow Condensed Bold · uppercase · headlines only").
const barlowCondensed = localFont({
  src: './fonts/BarlowCondensed-Bold.ttf',
  weight: '700',
  display: 'swap',
  variable: '--font-barlow',
})

// Numbers, addresses, eyebrows, buttons (Plex Mono 700).
const ibmPlexMono = localFont({
  src: [
    { path: './fonts/IBMPlexMono-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexMono-Medium.ttf', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexMono-Bold.ttf', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-plex-mono',
})

/** Put on the v2 root next to `ts-v2` so the CSS variables resolve. */
export const v2FontClassNames = `${barlowCondensed.variable} ${ibmPlexMono.variable}`
