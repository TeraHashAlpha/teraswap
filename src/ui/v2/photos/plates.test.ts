/**
 * @vitest-environment node
 *
 * [ADR-025] Text plates: every text token that can land on open photo is legible on the plate (#0B0D0F @ 92%).
 * Body text ≥ 4.5:1, large text ≥ 3:1 (WCAG AA). Worst case is modelled two ways: the graded photo's brightest
 * possible pixel (white through the CSS grade + cream multiply + veil), and — stricter — pure white under the plate.
 * Large text (hero headline) also has to clear 3:1 straight on the graded photo, no plate.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { V2_COLORS } from '../tokens'
import { composite, contrastRatio, hexToRgb, luminance, type RGB } from './contrast'
import type { NarrativePhotoId } from './narrative'
import { PHOTO_TOKENS } from './photo-tokens'
import { TAB_PHOTO } from './tab-photos'

const BG = hexToRgb(V2_COLORS.bg)
const WHITE: RGB = [255, 255, 255]

/** Brightest pixel the photo layer can show: white → contrast → brightness → ×cream → veil over --bg. */
function worstGradedPhotoPixel(): RGB {
  const graded = Math.min(255, (255 - 128) * PHOTO_TOKENS.contrast + 128) * PHOTO_TOKENS.brightness
  const cream = hexToRgb(PHOTO_TOKENS.duotoneWhite)
  const toned = cream.map((c) => (graded * c) / 255) as unknown as RGB
  return composite(BG, PHOTO_TOKENS.veil, toned)
}

const PLATE_ON_PHOTO = composite(BG, PHOTO_TOKENS.plateAlpha, worstGradedPhotoPixel())
const PLATE_ON_WHITE = composite(BG, PHOTO_TOKENS.plateAlpha, WHITE)

const BODY_TOKENS = ['text', 'muted', 'dim', 'teal', 'cream', 'green', 'amber', 'red'] as const
const LARGE_TOKENS = ['text', 'cream', 'muted'] as const

const rows: string[] = []
const fmt = (n: number) => n.toFixed(2).padStart(5)

