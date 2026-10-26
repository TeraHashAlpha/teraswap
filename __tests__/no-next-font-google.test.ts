/**
 * [CHORE-NEXT-FONT-LOCAL] next/font/google fetches font files at build time; CI builds
 * failed when the runner could not reach Google. Fonts are self-hosted (src/fonts/README.md)
 * via next/font/local. This guard fails if anything under src/ imports next/font/google.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', 'src')
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (SOURCE_EXT.test(name)) out.push(p)
  }
  return out
}

describe('no next/font/google under src/', () => {
  it('no source file imports next/font/google', () => {
    const offenders = walk(SRC).filter(f => /next\/font\/google/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(f => f.slice(SRC.length + 1))).toEqual([])
  })

  it('no runtime font CDN (fontshare) in layout, globals.css, tailwind or CSP', () => {
    const root = join(__dirname, '..')
    // [feat/ui-v2-foundation] v2 token CSS + font loader are covered by the same no-CDN rule.
    const files = ['src/app/layout.tsx', 'src/app/globals.css', 'tailwind.config.ts', 'next.config.js', 'src/ui/v2/tokens.css', 'src/ui/v2/font-loader.ts']
    const offenders = files.filter(f => /fontshare/i.test(readFileSync(join(root, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('v2 tree never pulls a font from a runtime CDN (@import url / Google Fonts / Fontshare)', () => {
    const v2 = join(SRC, 'ui', 'v2')
    const sources = [...walk(v2), join(v2, 'tokens.css')]
    const offenders = sources.filter(f =>
      /@import\s+url\(|fonts\.(googleapis|gstatic)\.com|fontshare/i.test(readFileSync(f, 'utf8')))
    expect(offenders.map(f => f.slice(SRC.length + 1))).toEqual([])
  })
})
