/**
 * @vitest-environment node
 *
 * [ADR-025] Round 7 contrast over every surface the no-box language puts text on (WCAG 2.x AA: ≥ 4.5 body, ≥ 3 large and
 * non-text UI edges). Pairs, all read from tokens.css so a drive-by token edit fails here:
 *   1. text tokens on the solid surfaces (--bg: sheet / strip / drawer · --surface: popover) and on the credit plate;
 *   2. text tokens on each local scrim, at its WEAKEST stop, over the brightest pixel the graded photo can show
 *      (same worst-case model as photos/plates.test.ts). Pure white is NOT modelled under a scrim: the photos are
 *      pre-graded (never white), and only the solid plate has to survive a white page behind it;
 *   3. the non-text edges: the input's idle underline (--hairline-ring) and the switch ring need ≥ 3:1 on --bg; the
 *      decorative separators (--hairline, --hairline-rule) are recorded, not asserted (WCAG 1.4.11 exempts them).
 * The measured numbers are printed once at the end (copied into the feedback evidence).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composite, contrastRatio, hexToRgb, type RGB } from '../photos/contrast'
import { PHOTO_TOKENS } from '../photos/photo-tokens'
import { V2_COLORS } from '../tokens'

const CSS = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')
const BG = hexToRgb(V2_COLORS.bg)
const SURFACE = hexToRgb(V2_COLORS.surface)
const WHITE: RGB = [255, 255, 255]
const fmt = (n: number) => n.toFixed(2).padStart(5)
const rows: string[] = []

function token(name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(CSS)
  if (!m) throw new Error(`token ${name} not in tokens.css`)
  return m[1].trim()
}
/** Every rgba(11,13,15,a) stop of a scrim token, as alphas. */
const stops = (name: string) => [...token(name).matchAll(/rgba\(11,13,15,([\d.]+)\)/g)].map((m) => Number(m[1]))

/** Brightest pixel the photo layer can show (white → contrast → brightness → ×cream → veil), as in plates.test.ts. */
function worstGradedPhotoPixel(): RGB {
  const graded = Math.min(255, (255 - 128) * PHOTO_TOKENS.contrast + 128) * PHOTO_TOKENS.brightness
  const cream = hexToRgb(PHOTO_TOKENS.duotoneWhite)
  const toned = cream.map((c) => (graded * c) / 255) as unknown as RGB
  return composite(BG, PHOTO_TOKENS.veil, toned)
}
const PHOTO = worstGradedPhotoPixel()

const BODY = ['text', 'muted', 'cream'] as const // what the redesign sets as body copy / labels on photo and surfaces
const SCRIMS = ['--scrim-left', '--scrim-left-race', '--scrim-left-features', '--scrim-down', '--scrim-down-features'] as const

describe('solid surfaces and the credit plate', () => {
  it.each([
    ['--bg (sheet · strip · drawer)', BG],
    ['--surface (popover)', SURFACE],
    ['credit plate over worst photo', composite(BG, PHOTO_TOKENS.plateAlpha, PHOTO)],
    ['credit plate over white', composite(BG, PHOTO_TOKENS.plateAlpha, WHITE)],
  ] as const)('text tokens on %s ≥ 4.5', (label, under) => {
    for (const name of ['text', 'muted', 'cream', 'red', 'green', 'amber', 'teal'] as const) {
      const r = contrastRatio(hexToRgb(V2_COLORS[name]), under)
      rows.push(`solid  ${label.padEnd(32)} ${name.padEnd(5)} ${fmt(r)}`)
      expect(r, `${name} on ${label}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('dim is for disabled / credit text only: ≥ 4.5 on --bg and on the plate over white', () => {
    const dim = hexToRgb(V2_COLORS.dim)
    expect(contrastRatio(dim, BG)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dim, composite(BG, PHOTO_TOKENS.plateAlpha, WHITE))).toBeGreaterThanOrEqual(4.5)
  })
})

describe('local scrims (tokens.css) over the worst photo pixel', () => {
  it('reads every scrim token (guard is not vacuous)', () => {
    for (const s of SCRIMS) expect(stops(s).length, s).toBeGreaterThanOrEqual(2)
  })

  it.each(SCRIMS)('%s: body text at its weakest stop clears 4.5 over the worst photo pixel', (name) => {
    const weakest = Math.min(...stops(name))
    const under = composite(BG, weakest, PHOTO)
    for (const t of BODY) {
      const r = contrastRatio(hexToRgb(V2_COLORS[t]), under)
      rows.push(`scrim  ${name.padEnd(24)} weakest α${weakest.toFixed(2)} ${t.padEnd(5)} ${fmt(r)}  (photo worst case)`)
      expect(r, `${t} on ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('stronger at the copy side: the text-side stop (first) is darker than the photo-side stop (last) in every left scrim', () => {
    for (const s of ['--scrim-left', '--scrim-left-race', '--scrim-left-features'] as const) {
      const a = stops(s)
      expect(a[0]).toBeGreaterThan(a[a.length - 1])
    }
  })
})

describe('non-text edges', () => {
  const edge = (name: string, alpha: number) => composite(hexToRgb(V2_COLORS.cream), alpha, BG)
  const alphaOf = (name: string) => Number(/,([\d.]+)\)/.exec(token(name))![1])

  it('input idle underline (--hairline-ring) and the switch ring are ≥ 3:1 on --bg (WCAG 1.4.11)', () => {
    const a = alphaOf('--hairline-ring')
    const r = contrastRatio(edge('--hairline-ring', a), BG)
    rows.push(`edge   --hairline-ring α${a}  ${fmt(r)}  (min 3.0)`)
    expect(r).toBeGreaterThanOrEqual(3)
  })

  it('the selected-chip / text-button underline (--hairline-underline) is ≥ 3:1 on --bg', () => {
    const a = alphaOf('--hairline-underline')
    const r = contrastRatio(edge('--hairline-underline', a), BG)
    rows.push(`edge   --hairline-underline α${a}  ${fmt(r)}  (min 3.0)`)
    expect(r).toBeGreaterThanOrEqual(3)
  })

  it('decorative separators are recorded, not asserted', () => {
    for (const n of ['--hairline', '--hairline-rule']) {
      const a = alphaOf(n)
      rows.push(`sep    ${n} α${a}  ${fmt(contrastRatio(edge(n, a), BG))}  (decorative, exempt)`)
    }
    expect(rows.length).toBeGreaterThan(0)
  })

  it('prints the measured pairs (copied into the feedback evidence)', () => {
    console.info(`worst graded photo pixel rgb(${PHOTO})\n${rows.join('\n')}`)
    expect(rows.length).toBeGreaterThan(40)
  })
})
