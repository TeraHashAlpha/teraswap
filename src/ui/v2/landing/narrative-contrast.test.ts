/**
 * @vitest-environment node
 *
 * [ADR-025] Contrast of every scroll-narrative state (round-6 MOTION-SPEC §8, same method as `frames_qa.py`): each text
 * token is compared with the 95th-percentile luminance of the background it sits on, WCAG AA — ≥ 4.5 body, ≥ 3 large.
 *  - text straight on the photo (headings, copy): the shipped, pre-graded photo files decoded with sharp, the constant
 *    veil (`--nar-veil`, read from narrative.css) over them. States: every photo × desktop (1920) / mobile (1080), the
 *    cross-fade between every neighbouring pair (both layer orders, progress 0.1 … 0.9 — the layers fade in opposite
 *    directions over the page `--bg`), and reduced motion (the same veiled photo painted on the section).
 *  - Round 7 (D2): there are no panels any more — ALL text sits straight on the photo, under the section's local scrim
 *    (tokens.css `--scrim-*`, the gradient the section actually uses at that width). Worst case = the scrim's WEAKEST stop
 *    over the 95th-percentile pixel, for text anywhere in the section (a left-column text sits under a stronger stop).
 *  - the credit plate: a fixed token pair (the plate over the brightest pixel of any state); popover / flat: token pairs.
 *  - flat modes (reduced transparency / more contrast / forced colours): tokens straight on `--bg`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { composite, contrastRatio, hexToRgb, luminance, type RGB } from '../photos/contrast'
import { PHOTO_TOKENS } from '../photos/photo-tokens'
import { V2_COLORS } from '../tokens'
import { NARRATIVE_SECTIONS, SECTION_PHOTO, STILL_PHOTO, photosFor, type NarrativeSectionId } from './narrative'
import type { NarrativePhotoId } from '../photos/narrative'

const CSS = readFileSync(join(__dirname, 'narrative.css'), 'utf8')
const TOKENS = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')
const [VEIL_R, VEIL_G, VEIL_B, VEIL_A] = /--nar-veil:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(CSS)!.slice(1).map(Number)
const VEIL: RGB = [VEIL_R, VEIL_G, VEIL_B]
const BG = hexToRgb(V2_COLORS.bg)
const tok = (name: keyof typeof V2_COLORS) => hexToRgb(V2_COLORS[name])

/** The weakest stop (lowest alpha) of a scrim token in tokens.css. */
function weakestStop(token: string): number {
  const m = new RegExp(`${token}:([^;]+);`).exec(TOKENS)
  if (!m) throw new Error(`${token} not in tokens.css`)
  return Math.min(...[...m[1].matchAll(/rgba\(11,13,15,([\d.]+)\)/g)].map((x) => Number(x[1])))
}
/** Which scrim a section paints at a viewport (landing.css: `.ts-v2-scrim`, `--features`; ≤ 600 px → the vertical pair). */
function scrimFor(section: NarrativeSectionId, vp: 'desktop' | 'mobile'): { token: string; alpha: number } {
  const token = vp === 'mobile' ? (section === 'features' ? '--scrim-down-features' : '--scrim-down') : section === 'features' ? '--scrim-left-features' : '--scrim-left'
  return { token, alpha: weakestStop(token) }
}

