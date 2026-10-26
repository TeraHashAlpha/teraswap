import type { Config } from 'tailwindcss'
import { V2_COLORS, V2_RADIUS } from './src/ui/v2/tokens'

/**
 * [ADR-025] Tailwind pass for the v2 tree only (loaded via `@config` in src/ui/v2/v2.css, utilities layer only —
 * preflight/base come from the root layout's globals.css). Names stay `v2`-namespaced (`bg-v2-surface`) because
 * v1's global stylesheet is also on the page and already defines `bg-surface`, `text-cream`, …
 * v1's tailwind.config.ts excludes these paths from its content scan, so v1 CSS output is unchanged.
 */
const config: Config = {
  content: ['./src/ui/v2/**/*.{ts,tsx}', './src/app/v2/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { v2: V2_COLORS },
      fontFamily: {
        // resolve to the `.ts-v2` CSS variables (src/ui/v2/tokens.css)
        'v2-display': ['var(--font-display)'],
        'v2-sans': ['var(--font-sans)'],
        'v2-mono': ['var(--font-mono)'],
        'v2-hand': ['var(--font-hand)'],
      },
      borderRadius: {
        'v2-card': V2_RADIUS.card,
        'v2-control': V2_RADIUS.control,
        'v2-chip': V2_RADIUS.chip,
      },
    },
  },
  plugins: [],
}

export default config
