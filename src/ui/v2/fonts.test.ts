/**
 * @vitest-environment node
 *
 * [ADR-025] v2 fonts: files + OFL licences present and byte-identical to the README provenance table,
 * loaded only via next/font/local (no CDN), Inter reused from #565, not duplicated.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, 'fonts')
const LOADER = readFileSync(join(__dirname, 'font-loader.ts'), 'utf8')
const README = readFileSync(join(DIR, 'README.md'), 'utf8')

const FONT_FILES = ['BarlowCondensed-Bold.ttf', 'IBMPlexMono-Regular.ttf', 'IBMPlexMono-Medium.ttf', 'IBMPlexMono-Bold.ttf']
const LICENCES = ['OFL-barlowcondensed.txt', 'OFL-ibmplexmono.txt']

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

  it.each(LICENCES)('%s is SIL OFL 1.1', (name) => {
    expect(readFileSync(join(DIR, name), 'utf8')).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/)
  })
})

describe('v2 font loader', () => {
  it('uses next/font/local with in-repo files only; no google/CDN', () => {
    expect(LOADER).toMatch(/from 'next\/font\/local'/)
    expect(LOADER).not.toMatch(/next\/font\/google|https?:\/\//)
    for (const f of FONT_FILES) expect(LOADER).toContain(`./fonts/${f}`)
  })

  it('does not load Inter again (reuses the #565 self-hosted --font-inter)', () => {
    expect(LOADER).not.toMatch(/InterVariable|Inter-Variable|variable: '--font-inter'/)
  })
})