describe('text plates (token pairs)', () => {
  it.each(BODY_TOKENS)('body text: %s on the plate ≥ 4.5 (graded-photo worst case and pure-white worst case)', (name) => {
    const fg = hexToRgb(V2_COLORS[name])
    const onPhoto = contrastRatio(fg, PLATE_ON_PHOTO)
    const onWhite = contrastRatio(fg, PLATE_ON_WHITE)
    rows.push(`body  ${name.padEnd(6)} ${V2_COLORS[name]}  plate/photo ${fmt(onPhoto)}  plate/white ${fmt(onWhite)}  (min 4.5)`)
    expect(onPhoto).toBeGreaterThanOrEqual(4.5)
    expect(onWhite).toBeGreaterThanOrEqual(4.5)
  })

  it.each(LARGE_TOKENS)('large text: %s on the plate ≥ 3', (name) => {
    const fg = hexToRgb(V2_COLORS[name])
    const onWhite = contrastRatio(fg, PLATE_ON_WHITE)
    rows.push(`large ${name.padEnd(6)} ${V2_COLORS[name]}  plate/white ${fmt(onWhite)}  (min 3.0)`)
    expect(onWhite).toBeGreaterThanOrEqual(3)
  })

  it.each(['text', 'cream'] as const)('large hero text: %s straight on the brightest graded-photo pixel ≥ 3 (no plate)', (name) => {
    const ratio = contrastRatio(hexToRgb(V2_COLORS[name]), worstGradedPhotoPixel())
    rows.push(`hero  ${name.padEnd(6)} ${V2_COLORS[name]}  graded-photo worst ${fmt(ratio)}  (min 3.0)`)
    expect(ratio).toBeGreaterThanOrEqual(3)
  })

  it('records the measured pairs (copied into the feedback evidence)', () => {
    console.info(
      [
        `plate #0B0D0F @ ${PHOTO_TOKENS.plateAlpha} → over graded-photo worst pixel rgb(${worstGradedPhotoPixel()}) = rgb(${PLATE_ON_PHOTO}); over white = rgb(${PLATE_ON_WHITE})`,
        ...rows,
      ].join('\n'),
    )
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('Round 7 app scrim: content sits on the shell photo with no box', () => {
  it('the scrim is the recipe\'s BG α 120/255 and the CSS twin says the same', () => {
    expect(PHOTO_TOKENS.appScrim).toBeCloseTo(120 / 255, 2)
    const css = readFileSync(join(__dirname, 'photo.css'), 'utf8')
    expect(css).toContain(`--photo-app-scrim: ${PHOTO_TOKENS.appScrim};`)
  })

  // Owner addition (round 7): the shell paints each tab's BAKED photo, so the worst case is no longer the CSS grade's
  // theoretical white but the shipped files — the 95th-percentile pixel of every tab's photo (the landing's narrative-contrast
  // method), under the constant veil, the app scrim and (≤ 639 px) the extra mobile veil, at both file sizes and formats.
  const TABS = Object.entries(TAB_PHOTO) as [string, NarrativePhotoId][]
  const SIZES = [['desktop', 1920, 192, 108], ['mobile', 1080, 108, 192]] as const
  const BODY_ON_APP = ['text', 'muted', 'cream', 'teal', 'green', 'amber', 'red'] as const
  const VEIL: RGB = BG

  async function appLuminances(photo: NarrativePhotoId, file: 1920 | 1080, w: number, h: number, ext: 'avif' | 'webp', mobile: boolean): Promise<number[]> {
    const { data } = await sharp(join(__dirname, 'narrative', `bg-${photo}-${file}.${ext}`)).resize(w, h, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const out: number[] = []
    for (let i = 0; i < data.length; i += 3) {
      let c = composite(VEIL, PHOTO_TOKENS.bakedVeil, [data[i], data[i + 1], data[i + 2]])
      if (mobile) c = composite(BG, PHOTO_TOKENS.veilMobile, c) // ≤ 639 px: the extra mobile veil sits UNDER the scrim in the DOM
      out.push(luminance(composite(BG, PHOTO_TOKENS.appScrim, c)))
    }
    return out.sort((a, b) => a - b)
  }
  const p95 = (l: number[]) => l[Math.min(l.length - 1, Math.floor(l.length * 0.95))]
  const ratioOnL = (fg: RGB, bgL: number) => {
    const [hi, lo] = [luminance(fg), bgL].sort((a, b) => b - a)
    return (hi + 0.05) / (lo + 0.05)
  }

  it.each(BODY_ON_APP)('%s body text clears 4.5 over every tab\'s baked photo (p95 pixel) + veil + app scrim, desktop and mobile, AVIF and WebP', async (name) => {
    const fg = hexToRgb(V2_COLORS[name])
    let worst = Infinity
    let where = ''
    for (const [tab, photo] of TABS) {
      for (const [vp, file, w, h] of SIZES) {
        for (const ext of ['avif', 'webp'] as const) {
          const r = ratioOnL(fg, p95(await appLuminances(photo, file, w, h, ext, vp === 'mobile')))
          if (r < worst) [worst, where] = [r, `${tab}=${photo} ${vp} ${ext}`]
        }
      }
    }
    rows.push(`app    ${name.padEnd(6)} ${V2_COLORS[name]}  8 baked tab photos + veil + app scrim: worst ${fmt(worst)} @ ${where}  (min 4.5)`)
    expect(worst, where).toBeGreaterThanOrEqual(4.5)
  })

  afterAll(() => {
    if (process.env.TS_CONTRAST_OUT) writeFileSync(process.env.TS_CONTRAST_OUT, rows.filter((r) => r.startsWith('app ')).join('\n') + '\n')
  })
})

describe('contrast helper', () => {
  it('reproduces the pack\'s own §4 figures: dim 5.5 on bg, muted 7.8 on bg', () => {
    expect(contrastRatio(hexToRgb(V2_COLORS.dim), BG)).toBeCloseTo(5.5, 1)
    expect(contrastRatio(hexToRgb(V2_COLORS.muted), BG)).toBeCloseTo(7.8, 1)
  })
})
