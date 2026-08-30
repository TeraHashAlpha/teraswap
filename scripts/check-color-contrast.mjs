#!/usr/bin/env node
/**
 * Status-palette CVD regression check.
 *
 * Parses `success` / `warning` / `danger` hex out of tailwind.config.ts (never hard-coded)
 * and fails any pair whose CIEDE2000 is below 15 under normal vision, deuteranopia, or
 * protanopia. Colour-vision simulation is the Viénot / Brettel / Mollon 1999 linear-RGB
 * LMS substitution. CIEDE2000 follows Sharma et al. 2005.
 *
 * This is a colour-separation backstop, not an accessibility guarantee. Colour is always
 * paired with an icon and a label and never carries meaning alone.
 *
 * Known currently-under-15 pairs are listed in DEFAULT_BASELINE so CI stays green today.
 * A NEW under-15 pair (not in that list) fails the check. A listed pair that now CLEARS
 * 15 also fails (the baseline cannot rot). Never widen the baseline to silence a new miss.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STATUS_TOKENS = ['success', 'warning', 'danger']
export const CONDITIONS = ['normal', 'deuteranopia', 'protanopia']
export const DE2000_FLOOR = 15

/**
 * Pairs the shipped checker currently measures below dE2000 15 on the live palette.
 *
 * Keys: `${condition}:${tokenA}/${tokenB}` with tokens in STATUS_TOKENS order.
 *
 * A prior notebook listed three misses (deuteranopia success/warning, deuteranopia
 * warning/danger, protanopia success/warning). The shipped implementation also
 * measures deuteranopia success/danger just under the floor (~14.98). All currently
 * under-15 pairs are baselined so CI is green today; anti-rot applies to every entry.
 *
 * Never widen this list to silence a new failure. Drop an entry only after the owner
 * applies a replacement palette and that pair actually clears 15.
 */
export const DEFAULT_BASELINE = Object.freeze([
  'deuteranopia:success/warning',
  'deuteranopia:success/danger',
  'deuteranopia:warning/danger',
  'protanopia:success/warning',
])

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG_PATH = path.join(ROOT, 'tailwind.config.ts')

// Hunt-Pointer-Estevez (D65) as used by Viénot, Brettel & Mollon 1999 for the
// linear-RGB → LMS step of the dichromat approximation.
const RGB_TO_LMS = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
]
const LMS_TO_RGB = invert3x3(RGB_TO_LMS)

// sRGB D65 (IEC 61966-2-1) linear-RGB → XYZ, and D65 white for XYZ → Lab.
const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
]
const D65_WHITE = [0.95047, 1, 1.08883]

function invert3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = f * g - d * i
  const C = d * h - e * g
  const D = c * h - b * i
  const E = a * i - c * g
  const F = b * g - a * h
  const G = b * f - c * e
  const H = c * d - a * f
  const I = a * e - b * d
  const det = a * A + b * B + c * C
  if (det === 0) throw new Error('RGB_TO_LMS is singular')
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ]
}

function mul3x3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

function deg2rad(d) {
  return (d * Math.PI) / 180
}

function rad2deg(r) {
  return (r * 180) / Math.PI
}

function stripJsLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      let out = ''
      let inSingle = false
      let inDouble = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        const next = line[i + 1]
        if (ch === "'" && !inDouble) inSingle = !inSingle
        else if (ch === '"' && !inSingle) inDouble = !inDouble
        else if (ch === '/' && next === '/' && !inSingle && !inDouble) break
        out += ch
      }
      return out
    })
    .join('\n')
}

/**
 * Extract the three status hex colours from a tailwind.config.ts source string.
 * Fails loudly if a key is missing, duplicated, or not a 6-digit hex.
 */
export function parseStatusColors(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('cannot read status colours: empty tailwind config source')
  }
  const stripped = stripJsLineComments(source)
  const colors = {}
  for (const token of STATUS_TOKENS) {
    const re = new RegExp(`(?:^|\\n)\\s+${token}:\\s*['"](#([0-9A-Fa-f]{6}))['"]`, 'g')
    const matches = [...stripped.matchAll(re)]
    if (matches.length === 0) {
      throw new Error(
        `cannot read status colour "${token}" from tailwind.config.ts (expected \`${token}: '#RRGGBB'\`)`,
      )
    }
    if (matches.length > 1) {
      throw new Error(`ambiguous status colour "${token}": matched ${matches.length} times`)
    }
    colors[token] = `#${matches[0][2].toUpperCase()}`
  }
  return colors
}

