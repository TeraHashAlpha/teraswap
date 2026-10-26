/**
 * @vitest-environment node
 *
 * [ADR-025] Contrast of every scroll-narrative state (round-6 MOTION-SPEC §8, same method as `frames_qa.py`): each text
 * token is compared with the 95th-percentile luminance of the background it sits on, WCAG AA — ≥ 4.5 body, ≥ 3 large.
 *  - text straight on the photo (headings, copy): the shipped, pre-graded photo files decoded with sharp, the constant
 *    veil (`--nar-veil`, read from narrative.css) over them. States: every photo × desktop (1920) / mobile (1080), the
 *    cross-fade between every neighbouring pair (both layer orders, progress 0.1 … 0.9 — the layers fade in opposite
 *    directions over the page `--bg`), and reduced motion (the same veiled photo painted on the section).
 *  - text on panels, badges and the credit plate: fixed token pairs (the plate over the brightest pixel of any state).
 *  - flat modes (reduced transparency / more contrast / forced colours): tokens straight on `--bg`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { composite, contrastRatio, hexToRgb, luminance, type RGB } from '../photos/contrast'
import { PHOTO_TOKENS } from '../photos/photo-tokens'
import { V2_COLORS } from '../tokens'
import { NARRATIVE_SECTIONS, SECTION_PHOTO, photosFor, type NarrativeSectionId } from './narrative'
import type { NarrativePhotoId } from '../photos/narrative'

const CSS = readFileSync(join(__dirname, 'narrative.css'), 'utf8')
const [VEIL_R, VEIL_G, VEIL_B, VEIL_A] = /--nar-veil:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(CSS)!.slice(1).map(Number)
const VEIL: RGB = [VEIL_R, VEIL_G, VEIL_B]
const BG = hexToRgb(V2_COLORS.bg)
const tok = (name: keyof typeof V2_COLORS) => hexToRgb(V2_COLORS[name])

type Viewport = 'desktop' | 'mobile'
const SIZE: Record<Viewport, { file: 1920 | 1080; w: number; h: number }> = {
  desktop: { file: 1920, w: 192, h: 108 }, // a 16:9 window
  mobile: { file: 1080, w: 108, h: 192 }, // a portrait phone
}

/** The decoded photo as the layer shows it: `cover`, centred, at a small proxy size. */
async function pixels(photo: NarrativePhotoId, vp: Viewport, ext: 'avif' | 'webp'): Promise<Float32Array> {
  const { file, w, h } = SIZE[vp]
  const path = join(__dirname, '..', 'photos', 'narrative', `bg-${photo}-${file}.${ext}`)
  const { data } = await sharp(path).resize(w, h, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return Float32Array.from(data)
}

/** Veil over a composited backdrop (one RGB triple per pixel), as a sorted luminance list. */
function veiledLuminances(px: Float32Array): number[] {
  const out: number[] = []
  for (let i = 0; i < px.length; i += 3) {
    out.push(luminance(composite(VEIL, VEIL_A, [Math.round(px[i]), Math.round(px[i + 1]), Math.round(px[i + 2])])))
  }
  return out.sort((a, b) => a - b)
}
const p95 = (sorted: number[]) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
const lum = (c: RGB) => luminance(c)
const ratioOnLuminance = (fg: RGB, bgLum: number) => {
  const [hi, lo] = [lum(fg), bgLum].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

/** `top` at `alpha` over `under`, pixel by pixel. */
function over(top: Float32Array, alpha: number, under: Float32Array): Float32Array {
  return top.map((v, i) => v * alpha + under[i] * (1 - alpha))
}
const flat = (n: number): Float32Array => new Float32Array(n * 3).map((_, i) => BG[i % 3])

interface State {
  name: string
  /** The sections whose text can be on screen over this backdrop (a cross-fade: the two sections either side of the boundary). */
  sections: NarrativeSectionId[]
  /** Luminance of the veiled backdrop's 95th percentile and its brightest pixel. */
  p95: number
  max: number
}

const sectionsOf = (photo: NarrativePhotoId, vp: Viewport) => NARRATIVE_SECTIONS.filter((s) => SECTION_PHOTO[s][vp] === photo)

const states: State[] = []
async function buildStates() {
  for (const vp of ['desktop', 'mobile'] as const) {
    const ids = photosFor(vp === 'mobile')
    for (const ext of ['avif', 'webp'] as const) {
      const px = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await pixels(id, vp, ext)])))
      for (const id of ids) {
        const l = veiledLuminances(px[id])
        states.push({ name: `${vp} ${ext} ${id} (also: reduced motion)`, sections: sectionsOf(id, vp), p95: p95(l), max: l[l.length - 1] })
      }
      for (let i = 0; i < ids.length - 1; i++) {
        const [a, b] = [px[ids[i]], px[ids[i + 1]]]
        let worst: State = { name: '', sections: [], p95: 0, max: 0 }
        // the fade runs where one group ends and the next begins: the last section of A and the first of B are the ones on screen
        const outgoing = sectionsOf(ids[i], vp)
        const both = [outgoing[outgoing.length - 1], sectionsOf(ids[i + 1], vp)[0]]
        for (let step = 1; step <= 9; step++) {
          const t = step / 10
          const base = flat(a.length / 3)
          // A fades out (1 − t) while B fades in (t); each layer is its own opacity over the layer below, then the page --bg
          const aOverB = over(a, 1 - t, over(b, t, base)) // DOM order: B below A
          const bOverA = over(b, t, over(a, 1 - t, base)) // DOM order: A below B
          for (const mixed of [aOverB, bOverA]) {
            const l = veiledLuminances(mixed)
            if (p95(l) > worst.p95) worst = { name: `${vp} ${ext} cross-fade ${ids[i]}→${ids[i + 1]} (worst of t=0.1…0.9, both layer orders)`, sections: both, p95: p95(l), max: l[l.length - 1] }
          }
        }
        states.push(worst)
      }
    }
  }
}

