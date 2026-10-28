/**
 * @vitest-environment node
 *
 * [ADR-025] The per-photo app scrim (B3 C3), recomputed from the SHIPPED files (same method as landing/narrative-contrast.test.ts):
 * for each of the 8 tab photos, the #0B0D0F scrim over the baked photo + constant veil is raised from 0 in 0.01 steps until
 * every app text token clears AA against the 95th-percentile luminance of what is behind it — ≥ 4.5 for body-size text
 * (text, cream, muted, teal, green, amber, red), ≥ 3 for large text (the dim amount placeholder). Both viewports (the phone adds
 * the 35 % mobile veil), both formats. `photoScrim` must equal that minimum, except DCA, which the owner keeps at 0.47.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { composite, contrastRatio, hexToRgb, luminance, type RGB } from './contrast'
import { PHOTO_TOKENS } from './photo-tokens'
import { photoScrim, scrimForTab } from './photo-scrim'
import { TAB_PHOTO } from './tab-photos'
import { V2_COLORS } from '../tokens'
import { V2_TABS } from '../shell/tab-paths'
import type { NarrativePhotoId } from './narrative'

const BG = hexToRgb(V2_COLORS.bg)
const tok = (n: keyof typeof V2_COLORS) => hexToRgb(V2_COLORS[n])
const BODY: [string, RGB][] = (['text', 'cream', 'muted', 'teal', 'green', 'amber', 'red'] as const).map((n) => [n, tok(n)])
const LARGE: [string, RGB][] = [['dim', tok('dim')]]
const SIZE = { desktop: { file: 1920, w: 192, h: 108, mobileVeil: 0 }, mobile: { file: 1080, w: 108, h: 192, mobileVeil: PHOTO_TOKENS.veilMobile } } as const
type Viewport = keyof typeof SIZE

async function pixels(photo: NarrativePhotoId, vp: Viewport, ext: 'avif' | 'webp'): Promise<RGB[]> {
  const { file, w, h } = SIZE[vp]
  const { data } = await sharp(join(__dirname, 'narrative', `bg-${photo}-${file}.${ext}`)).resize(w, h, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const out: RGB[] = []
  for (let i = 0; i < data.length; i += 3) out.push([data[i], data[i + 1], data[i + 2]])
  return out
}

/** The backdrop colour at the 95th-percentile luminance once the layers are on: baked veil → mobile veil → scrim α. */
function p95Backdrop(px: RGB[], vp: Viewport, alpha: number): RGB {
  const layered = px
    .map((c) => {
      let v = composite(BG, PHOTO_TOKENS.bakedVeil, c)
      if (SIZE[vp].mobileVeil) v = composite(BG, SIZE[vp].mobileVeil, v)
      return composite(BG, alpha, v)
    })
    .sort((a, b) => luminance(a) - luminance(b))
  return layered[Math.floor(0.95 * (layered.length - 1))]
}

const passes = (backdrop: RGB) => BODY.every(([, c]) => contrastRatio(c, backdrop) >= 4.5) && LARGE.every(([, c]) => contrastRatio(c, backdrop) >= 3)

const SETS = (['desktop', 'mobile'] as const).flatMap((vp) => (['avif', 'webp'] as const).map((ext) => ({ vp, ext })))
const ids = Object.keys(TAB_PHOTO).map((t) => TAB_PHOTO[t as keyof typeof TAB_PHOTO])

/** The lowest α (0.01 steps) at which the photo passes in EVERY viewport/format. */
async function minimumScrim(photo: NarrativePhotoId): Promise<number> {
  const sets = await Promise.all(SETS.map(async (s) => ({ ...s, px: await pixels(photo, s.vp, s.ext) })))
  for (let a = 0; a <= 100; a++) {
    if (sets.every((s) => passes(p95Backdrop(s.px, s.vp, a / 100)))) return a / 100
  }
  throw new Error(`${photo}: no scrim up to 1.0 reaches AA`)
}

describe('photoScrim: one value per baked photo', () => {
  it('has exactly the 8 tab photos, each in [0, 1]', () => {
    expect(Object.keys(photoScrim).sort()).toEqual([...new Set(ids)].sort())
    expect(ids).toHaveLength(8)
    for (const v of Object.values(photoScrim)) expect(v >= 0 && v <= 1).toBe(true)
  })

  it('DCA keeps the round-7 0.47; every other tab is below it', () => {
    expect(scrimForTab('dca')).toBe(0.47)
    expect(scrimForTab('dca')).toBe(PHOTO_TOKENS.appScrim)
    for (const t of V2_TABS) if (t.id !== 'dca') expect(scrimForTab(t.id)).toBeLessThan(0.47)
  })

  it('every photo clears AA (≥ 4.5 body, ≥ 3 large) at its scrim and is the LOWEST value that does (DCA: pinned, ≥ minimum)', async () => {
    const rows: string[] = ['photo      scrim  min    muted   teal   dim(large)  (worst of desktop/mobile × avif/webp)']
    for (const photo of [...new Set(ids)]) {
      const min = await minimumScrim(photo)
      const sets = await Promise.all(SETS.map(async (s) => ({ ...s, px: await pixels(photo, s.vp, s.ext) })))
      const backs = sets.map((s) => p95Backdrop(s.px, s.vp, photoScrim[photo]))
      for (const b of backs) {
        for (const [name, c] of BODY) expect(contrastRatio(c, b), `${photo} ${name}`).toBeGreaterThanOrEqual(4.5)
        for (const [name, c] of LARGE) expect(contrastRatio(c, b), `${photo} ${name} (large)`).toBeGreaterThanOrEqual(3)
      }
      if (photo === 'underpass') expect(photoScrim[photo]).toBeGreaterThanOrEqual(min)
      else expect(photoScrim[photo], `${photo}: lowest value keeping AA`).toBe(min)
      const worst = (c: RGB) => Math.min(...backs.map((b) => contrastRatio(c, b)))
      rows.push(`${photo.padEnd(10)} ${photoScrim[photo].toFixed(2)}   ${min.toFixed(2)}   ${worst(tok('muted')).toFixed(2)}    ${worst(tok('teal')).toFixed(2)}   ${worst(tok('dim')).toFixed(2)}`)
    }
    if (process.env.SCRIM_REPORT) writeFileSync(process.env.SCRIM_REPORT, rows.join('\n') + '\n')
  }, 60_000)

  it('the shipped bg-zakim is the pack\'s own (round 7 `bg-zakim` zip), not the earlier self-baked copy', () => {
    const readme = readFileSync(join(__dirname, 'narrative', 'README.md'), 'utf8')
    expect(readme).toMatch(/bg-zakim[^\n]*round 7 pack/i)
    expect(readme).not.toMatch(/baked here/i)
  })
})