export function hexToLinearRgb(hex) {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex)
  if (!m) throw new Error(`invalid hex colour: ${JSON.stringify(hex)}`)
  const n = parseInt(m[1], 16)
  const srgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
}

export function linearRgbToLab(lin) {
  const xyz = mul3x3(SRGB_TO_XYZ, lin)
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const fx = f(xyz[0] / D65_WHITE[0])
  const fy = f(xyz[1] / D65_WHITE[1])
  const fz = f(xyz[2] / D65_WHITE[2])
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function hexToLab(hex) {
  return linearRgbToLab(hexToLinearRgb(hex))
}

/**
 * CIEDE2000 (ΔE00), Sharma et al. 2005 implementation notes.
 * kL = kC = kH = 1 (CIE default).
 */
export function ciede2000(lab1, lab2) {
  const [L1, a1, b1] = lab1
  const [L2, a2, b2] = lab2
  const kL = 1
  const kC = 1
  const kH = 1

  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))

  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)

  const hue = (ap, b) => {
    if (ap === 0 && b === 0) return 0
    const h = rad2deg(Math.atan2(b, ap))
    return h < 0 ? h + 360 : h
  }
  const h1p = hue(a1p, b1)
  const h2p = hue(a2p, b2)

  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    const dh = h2p - h1p
    if (dh > 180) dhp = dh - 360
    else if (dh < -180) dhp = dh + 360
    else dhp = dh
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg2rad(dhp / 2))

  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2
  let hbarp
  if (C1p * C2p === 0) hbarp = h1p + h2p
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2
  else hbarp = (h1p + h2p - 360) / 2

  const T =
    1 -
    0.17 * Math.cos(deg2rad(hbarp - 30)) +
    0.24 * Math.cos(deg2rad(2 * hbarp)) +
    0.32 * Math.cos(deg2rad(3 * hbarp + 6)) -
    0.2 * Math.cos(deg2rad(4 * hbarp - 63))

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const RC = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7))
  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2)
  const SC = 1 + 0.045 * Cbarp
  const SH = 1 + 0.015 * Cbarp * T
  const RT = -Math.sin(deg2rad(2 * dTheta)) * RC

  const termL = dLp / (kL * SL)
  const termC = dCp / (kC * SC)
  const termH = dHp / (kH * SH)
  return Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + RT * termC * termH)
}

/**
 * Viénot / Brettel / Mollon 1999 linear-RGB dichromat approximation.
 * Substitutes L (protanopia) or M (deuteranopia) in LMS, then converts back.
 * Neutral greys (equal-energy linear RGB) are preserved to numerical noise.
 */
export function simulateCvd(lin, type) {
  if (type === 'normal') return [lin[0], lin[1], lin[2]]
  const lms = mul3x3(RGB_TO_LMS, lin)
  let [L, M, S] = lms
  if (type === 'protanopia') {
    L = 2.02344 * M - 2.52581 * S
  } else if (type === 'deuteranopia') {
    M = 0.494207 * L + 1.24827 * S
  } else {
    throw new Error(`unknown CVD type: ${type}`)
  }
  const out = mul3x3(LMS_TO_RGB, [L, M, S])
  return out.map((x) => (x < 0 ? 0 : x))
}

export function pairDeltaE2000(hexA, hexB, condition) {
  const linA = simulateCvd(hexToLinearRgb(hexA), condition)
  const linB = simulateCvd(hexToLinearRgb(hexB), condition)
  return ciede2000(linearRgbToLab(linA), linearRgbToLab(linB))
}

export function pairKey(condition, a, b) {
  return `${condition}:${a}/${b}`
}

export function evaluatePalette(colors, baseline = DEFAULT_BASELINE) {
  const baselineSet = new Set(baseline)
  const rows = []
  for (const condition of CONDITIONS) {
    for (let i = 0; i < STATUS_TOKENS.length; i++) {
      for (let j = i + 1; j < STATUS_TOKENS.length; j++) {
        const a = STATUS_TOKENS[i]
        const b = STATUS_TOKENS[j]
        const hexA = colors[a]
        const hexB = colors[b]
        const delta = pairDeltaE2000(hexA, hexB, condition)
        const key = pairKey(condition, a, b)
        const under = delta < DE2000_FLOOR
        const listed = baselineSet.has(key)
        let status
        if (under && listed) status = 'baselined'
        else if (under && !listed) status = 'FAIL'
        else if (!under && listed) status = 'BASELINE-ROT'
        else status = 'pass'
        rows.push({ condition, a, b, hexA, hexB, delta, key, status })
      }
    }
  }
  const unknownBaseline = [...baselineSet].filter((k) => !rows.some((r) => r.key === k))
  const failures = rows.filter((r) => r.status === 'FAIL' || r.status === 'BASELINE-ROT')
  return {
    rows,
    failures,
    unknownBaseline,
    ok: failures.length === 0 && unknownBaseline.length === 0,
  }
}

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