/**
 * Text that sits straight on the photo (everything else is on an opaque Panel). Per section, from Sections.tsx:
 * security — eyebrow, h2, h3 lead, 16 px copy + semibold emphasis · experience — eyebrow, h2 + second line, 16 px copy ·
 * features — eyebrow, h2, 15 px subline · roadmap, docs — eyebrow, h2 only (landing.test.tsx pins "muted copy only in
 * those three sections").
 */
const ON_PHOTO: { token: keyof typeof V2_COLORS; kind: 'body' | 'large'; need: number; use: string; sections: NarrativeSectionId[] }[] = [
  { token: 'muted', kind: 'body', need: 4.5, use: 'copy / subline 15–16 px', sections: ['security', 'experience', 'features'] },
  { token: 'text', kind: 'body', need: 4.5, use: 'semibold emphasis 16 px', sections: ['security'] },
  { token: 'cream', kind: 'body', need: 4.5, use: 'eyebrow 12 px', sections: [...NARRATIVE_SECTIONS] },
  { token: 'text', kind: 'large', need: 3, use: 'h2 headline 44–80 px', sections: [...NARRATIVE_SECTIONS] },
  { token: 'cream', kind: 'large', need: 3, use: 'h2 second line / h3 lead 30–52 px', sections: ['security', 'experience'] },
]

const PANELS = [
  { bg: 'surface', fg: 'text', need: 4.5, use: 'card title 17 px' },
  { bg: 'surface', fg: 'muted', need: 4.5, use: 'card copy 13–16 px' },
  { bg: 'surface', fg: 'cream', need: 4.5, use: 'stat numeral / label' },
  { bg: 'surface', fg: 'dim', need: 4.5, use: 'SOON badge 10 px' },
  { bg: 'surface2', fg: 'cream', need: 4.5, use: 'PRE-SWAP / POST-SWAP badge 10 px' },
  { bg: 'surface2', fg: 'text', need: 4.5, use: 'docs button' },
  { bg: 'bg', fg: 'text', need: 4.5, use: 'flat mode: body' },
  { bg: 'bg', fg: 'muted', need: 4.5, use: 'flat mode: copy' },
  { bg: 'bg', fg: 'cream', need: 4.5, use: 'flat mode: eyebrow' },
  { bg: 'bg', fg: 'dim', need: 4.5, use: 'flat mode: footer credit' },
] as const

