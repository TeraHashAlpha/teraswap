/** WCAG 2.x contrast helpers over `#rrggbb` / [r,g,b] (0–255). Pure; used by the plate tests and the evidence script. */
export type RGB = readonly [number, number, number]

export function hexToRgb(hex: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`bad colour ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `top` drawn at `alpha` over `under`. */
export function composite(top: RGB, alpha: number, under: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(top[i] * alpha + under[i] * (1 - alpha))) as unknown as RGB
}