export function formatReport(result, colors, configLabel = 'tailwind.config.ts') {
  const lines = []
  lines.push(`status-palette CVD check  (CIEDE2000 floor=${DE2000_FLOOR})`)
  lines.push(
    `parsed from ${configLabel}: ` +
      STATUS_TOKENS.map((t) => `${t}=${colors[t]} (hex_len=${colors[t].length})`).join('  '),
  )
  lines.push('')
  lines.push(`${pad('condition', 16)}${pad('pair', 20)}${pad('dE2000', 10)}status`)
  for (const row of result.rows) {
    const pair = `${row.a}/${row.b}`
    const de = row.delta.toFixed(4)
    lines.push(`${pad(row.condition, 16)}${pad(pair, 20)}${pad(de, 10)}${row.status}`)
  }
  const counts = { pass: 0, baselined: 0, FAIL: 0, 'BASELINE-ROT': 0 }
  for (const row of result.rows) counts[row.status] += 1
  lines.push('')
  lines.push(
    `counts: pass=${counts.pass}  baselined=${counts.baselined}  FAIL=${counts.FAIL}  BASELINE-ROT=${counts['BASELINE-ROT']}`,
  )
  if (result.ok) {
    lines.push('✓ no unbaselined failures; no rotting baseline entries')
  }
  return lines.join('\n') + '\n'
}

export function formatFailures(result) {
  const lines = []
  for (const row of result.failures) {
    if (row.status === 'FAIL') {
      lines.push(
        `FAIL ${row.key}  dE2000=${row.delta.toFixed(4)} < ${DE2000_FLOOR}  (${row.hexA} vs ${row.hexB})`,
      )
    } else if (row.status === 'BASELINE-ROT') {
      lines.push(
        `BASELINE-ROT ${row.key}  dE2000=${row.delta.toFixed(4)} >= ${DE2000_FLOOR}  ` +
          'this pair now clears the floor; remove it from DEFAULT_BASELINE (never widen the list)',
      )
    }
  }
  for (const key of result.unknownBaseline) {
    lines.push(
      `BASELINE-ROT unknown key ${key}  not a status pair; remove it from DEFAULT_BASELINE`,
    )
  }
  if (result.failures.length > 0 || result.unknownBaseline.length > 0) {
    lines.push(
      'Colour separation is a backstop, not accessibility. Do not widen DEFAULT_BASELINE to silence a new miss.',
    )
  }
  return lines.join('\n') + '\n'
}

export function runCheck({
  source = null,
  configPath = null,
  baseline = DEFAULT_BASELINE,
  root = ROOT,
} = {}) {
  const resolvedPath = configPath ?? path.join(root, 'tailwind.config.ts')
  const configLabel = configPath ?? 'tailwind.config.ts'
  let text = source
  if (text == null) {
    if (!existsSync(resolvedPath)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: `cannot read status colours: ${resolvedPath} not found\n`,
      }
    }
    text = readFileSync(resolvedPath, 'utf8')
  }
  let colors
  try {
    colors = parseStatusColors(text)
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `${err.message}\n` }
  }
  const result = evaluatePalette(colors, baseline)
  const stdout = formatReport(result, colors, configLabel)
  if (!result.ok) {
    return { exitCode: 1, stdout, stderr: formatFailures(result) }
  }
  return { exitCode: 0, stdout, stderr: '' }
}

export function parseArgs(argv) {
  let configPath = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') {
      const value = argv[++i]
      if (!value) throw new Error('--config requires a path')
      configPath = value
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { configPath }
}

export function main(argv = process.argv.slice(2), io = process) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.stderr.write(`${err.message}\n`)
    return 2
  }
  const result = runCheck({ configPath: args.configPath })
  if (result.stdout) io.stdout.write(result.stdout)
  if (result.stderr) io.stderr.write(result.stderr)
  return result.exitCode
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.exit(main())
}