/** The scrim Performance (`--race`) and the bottom CTA (`--center`) paint — landing.css; ≤ 600 px both are the vertical `--scrim-down`. */
function stillScrim(section: keyof typeof STILL_PHOTO, vp: 'desktop' | 'mobile'): { token: string; alpha: number } {
  const token = vp === 'mobile' || section === 'cta' ? '--scrim-down' : '--scrim-left-race'
  return { token, alpha: weakestStop(token) }
}

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
/** Veil, then the section's scrim at `alpha`, over a backdrop: the sorted luminance list the text actually sits on. */
function scrimmedLuminances(px: Float32Array, alpha: number): number[] {
  const out: number[] = []
  for (let i = 0; i < px.length; i += 3) {
    const veiled = composite(VEIL, VEIL_A, [Math.round(px[i]), Math.round(px[i + 1]), Math.round(px[i + 2])])
    out.push(luminance(composite(BG, alpha, veiled)))
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
  vp: Viewport
  /** The (unveiled) backdrop pixels, kept so the scrim can be composited per section. */
  px: Float32Array
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
        states.push({ name: `${vp} ${ext} ${id} (also: reduced motion)`, sections: sectionsOf(id, vp), p95: p95(l), max: l[l.length - 1], vp, px: px[id] })
      }
      for (let i = 0; i < ids.length - 1; i++) {
        const [a, b] = [px[ids[i]], px[ids[i + 1]]]
        let worst: State = { name: '', sections: [], p95: 0, max: 0, vp, px: a }
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
            if (p95(l) > worst.p95) worst = { name: `${vp} ${ext} cross-fade ${ids[i]}→${ids[i + 1]} (worst of t=0.1…0.9, both layer orders)`, sections: both, p95: p95(l), max: l[l.length - 1], vp, px: mixed }
          }
        }
        states.push(worst)
        // t = 450 ms of the 900 ms fade: --ease-inout is symmetric, so BOTH layers sit at exactly 0.5 (checked below)
        for (const [order, mixed] of [
          ['B below A', over(a, 0.5, over(b, 0.5, flat(a.length / 3)))],
          ['A below B', over(b, 0.5, over(a, 0.5, flat(a.length / 3)))],
        ] as const) {
          const l = veiledLuminances(mixed)
          states.push({ name: `${vp} ${ext} mid-fade 50 % ${ids[i]}→${ids[i + 1]} (${order})`, sections: both, p95: p95(l), max: l[l.length - 1], vp, px: mixed })
        }
      }
    }
  }
}

/**
 * Text that sits straight on the photo + scrim. Round 7 unboxed everything, so EVERY narrative section carries the same set
 * (Sections.tsx): eyebrow (cream, 12 px mono) · h2 (text, 44–80 px; second line / h3 lead / stat numerals / list numerals in
 * cream, large) · copy, sublines, card + list descriptions and stat labels (muted, 14–17 px) · titles, emphasis, link labels
 * (text / cream, 12–20 px) · badges (cream; the SOON badge is MUTED, not dim — dim does not clear 4.5 on a scrim).
 */
const ALL: NarrativeSectionId[] = [...NARRATIVE_SECTIONS]
const ON_PHOTO: { token: keyof typeof V2_COLORS; kind: 'body' | 'large'; need: number; use: string; sections: NarrativeSectionId[] }[] = [
  { token: 'muted', kind: 'body', need: 4.5, use: 'copy / sublines / descriptions / labels 13–17 px', sections: ALL },
  { token: 'text', kind: 'body', need: 4.5, use: 'titles + emphasis + link 12–20 px', sections: ALL },
  { token: 'cream', kind: 'body', need: 4.5, use: 'eyebrow / badge / mono link 10–12 px', sections: ALL },
  { token: 'text', kind: 'large', need: 3, use: 'h2 headline 44–80 px', sections: ALL },
  { token: 'cream', kind: 'large', need: 3, use: 'h2 second line / h3 lead / numerals 24–56 px', sections: ALL },
]

const PANELS = [
  { bg: 'surface', fg: 'text', need: 4.5, use: 'popover / help drawer title' },
  { bg: 'surface', fg: 'muted', need: 4.5, use: 'popover subtitle' },
  { bg: 'surface', fg: 'cream', need: 4.5, use: 'popover action' },
  { bg: 'bg', fg: 'text', need: 4.5, use: 'flat mode: body' },
  { bg: 'bg', fg: 'muted', need: 4.5, use: 'flat mode: copy' },
  { bg: 'bg', fg: 'cream', need: 4.5, use: 'flat mode: eyebrow' },
  { bg: 'bg', fg: 'dim', need: 4.5, use: 'flat mode: footer credit' },
] as const

const report: string[] = []