const report: string[] = []

describe('scroll-narrative contrast (WCAG AA, 95th-percentile backdrop)', async () => {
  await buildStates()

  it('covers every state: 5 desktop + 3 mobile photos and every neighbouring cross-fade, in AVIF and WebP', () => {
    // per ext: desktop 5 photos + 4 fades, mobile 3 photos + 2 fades
    expect(states).toHaveLength(2 * (5 + 4 + 3 + 2))
    expect(NARRATIVE_SECTIONS).toHaveLength(5)
    expect(VEIL_A).toBeCloseTo(45 / 255, 3)
  })

  it.each(ON_PHOTO)('$kind text: $token ($use) ≥ $need on the veiled photo in every state that shows it', ({ token, need, sections }) => {
    const fg = tok(token)
    let worst = Infinity
    let where = ''
    for (const s of states.filter((st) => st.sections.some((id) => sections.includes(id)))) {
      const r = ratioOnLuminance(fg, s.p95)
      if (r < worst) [worst, where] = [r, s.name]
    }
    report.push(`on photo  ${token.padEnd(5)} need ${need}  worst ${worst.toFixed(2)}  @ ${where}`)
    expect(worst, where).toBeGreaterThanOrEqual(need)
  })

  it('the credit (dim, 9 px) on its plate (#0B0D0F @ 92 %) over the brightest veiled pixel of any state ≥ 4.5', () => {
    const brightest = Math.max(...states.map((s) => s.max))
    // plate over a pixel of that luminance: composite in linear-free sRGB terms via a grey of equal luminance is not exact,
    // so bound it with pure white (stricter than any real pixel) and with the brightest decoded luminance
    const plateOnWhite = composite(BG, PHOTO_TOKENS.plateAlpha, [255, 255, 255])
    const rWhite = contrastRatio(tok('dim'), plateOnWhite)
    const grey = Math.round(255 * Math.cbrt(brightest))
    const rBrightest = contrastRatio(tok('dim'), composite(BG, PHOTO_TOKENS.plateAlpha, [grey, grey, grey]))
    report.push(`credit    dim   need 4.5  plate/white ${rWhite.toFixed(2)}  plate/brightest-pixel ${rBrightest.toFixed(2)} (L=${brightest.toFixed(4)})`)
    expect(rWhite).toBeGreaterThanOrEqual(4.5)
    expect(rBrightest).toBeGreaterThanOrEqual(4.5)
  })

  it.each(PANELS)('$fg on $bg ($use) ≥ $need', ({ bg, fg, need }) => {
    const r = contrastRatio(tok(fg), tok(bg))
    report.push(`panel     ${fg.padEnd(5)} on ${bg.padEnd(8)} need ${need}  ${r.toFixed(2)}  (${PANELS.find((p) => p.bg === bg && p.fg === fg)!.use})`)
    expect(r).toBeGreaterThanOrEqual(need)
  })

  it('records the measured pairs (copied into the feedback evidence)', () => {
    const header = `states ${states.length}; veil rgba(${VEIL}, ${VEIL_A}); brightest veiled photo pixel L=${Math.max(...states.map((s) => s.max)).toFixed(4)}; ` +
      `P95 backdrop L: min ${Math.min(...states.map((s) => s.p95)).toFixed(4)}, max ${Math.max(...states.map((s) => s.p95)).toFixed(4)}`
    const out = [header, ...report].join('\n')
    if (process.env.TS_CONTRAST_OUT) writeFileSync(process.env.TS_CONTRAST_OUT, out + '\n')
    console.info(out)
    expect(report.length).toBeGreaterThan(0)
  })
})
