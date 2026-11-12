// @vitest-environment node
/**
 * [feat/retire-force-mev, owner decision 2026-11-06] Grep-proof: no user-facing string in src/ attributes MEV protection to
 * TeraSwap. "MEV" may still appear as a neutral description of CoW Protocol's mechanism (or of MEV itself, e.g. Docs "What is
 * MEV?"), never as a TeraSwap promise.
 *
 * Scans what a user can read — string literals, template text and JSX text (also joined per JSX element, so
 * `provides <strong>MEV protection</strong> out of the box` is seen whole) — via the TypeScript AST, so code comments (history
 * notes such as "Was the Force MEV Protection toggle") are not claims. Test files and test helpers are not product surfaces.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MEV_PROTECTION_CLAIM } from './product-claims'

const SRC = join(process.cwd(), 'src')
const NOT_A_SURFACE = /(\.test\.|__tests__|[\\/]test-(fixtures|stubs|utils)|\.d\.ts$)/

/** Phrases that promise protection. Case-insensitive; whitespace is collapsed before matching. */
const FORBIDDEN: { id: string; re: RegExp }[] = [
  { id: 'MEV protection / MEV-protected', re: /\bMEV[ -]protect/i },
  { id: 'protected from / against MEV (front-running, sandwich)', re: /\bprotect(?:ed|ion|s)?\s+(?:\w+\s+){0,3}(?:from|against)\s+(?:MEV|front-?running|sandwich)/i },
  { id: 'shielded from …', re: /\bshield(?:ed|s)?\s+(?:\w+\s+){0,2}from\b/i },
  { id: 'MEV-safe', re: /\bMEV[ -]safe\b/i },
  { id: 'no front-running / sandwich (as a promise)', re: /\bno\s+(?:front-?running|sandwich)/i },
  { id: 'removes / eliminates the front-running / sandwich window', re: /\b(?:remove|eliminat)\w*\s+(?:[\w-]+\s+){0,6}(?:front-?running|sandwich)/i },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !NOT_A_SURFACE.test(p)) out.push(p)
  }
  return out
}

/** Every user-readable text in a source file: literals, template chunks, JSX text, and each JSX element's joined text. */
function readableTexts(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const texts: string[] = []
  const jsxText = (n: ts.Node): string => {
    const parts: string[] = []
    const visit = (c: ts.Node) => {
      if (ts.isJsxText(c)) parts.push(c.text)
      else if (ts.isJsxExpression(c) && c.expression && ts.isStringLiteral(c.expression)) parts.push(c.expression.text)
      else ts.forEachChild(c, visit)
    }
    ts.forEachChild(n, visit)
    return parts.join(' ')
  }
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texts.push(n.text)
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) texts.push(n.text)
    else if (ts.isJsxText(n)) texts.push(n.text)
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) texts.push(jsxText(n))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function findClaims(fileName: string, source: string): string[] {
  const hits = new Set<string>()
  for (const text of readableTexts(fileName, source)) {
    for (const f of FORBIDDEN) if (f.re.test(text)) hits.add(`${f.id} :: "${text.slice(0, 160)}"`)
  }
  return [...hits]
}

describe('retired claim: TeraSwap makes no MEV-related promise (owner 2026-11-06)', () => {
  it('the product-claims slot is retired, dated and explained', () => {
    expect(MEV_PROTECTION_CLAIM.live).toBe(false)
    expect(MEV_PROTECTION_CLAIM.retiredOn).toBe('2026-11-06')
    expect(MEV_PROTECTION_CLAIM.reason).toMatch(/429/)
  })

  it('the scanner is not vacuous: every retired v1/v2 sentence is caught; neutral mechanism copy is not', () => {
    const retired = `
      const a = 'No MEV-protected quote available.'
      const b = <span>CoW Protocol available for MEV protection.</span>
      const c = <p>execution via CoW Protocol provides <strong>MEV protection</strong> out of the box.</p>
      const d = <span>. Solvers compete in batch auctions for the best fill. Your trade is fully protected from MEV (frontrunning, sandwich attacks).</span>
      const e = <p>✓ Settled, solvers compete in a batch auction; you&apos;re shielded from frontrunning/sandwich attacks.</p>
      const f = <span title="MEV Protected, no frontrunning or sandwich attacks">MEV</span>
      const g = <p>swaps that route through CoW execute via batch auctions that remove the in-block ordering window front-running and sandwich attacks depend on.</p>
      const h = \`offers \${x} MEV-protected routes\`
    `
    const hits = findClaims('fixture.tsx', retired)
    for (const needle of ['No MEV-protected quote', 'available for MEV protection', 'provides MEV protection', 'fully protected from MEV', 'shielded from', 'no frontrunning', 'remove the in-block', 'MEV-protected routes']) {
      expect(hits.some((h) => h.includes(needle)), needle).toBe(true)
    }
    const neutral = `
      const a = <p>Professional solvers compete in a <strong>batch auction</strong> to fill the order. How that auction treats MEV is part of CoW Protocol&apos;s own design, not a TeraSwap guarantee.</p>
      const b = <p>TeraSwap does not claim to prevent MEV.</p>
      const c = 'Each leg is independently visible to MEV searchers.'
      // a comment that says Force MEV Protection is not a surface
      const d = mevProtected
    `
    expect(findClaims('fixture.tsx', neutral)).toEqual([])
  })

  it('no user-facing string in src/ attributes MEV protection to TeraSwap', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(200) // the walk really covers src/
    const offenders = files.flatMap((f) => findClaims(f, readFileSync(f, 'utf8')).map((h) => `${relative(process.cwd(), f)}: ${h}`))
    expect(offenders).toEqual([])
  })
})
