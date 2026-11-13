/**
 * GUARD: the words a link preview, an install prompt or a search result shows say what the site is today.
 *   - No "MEV" anywhere in layout.tsx's strings or in public/manifest.json: the owner retired every MEV promise on 2026-11-06
 *     (see the MEV_PROTECTION_CLAIM note in product-claims.ts), and a card that still says it contradicts the product.
 *   - The manifest description is the page description (SITE_META_DESCRIPTION), so its source count and chain list come from
 *     the same derivation as the page, never from a number typed into JSON.
 *   - None of the retired phrasings of the old card.
 * The em-dash rule for both files is in no-em-dash.guard.test.tsx (net 1 for layout.tsx, net 4 for the manifest). This file lives
 * in src/app, so it must not name that test's v2 path (the v1-isolation test greps src/app for it).
 * layout.tsx is read as text: importing it pulls in next/font, which only exists inside the Next build.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { SITE_META_DESCRIPTION } from '@/config/product-claims'

const ROOT = path.resolve(__dirname, '..', '..')
const layoutSrc = readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8')
const manifestRaw = readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8')
const manifest = JSON.parse(manifestRaw) as { description: string; screenshots: { src: string; label: string }[] }

/** Every string literal and template part in layout.tsx (comments are not copy). */
function layoutStrings(): string[] {
  const sf = ts.createSourceFile('layout.tsx', layoutSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const MEV = /\bmev\b/i
const RETIRED = [/privacy proxy/i, /Ethereum meta-aggregator/i, /\b11 liquidity sources\b/i, /\b7 sources\b/i]

describe('link-preview and manifest copy', () => {
  const strings = layoutStrings()

  it('reads layout.tsx strings (guard against an empty scan)', () => {
    expect(strings.length).toBeGreaterThan(10)
    expect(strings).toContain('TeraSwap: The Gold Standard of DeFi Trading')
  })

  it('no "MEV" in layout.tsx strings or in public/manifest.json', () => {
    expect(strings.filter((s) => MEV.test(s))).toEqual([])
    expect(MEV.test(manifestRaw)).toBe(false)
  })

  it('none of the old card\'s phrasings in either file', () => {
    for (const re of RETIRED) {
      expect(strings.filter((s) => re.test(s)), String(re)).toEqual([])
      expect(re.test(manifestRaw), String(re)).toBe(false)
    }
  })

  it('manifest description is SITE_META_DESCRIPTION, so its count and chains cannot drift', () => {
    expect(manifest.description).toBe(SITE_META_DESCRIPTION)
  })

  it('manifest screenshot is the link-preview image, labelled with the four words', () => {
    expect(manifest.screenshots).toHaveLength(1)
    expect(manifest.screenshots[0].src).toBe('/og-teraswap-v2.png')
    expect(manifest.screenshots[0].label).toBe('TeraSwap: Compare. Verify. Swap. Repeat.')
  })
})
