/**
 * @vitest-environment node
 *
 * Design review 1 (owner, 5 Nov) — the rules that must not drift back:
 *  1. ONE platform green (`--c-accent-green` = the NOTICE strip's `--teal`, #6B9B94) for every vertical accent stroke;
 *  2. no ⚠ glyph in a notice / alert (inline status indicators are allow-listed by file and count);
 *  (3 — no dark bands on the landing — is pinned in landing/landing.test.tsx and narrative-contrast.test.ts.)
 * Source scans, so a new notice written in the old style fails here, not in a screenshot review.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { V2_COLORS } from '../tokens'

const ROOT = join(__dirname, '..')
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) {
      if (n === '__tests__' || n === 'fonts' || n === 'photos') continue
      walk(p, out)
    } else out.push(p)
  }
  return out
}
const FILES = walk(ROOT)
const isTest = (f: string) => /\.test\.tsx?$/.test(f)
const SRC = FILES.filter((f) => /\.tsx?$/.test(f) && !isTest(f))
const CSS = FILES.filter((f) => f.endsWith('.css'))
const rel = (f: string) => relative(ROOT, f)
const read = (f: string) => readFileSync(f, 'utf8')

describe('1 · platform green', () => {
  const tokens = read(join(ROOT, 'tokens.css'))
  it('--c-accent-green is the NOTICE strip colour: --teal, #6B9B94', () => {
    expect(/--c-accent-green:var\(--teal\);/.test(tokens)).toBe(true)
    expect(/--teal:#6B9B94;/.test(tokens)).toBe(true)
    expect(V2_COLORS.teal).toBe('#6B9B94')
    // the info NOTICE strip itself: its bar is the shared stroke class, its label text is --teal (same value)
    const banner = read(join(ROOT, 'shell', 'NoticeBanner.tsx'))
    expect(banner).toMatch(/accent="teal"/)
    expect(banner).toMatch(/text-v2-teal/)
  })

  it('no class string pairs a left border with a status colour: every vertical accent stroke is `ts-v2-accent-stroke`', () => {
    const offenders: string[] = []
    for (const f of SRC) {
      const lines = read(f).split('\n')
      lines.forEach((line, i) => {
        // a quoted / templated class string that has a left-border utility AND a v2 border colour
        for (const m of line.matchAll(/[`'"][^`'"]*\bborder-l(?:-[^\s`'"]+)?\b[^`'"]*[`'"]/g)) {
          if (/\bborder-v2-/.test(m[0])) offenders.push(`${rel(f)}:${i + 1}  ${m[0].trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('no CSS left-border stroke uses a status / cream colour: only the platform green (and the neutral hairline for structure)', () => {
    const bad: string[] = []
    for (const f of CSS) {
      for (const [i, line] of read(f).split('\n').entries()) {
        for (const m of line.matchAll(/border-left:\s*([\d.]+)px\s+solid\s+([^;}\s]+(?:\([^)]*\))?)/g)) {
          const colour = m[2]
          if (colour !== 'var(--c-accent-green)' && colour !== 'var(--hairline)') bad.push(`${rel(f)}:${i + 1}  ${m[0]}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('the shared classes exist, and Surface maps every accent to the one stroke', () => {
    const prim = read(join(ROOT, 'primitives', 'primitives.css'))
    expect(prim).toMatch(/\.ts-v2-accent-stroke \{ border-color: var\(--c-accent-green\); \}/)
    expect(prim).toMatch(/\.ts-v2-rule-accent \{ border-left: 2px solid var\(--c-accent-green\);/)
    expect(prim).toMatch(/\.ts-v2-rule-list \{ border-left: 1px solid var\(--c-accent-green\); \}/)
    const surface = read(join(ROOT, 'primitives', 'Surface.tsx'))
    expect(surface.match(/'ts-v2-accent-stroke'/g)).toHaveLength(5)
  })
})

describe('2 · no ⚠ in a notice or alert', () => {
  // Inline STATUS indicators (not notices) that keep their glyph: file → how many. A new ⚠ anywhere else fails.
  const STATUS_GLYPHS: Record<string, number> = {
    'swap/QuotePanel.tsx': 3, // the rate tooltip's two titles + the Rate row's marker
    'swap/SwapCard.tsx': 1, // token verified / unverified badge
    'modals/TokenSheet.tsx': 1, // token verified / unverified badge
    'modals/ReviewSheet.tsx': 1, // the "Validation" row's marker (a row value, aria-hidden)
    'modals/SplitReviewSheet.tsx': 1, // same row, per leg
    'portfolio/ApprovalsPanel.tsx': 1, // the Active Approvals heading icon
  }
  it('the only ⚠ glyphs left in v2 sources are the allow-listed inline status indicators', () => {
    const found: Record<string, number> = {}
    for (const f of SRC) {
      const n = (read(f).match(/⚠|&#9888;|\\u26A0/g) ?? []).length
      if (n) found[rel(f)] = n
    }
    expect(found).toEqual(STATUS_GLYPHS)
  })
})
