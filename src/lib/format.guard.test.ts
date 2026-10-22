/**
 * Guard for the numeric-formatter migration (design README §3): display code in
 * src/components, src/app and src/hooks must format numbers through src/lib/format.ts —
 * never `toFixed(`, `toLocaleString(` or `Intl.NumberFormat` (locale-dependent / ad hoc).
 *
 * Allowed:
 *  - src/lib/format.ts (outside the scanned dirs by construction);
 *  - src/app/api/** — server routes: JSON payload rounding, logs and alert text, none rendered
 *    by the UI through these calls;
 *  - a line carrying `numeric-format-allow: <reason>` on the same or the previous line, for the
 *    explicitly justified cases (stored values, input-field state parsed back into signed orders,
 *    SVG geometry). The reason is mandatory.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SCAN_DIRS = ['src/components', 'src/app', 'src/hooks']
const ALLOWED_PREFIXES = ['src/app/api/']
const FORBIDDEN = /Intl\.NumberFormat|\.toFixed\(|\.toLocaleString\(/
const MARKER = /numeric-format-allow:\s*\S+/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

describe('numeric-format guard', () => {
  it('no toFixed( / toLocaleString( / Intl.NumberFormat in display code', () => {
    const violations: string[] = []
    let scanned = 0
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(ROOT, d))) {
        const rel = relative(ROOT, file).split('\\').join('/')
        if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue
        scanned++
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (!FORBIDDEN.test(line)) return
          if (MARKER.test(line) || (i > 0 && MARKER.test(lines[i - 1]))) return
          violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
        })
      }
    }
    expect(scanned).toBeGreaterThan(50) // the walk really covered the tree
    expect(violations).toEqual([])
  })

  it('every allow marker carries a reason', () => {
    const bad: string[] = []
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(ROOT, d))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (line.includes('numeric-format-allow') && !MARKER.test(line)) bad.push(`${relative(ROOT, file)}:${i + 1}`)
        })
      }
    }
    expect(bad).toEqual([])
  })
})
