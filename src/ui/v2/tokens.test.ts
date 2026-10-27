/**
 * @vitest-environment node
 *
 * [ADR-025] Snapshot pins every Round 2 pack README §4 value. PACK_* literals are copied from the pack
 * (README.md line refs in comments), NOT imported from tokens.ts, so a drive-by edit to either side fails.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../../tailwind.config'
import v2Config from '../../../tailwind.v2.config'
import { V2_COLORS, V2_RADIUS } from './tokens'

const CSS = readFileSync(join(__dirname, 'tokens.css'), 'utf8')

// README.md:76-78
const PACK_COLORS = {
  bg: '#0B0D0F', surface: '#15171A', surface2: '#1B1E22', border: '#2A2D31',
  cream: '#EADFB6', teal: '#6B9B94', text: '#F2EEE3', muted: '#A8A498', dim: '#8C887F',
  red: '#FF5C7A', green: '#7FC8A0', amber: '#E3B341',
}
// README.md:88-90 (CSS variable names)
const PACK_CSS_COLORS: Record<string, string> = {
  '--bg': '#0B0D0F', '--surface': '#15171A', '--surface-2': '#1B1E22', '--border': '#2A2D31',
  '--cream': '#EADFB6', '--teal': '#6B9B94', '--text': '#F2EEE3', '--muted': '#A8A498', '--dim': '#8C887F',
  '--red': '#FF5C7A', '--green': '#7FC8A0', '--amber': '#E3B341',
}
// README.md:84 (tailwind) + :93 (css)
const PACK_RADIUS = { card: '16px', control: '10px', chip: '999px' }

function cssVars(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
// The first `.ts-v2 { ... }` rule (the token block), excluding the reduced-motion media block.
const TOKEN_BLOCK = /\.ts-v2 \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? ''
const VARS = cssVars(TOKEN_BLOCK)

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('§4 colors', () => {
  it('tokens.ts matches the pack literals', () => {
    expect(V2_COLORS).toEqual(PACK_COLORS)
    expect(V2_RADIUS).toEqual(PACK_RADIUS)
  })

  it('tokens.css declares every §4 color variable with the pack value', () => {
    for (const [name, value] of Object.entries(PACK_CSS_COLORS)) {
      expect(VARS[name], name).toBe(value)
    }
  })

  it('red is the single #FF5C7A; the retired #D9776B never appears', () => {
    expect(VARS['--red']).toBe('#FF5C7A')
    expect(CSS.toUpperCase()).not.toContain('D9776B')
  })
})

describe('§4 radius, fonts, motion', () => {
  it('radius card 16px / control 10px', () => {
    expect(VARS['--radius-card']).toBe('16px')
    expect(VARS['--radius-control']).toBe('10px')
  })

  it('font stacks end with the §4 stack (README.md:91-92) and lead with the next/font variable', () => {
    expect(VARS['--font-display']).toBe('var(--font-barlow),"Barlow Condensed",sans-serif')
    // Round 7 D1: body = IBM Plex Sans. `--font-sans` stays as the alias the Tailwind `v2-sans` family reads.
    expect(VARS['--font-body']).toBe('var(--font-plex-sans),"IBM Plex Sans",system-ui,sans-serif')
    expect(VARS['--font-sans']).toBe('var(--font-body)')
    expect(VARS['--font-mono']).toBe('var(--font-plex-mono),"IBM Plex Mono",monospace')
    expect(VARS['--font-hand']).toBe('Caveat,cursive')
  })

  it('Round 7 no-box tokens: hairline ladder, square CTA, the six landing.css scrims', () => {
    // literals copied from round7 landing/landing/landing.css (not imported from tokens.css)
    expect(VARS['--hairline']).toBe('rgba(234,223,182,.16)')
    expect(VARS['--hairline-rule']).toBe('rgba(234,223,182,.35)')
    expect(VARS['--hairline-ring']).toBe('rgba(234,223,182,.47)')
    expect(VARS['--hairline-underline']).toBe('rgba(234,223,182,.6)')
    expect(VARS['--radius-cta']).toBe('0px')
    expect(VARS['--scrim-left']).toBe('linear-gradient(90deg,rgba(11,13,15,.8) 0%,rgba(11,13,15,.6) 45%,rgba(11,13,15,.3) 75%,rgba(11,13,15,.3) 100%)')
    expect(VARS['--scrim-left-race']).toBe('linear-gradient(90deg,rgba(11,13,15,.8) 0%,rgba(11,13,15,.6) 40%,rgba(11,13,15,.2) 65%,rgba(11,13,15,.2) 100%)')
    expect(VARS['--scrim-left-features']).toBe('linear-gradient(90deg,rgba(11,13,15,.82) 0%,rgba(11,13,15,.62) 38%,rgba(11,13,15,.25) 70%,rgba(11,13,15,.25) 100%)')
    expect(VARS['--scrim-down']).toBe('linear-gradient(180deg,rgba(11,13,15,.55),rgba(11,13,15,.45))')
    expect(VARS['--scrim-down-features']).toBe('linear-gradient(180deg,rgba(11,13,15,.5),rgba(11,13,15,.42))')
  })

  it('motion tokens are the pack values (ARCHITECT_BRIEF.md:24) plus the §4 "Motion language" table (MOTION-SPEC, round 6)', () => {
    expect(VARS['--t-toast']).toBe('160ms')
    expect(VARS['--t-shimmer']).toBe('1.2s')
    expect(VARS['--ease-out']).toBe('cubic-bezier(0.2,0.8,0.2,1)')
    expect(VARS['--ease-inout']).toBe('cubic-bezier(0.65,0,0.35,1)')
    expect(VARS['--t-fast']).toBe('120ms')
    expect(VARS['--t-base']).toBe('160ms')
    expect(VARS['--t-slow']).toBe('180ms')
    expect(VARS['--t-underline']).toBe('600ms')
  })

  it('landing photo tokens: 900 ms cross-fade + 1600 ms scale (owner decision, 26 Oct review — supersedes MOTION-SPEC §3 "180 ms")', () => {
    expect(VARS['--t-photo']).toBe('900ms')
    expect(VARS['--t-photo-scale']).toBe('1600ms')
    expect(VARS['--t-slow']).toBe('180ms') // untouched: still the pack value for everything that is not the photo stack
  })

  it('prefers-reduced-motion zeroes the v2 motion tokens and kills transitions + animations', () => {
    const rm = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/.exec(CSS)?.[1] ?? ''
    expect(rm).toMatch(/--t-toast:0ms/)
    expect(rm).toMatch(/--t-shimmer:0s/)
    for (const t of ['--t-fast', '--t-base', '--t-slow', '--t-underline', '--t-photo', '--t-photo-scale']) expect(rm).toContain(`${t}:0ms`)
    expect(rm).toMatch(/animation:\s*none\s*!important/)
    expect(rm).toMatch(/transition:\s*none\s*!important/)
  })

  it('dark only: color-scheme dark, no light theme', () => {
    expect(TOKEN_BLOCK).toMatch(/color-scheme:\s*dark/)
    expect(CSS).not.toMatch(/prefers-color-scheme|\.light\b/)
  })
})

describe('§4 contrast claims (README.md:96)', () => {
  const r1 = (n: number) => Math.round(n * 10) / 10
  it('dim 5.5 / 5.1 / 4.7 on bg / surface / surface-2', () => {
    expect([PACK_COLORS.bg, PACK_COLORS.surface, PACK_COLORS.surface2].map((b) => r1(contrast(PACK_COLORS.dim, b)))).toEqual([5.5, 5.1, 4.7])
  })
  it('muted 7.8 / 7.2 / 6.7 on bg / surface / surface-2', () => {
    expect([PACK_COLORS.bg, PACK_COLORS.surface, PACK_COLORS.surface2].map((b) => r1(contrast(PACK_COLORS.muted, b)))).toEqual([7.8, 7.2, 6.7])
  })
})

describe('Tailwind v2 scope (own pass: tailwind.v2.config.ts)', () => {
  const v2 = v2Config.theme?.extend as {
    colors: Record<string, unknown>
    fontFamily: Record<string, string[]>
    borderRadius: Record<string, string>
  }
  const main = config.theme?.extend as {
    colors: Record<string, unknown>
    fontFamily: Record<string, string[]>
    borderRadius?: Record<string, string>
  }

  it('v2 config: the §4 palette only under the `v2` namespace; radius + families v2-prefixed → .ts-v2 variables', () => {
    expect(v2.colors).toEqual({ v2: PACK_COLORS })
    expect(v2.borderRadius).toEqual({ 'v2-card': '16px', 'v2-control': '10px', 'v2-chip': '999px' })
    expect(v2.fontFamily).toEqual({
      'v2-display': ['var(--font-display)'],
      'v2-sans': ['var(--font-sans)'],
      'v2-mono': ['var(--font-mono)'],
      'v2-hand': ['var(--font-hand)'],
    })
  })

  it('v2 config scans only the v2 tree', () => {
    expect(v2Config.content).toEqual(['./src/ui/v2/**/*.{ts,tsx}', './src/app/v2/**/*.{ts,tsx}'])
  })

  it('main (v1) config has no v2 theme and does not scan the v2 tree — v1 CSS output is unchanged', () => {
    expect(main.colors).not.toHaveProperty('v2')
    expect(Object.keys(main.fontFamily).filter((k) => k.startsWith('v2-'))).toEqual([])
    expect(main.borderRadius).toBeUndefined()
    expect(config.content).toEqual(['./src/**/*.{js,ts,jsx,tsx,mdx}', '!./src/ui/v2/**', '!./src/app/v2/**'])
    for (const leaked of ['bg', 'surface2', 'teal', 'muted', 'dim', 'red', 'green', 'amber']) {
      expect(main.colors, leaked).not.toHaveProperty(leaked)
    }
    expect((main.colors.surface as Record<string, string>).DEFAULT).toBe('#080B10')
    expect((main.colors.cream as Record<string, string>).DEFAULT).toBe('#F5F0E8')
    expect(main.fontFamily.display).toEqual(['var(--font-inter)', 'sans-serif'])
  })

  it('v2.css loads tokens + v2 utilities only (no base/components → no duplicate preflight)', () => {
    const entry = readFileSync(join(__dirname, 'v2.css'), 'utf8')
    expect(entry).toMatch(/@import '\.\/tokens\.css'/)
    expect(entry).toMatch(/@config "\.\.\/\.\.\/\.\.\/tailwind\.v2\.config\.ts"/)
    expect(entry).toMatch(/@tailwind utilities;/)
    expect(entry).not.toMatch(/@tailwind (base|components)/)
  })
})
