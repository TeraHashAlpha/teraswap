/**
 * [ADR-025] UI v2 design tokens — source: Round 2 pack README §4 (README.md:76-78 colors, :84 radius).
 * Single source for the Tailwind `v2` theme extension; tokens.css carries the same values as CSS variables
 * and tokens.test.ts pins both to the pack literals.
 */
export const V2_COLORS = {
  bg: '#0B0D0F',
  surface: '#15171A',
  surface2: '#1B1E22',
  border: '#2A2D31',
  cream: '#EADFB6',
  teal: '#6B9B94',
  text: '#F2EEE3',
  muted: '#A8A498',
  dim: '#8C887F',
  red: '#FF5C7A',
  green: '#7FC8A0',
  amber: '#E3B341',
} as const

export const V2_RADIUS = { card: '16px', control: '10px', chip: '999px' } as const