describe('scroll-narrative contrast (WCAG AA, 95th-percentile backdrop)', async () => {
  await buildStates()

  it('covers every state: 5 desktop + 3 mobile photos, every neighbouring cross-fade (worst of 0.1…0.9) and its two 50 % mid-fade orders, in AVIF and WebP', () => {
    // per ext: desktop 5 photos + 4 fades + 4×2 mid-fades, mobile 3 photos + 2 fades + 2×2 mid-fades
    expect(states).toHaveLength(2 * (5 + 4 + 8 + 3 + 2 + 4))
    expect(states.filter((st) => st.name.includes('mid-fade 50 %'))).toHaveLength(2 * (8 + 4))
    expect(NARRATIVE_SECTIONS).toHaveLength(5)
    expect(VEIL_A).toBeCloseTo(45 / 255, 3)
  })

  it.each(ON_PHOTO)('$kind text: $token ($use) ≥ $need under the local scrim in every state that shows it', ({ token, need, sections }) => {
    const fg = tok(token)
    let worst = Infinity
    let where = ''
    for (const s of states) {
      for (const sec of s.sections.filter((id) => sections.includes(id))) {
        const { alpha, token: scrim } = scrimFor(sec, s.vp)
        const r = ratioOnLuminance(fg, p95(scrimmedLuminances(s.px, alpha)))
        if (r < worst) [worst, where] = [r, `${s.name} · ${sec} · ${scrim} α${alpha}`]
      }
    }
    report.push(`on photo+scrim  ${token.padEnd(5)} need ${need}  worst ${worst.toFixed(2)}  @ ${where}`)
    expect(worst, where).toBeGreaterThanOrEqual(need)
  })

  it('the scrim only ever helps: the scrimmed worst case is never below the veil-only worst case', () => {
    const fg = tok('muted')
    let veilOnly = Infinity
    let scrimmed = Infinity
    for (const s of states) {
      veilOnly = Math.min(veilOnly, ratioOnLuminance(fg, s.p95))
      for (const sec of s.sections) scrimmed = Math.min(scrimmed, ratioOnLuminance(fg, p95(scrimmedLuminances(s.px, scrimFor(sec, s.vp).alpha))))
    }
    report.push(`muted worst: veil only ${veilOnly.toFixed(2)} → with scrim ${scrimmed.toFixed(2)}`)
    expect(scrimmed).toBeGreaterThanOrEqual(veilOnly)
  })

  it('450 ms into the 900 ms fade both layers are at opacity 0.5: --ease-inout is symmetric', () => {
    const tokens = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')
    expect(/--t-photo:900ms/.test(tokens) && /--ease-inout:cubic-bezier\(0\.65,0,0\.35,1\)/.test(tokens)).toBe(true)
    // cubic-bezier(0.65, 0, 0.35, 1): solve x(u) = 0.5 by bisection, read y(u)
    const bez = (a: number, b: number, u: number) => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u ** 2 * b + u ** 3
    let [lo, hi] = [0, 1]
    for (let k = 0; k < 60; k++) (bez(0.65, 0.35, (lo + hi) / 2) < 0.5 ? (lo = (lo + hi) / 2) : (hi = (lo + hi) / 2))
    expect(bez(0, 1, (lo + hi) / 2)).toBeCloseTo(0.5, 6)
  })

  it.each(Object.entries(STILL_PHOTO))('still section "%s" (baked %s photo, static): h2 text ≥ 3 and cream second line ≥ 3 on the veiled photo, both sizes', (_section, photo) => {
    const own = states.filter((st) => st.name.includes(` ${photo} (also: reduced motion)`))
    expect(own.length).toBeGreaterThan(0)
    for (const token of ['text', 'cream'] as const) {
      const worst = Math.min(...own.map((st) => ratioOnLuminance(tok(token), st.p95)))
      report.push(`still ${_section.padEnd(11)} ${token.padEnd(5)} need 3  worst ${worst.toFixed(2)}  (large, on ${photo})`)
      expect(worst).toBeGreaterThanOrEqual(3)
    }
  })

  // Round 7 × the 26 Oct transition: Performance and the CTA are baked stills (veil only, no stack) AND carry a local scrim.
  // Every text kind a section shows is checked under the scrim the section really paints, on the still's own photo at both
  // viewports (the mobile file is decoded here directly: a still shows it even when the stack's mobile map does not).
  it.each(Object.entries(STILL_PHOTO))('still section "%s": every on-photo text kind clears its AA need under the section scrim, desktop + mobile, AVIF + WebP', async (section, photo) => {
    for (const row of ON_PHOTO) {
      let worst = Infinity
      let where = ''
      for (const vp of ['desktop', 'mobile'] as const) {
        const { token, alpha } = stillScrim(section as keyof typeof STILL_PHOTO, vp)
        for (const ext of ['avif', 'webp'] as const) {
          const r = ratioOnLuminance(tok(row.token), p95(scrimmedLuminances(await pixels(photo as NarrativePhotoId, vp, ext), alpha)))
          if (r < worst) [worst, where] = [r, `${vp} ${ext} ${photo} · ${token} α${alpha}`]
        }
      }
      report.push(`still+scrim ${section.padEnd(11)} ${row.token.padEnd(5)} need ${row.need}  worst ${worst.toFixed(2)}  @ ${where}`)
      expect(worst, `${section} ${row.token}: ${where}`).toBeGreaterThanOrEqual(row.need)
    }
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
