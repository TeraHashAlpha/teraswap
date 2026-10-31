/**
 * @vitest-environment node
 *
 * [ADR-025] v2 fonts: files + OFL licences present and byte-identical to the README provenance table,
 * loaded only via next/font/local (no CDN, the #565 rule), and — Round 7 D1 — the body face is IBM Plex Sans:
 * Inter does not appear anywhere in the v2 source tree.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, 'fonts')
const LOADER = readFileSync(join(__dirname, 'font-loader.ts'), 'utf8')
const README = readFileSync(join(DIR, 'README.md'), 'utf8')

const FONT_FILES = ['BarlowCondensed-Bold.ttf', 'IBMPlexMono-Regular.ttf', 'IBMPlexMono-Medium.ttf', 'IBMPlexMono-Bold.ttf']
// Round 7 D1: the pack ships Plex Sans as one variable woff2 (Latin + Cyrillic, wght 400–700), not as a TTF.
const VARIABLE_MASTER = 'IBMPlexSans-wght400-700.woff2'
const SUBSETS = [...FONT_FILES.map((f) => f.replace('.ttf', '.latin.woff2')), VARIABLE_MASTER.replace('.woff2', '.latin.woff2')]
const MAX_FACE_BYTES = 60 * 1000
const LICENCES = ['OFL-barlowcondensed.txt', 'OFL-ibmplexmono.txt', 'OFL-ibmplexsans.txt']

/** Every non-test source file in the v2 tree (ts/tsx/css) — the font guard's search space. */
function v2Sources(dir = __dirname): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return v2Sources(full)
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe('v2 font files + licences', () => {
  it.each([...FONT_FILES, ...LICENCES])('%s exists and is non-empty', (name) => {
    expect(existsSync(join(DIR, name)), name).toBe(true)
    expect(readFileSync(join(DIR, name)).length).toBeGreaterThan(1000)
  })

  it.each(FONT_FILES)('%s is a TrueType font whose SHA-256 matches the README table', (name) => {
    const buf = readFileSync(join(DIR, name))
    expect(buf.subarray(0, 4).toString('hex')).toBe('00010000')
    const sha = createHash('sha256').update(buf).digest('hex')
    expect(README).toContain(`\`${name}\``)
    expect(README).toContain(sha)
  })

  it('Plex Sans master is the pack woff2, byte-identical to the README table, with the wght 400–700 axis', () => {
    const buf = readFileSync(join(DIR, VARIABLE_MASTER))
    expect(buf.subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(README).toContain(`\`${VARIABLE_MASTER}\``)
    expect(README).toContain(createHash('sha256').update(buf).digest('hex'))
    expect(README).toContain(`${buf.length.toLocaleString('en-US').replace(/,/g, ' ')} B`)
  })

  it.each(LICENCES)('%s is SIL OFL 1.1', (name) => {
    expect(readFileSync(join(DIR, name), 'utf8')).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/)
  })
})

describe('v2 Latin woff2 subsets (the files actually loaded)', () => {
  it.each(SUBSETS)('%s is a woff2, ≤ 60 KB, and its SHA-256 + size are in the README table', (name) => {
    const buf = readFileSync(join(DIR, 'latin', name))
    expect(buf.subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(buf.length).toBeLessThanOrEqual(MAX_FACE_BYTES)
    const sha = createHash('sha256').update(buf).digest('hex')
    expect(README).toContain(`\`${name}\``)
    expect(README).toContain(sha)
    expect(README).toContain(`${buf.length.toLocaleString('en-US').replace(/,/g, ' ')} B`)
  })

  it('the README names the tool and records before/after sizes for every face', () => {
    expect(README).toMatch(/pyftsubset/)
    expect(README).toMatch(/fontTools 4\.62\.1/)
    for (const f of [...FONT_FILES, VARIABLE_MASTER]) {
      const before = readFileSync(join(DIR, f)).length.toLocaleString('en-US').replace(/,/g, ' ')
      expect(README).toContain(`${before} B`)
    }
  })

  it('the Plex Sans subset dropped Cyrillic but kept the Latin range, → and the wght axis', () => {
    const buf = readFileSync(join(DIR, 'latin', VARIABLE_MASTER.replace('.woff2', '.latin.woff2')))
    expect(buf.length).toBeLessThan(readFileSync(join(DIR, VARIABLE_MASTER)).length)
    expect(README).toMatch(/U\+2190-2199/)
    expect(README).toMatch(/wght 400[–-]700/)
  })
})

describe('v2 font loader', () => {
  it('uses next/font/local with in-repo files only; no google/CDN', () => {
    expect(LOADER).toMatch(/from 'next\/font\/local'/)
    expect(LOADER).not.toMatch(/next\/font\/google|https?:\/\//)
  })

  it('loads the Latin subsets, not the unsubset TTF masters', () => {
    for (const f of SUBSETS) expect(LOADER).toContain(`./fonts/latin/${f}`)
    expect(LOADER).not.toMatch(/\.ttf/)
  })

  it('loads Plex Sans as one variable face (wght 400–700) on --font-plex-sans, and puts it on the v2 root', () => {
    expect(LOADER).toContain('./fonts/latin/IBMPlexSans-wght400-700.latin.woff2')
    expect(LOADER).toMatch(/weight: '400 700'/)
    expect(LOADER).toMatch(/variable: '--font-plex-sans'/)
    expect(LOADER).toMatch(/v2FontClassNames = `[^`]*\$\{ibmPlexSans\.variable\}/)
  })
})

describe('Round 7 D1 guard — Inter is out of v2, and nothing in v2 reaches a CDN (#565)', () => {
  const SOURCES = v2Sources()

  it('finds the v2 tree (guard is not vacuous)', () => {
    expect(SOURCES.length).toBeGreaterThan(20)
    expect(SOURCES.some((f) => f.endsWith('font-loader.ts'))).toBe(true)
  })

  it('no v2 source names Inter or the root layout\'s --font-inter variable', () => {
    const hits = SOURCES.filter((f) => /--font-inter|\bInter\b|InterVariable/.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  it('no v2 source uses the Google font loader, an @import of a remote sheet, or a remote @font-face', () => {
    // written with joins so this file does not itself contain the literals the repo-wide guard
    // (__tests__/no-next-font-google.test.ts) searches for. Plain substrings for the loader and the two font hosts (no
    // host regex: nothing to anchor), regexes only for the two structural patterns.
    const needles = ['next/font/goo' + 'gle', 'fonts.goo' + 'gleapis.com', 'fonts.gs' + 'tatic.com']
    const patterns = [new RegExp('@import\\s+ur' + 'l\\('), new RegExp('@font-face[^}]*ur' + 'l\\(\\s*[\'"]?https?:')]
    const hits = SOURCES.filter((f) => {
      const text = readFileSync(f, 'utf8')
      return needles.some((n) => text.includes(n)) || patterns.some((r) => r.test(text))
    })
    expect(hits).toEqual([])
  })

  it('--font-body resolves to Plex Sans, then the §4 family, then system-ui', () => {
    const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8')
    expect(css).toMatch(/--font-body:var\(--font-plex-sans\),"IBM Plex Sans",system-ui,sans-serif;/)
  })
})
