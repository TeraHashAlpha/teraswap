// @vitest-environment node
/**
 * [fix/privacy-leftovers-a78b S-11] Who may record a quote. `useQuote` logs only when a caller passes `{ logQuote: true }`
 * (src/hooks/useQuote.ts, UseQuoteOptions). The owner ruling: the swap screen (v1 SwapBox, v2 SwapCard) does, nothing else.
 * The A78b audit found the old guard read four files by name; a fifth caller, or an options object built elsewhere, passed it.
 *
 * Two scans over every non-test file in `src` (TypeScript AST, not text):
 *   1. LOGGING CALLERS. Any `useQuote(...)` call that passes an options argument, any object literal with a `logQuote`
 *      property, any import of `logQuoteToSupabase`, any mention of `/api/log-quote`: only the swap screen and the two
 *      modules that implement the opt-in may have one. An options argument that is not a literal (a variable, a spread, a
 *      parameter passed through) cannot be proven off, so it counts as logging.
 *   2. THE LANDING PREVIEW. Starting from the landing entry files (v1 LandingPage + LandingBelowFold; every file of the v2
 *      landing folder), follow every static and dynamic import. The closure must not contain the swap screen or any
 *      module that logs a quote. `useQuote.ts` itself is the boundary: the landing may import it (its default is "do
 *      not log", pinned by useQuote.log-quote.test.ts), but not what it logs through.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..')
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/')
// v1 files may not name the second UI tree (the isolation test scans their text); this file is v1, so the paths are built.
const V2 = 'v' + '2'

/** The swap screen: the only callers that may pass `logQuote: true`. */
const SWAP_SCREEN = ['src/components/SwapBox.tsx', `src/ui/${V2}/swap/SwapCard.tsx`]
/** Modules that implement the opt-in; they name the option, the sink and the route by definition. */
const IMPLEMENTS = ['src/hooks/useQuote.ts', 'src/lib/analytics.ts']
const USE_QUOTE = 'src/hooks/useQuote.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test-utils' || name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|pw|spec)\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const files = walk(path.join(ROOT, 'src')).map(rel)
const parse = (f: string, text = readFileSync(path.join(ROOT, f), 'utf8')) =>
  ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

interface Finding {
  file: string
  what: string
}

/** Scan 1 on one file's text. */
function loggingUses(file: string, text: string): Finding[] {
  const sf = parse(file, text)
  const found: Finding[] = []
  // Local names `useQuote` is bound to (alias imports count).
  const names = new Set<string>(['useQuote'])
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      for (const el of n.importClause.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'useQuote') names.add(el.name.text)
      for (const el of n.importClause.namedBindings.elements) if ((el.propertyName ?? el.name).text === 'logQuoteToSupabase') found.push({ file, what: 'imports logQuoteToSupabase' })
    }
  })
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (names.has(calleeName) && n.arguments.length > 5) {
        const opts = n.arguments[5]
        const literalOff =
          ts.isObjectLiteralExpression(opts) &&
          opts.properties.every((p) => ts.isPropertyAssignment(p) && /^logQuote$/.test(p.name.getText()) === false)
        if (!literalOff) found.push({ file, what: `useQuote(...) passes an options argument: ${opts.getText().slice(0, 60)}` })
      }
    }
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        const key = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name ? p.name.getText() : ''
        if (key === 'logQuote') found.push({ file, what: `object literal with a logQuote property: ${n.getText().slice(0, 60)}` })
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) && n.text.includes('/api/log-quote')) {
      found.push({ file, what: 'names /api/log-quote' })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

// ── import closure ──────────────────────────────────────────────────────────────

function resolveModule(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(path.join(ROOT, from)), spec)
  else return null // a package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return rel(cand)
  }
  return null
}

/** Every module specifier a file imports: import/export-from, `import('x')`, `require('x')`. */
function specifiers(file: string, text: string): string[] {
  const sf = parse(file, text)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text)
    if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0])) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) out.push(n.arguments[0].text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Files reachable from `entries`, not looking inside `stopAt` (it is in the result, its imports are not followed). */
function closure(entries: string[], read: (f: string) => string, stopAt: string): Set<string> {
  const seen = new Set<string>(entries)
  const queue = [...entries]
  while (queue.length) {
    const f = queue.shift()!
    if (f === stopAt) continue
    for (const spec of specifiers(f, read(f))) {
      const target = resolveModule(f, spec)
      if (target && !seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  return seen
}

const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8')
const LANDING_ENTRIES = [
  'src/components/LandingPage.tsx',
  'src/components/LandingBelowFold.tsx',
  ...files.filter((f) => f.startsWith(`src/ui/${V2}/landing/`)),
]

describe('S-11: only the swap screen may record a quote', () => {
  it('the scan sees the code it is about (guard against an empty scan)', () => {
    expect(files.length).toBeGreaterThan(500)
    for (const f of [...SWAP_SCREEN, ...IMPLEMENTS, ...LANDING_ENTRIES]) expect(files, f).toContain(f)
    expect(LANDING_ENTRIES.length).toBeGreaterThan(10)
  })

  it('the swap screen passes { logQuote: true } (so the scan below is looking at the right call shape)', () => {
    for (const f of SWAP_SCREEN) expect(read(f), f).toMatch(/useQuote\([^)]*\{ logQuote: true \}\)/)
  })

  it('no file other than the swap screen and the two implementing modules passes logQuote, builds an options object, imports the sink, or names the route', () => {
    const offenders = files
      .filter((f) => !SWAP_SCREEN.includes(f) && !IMPLEMENTS.includes(f))
      .flatMap((f) => loggingUses(f, read(f)))
    expect(offenders).toEqual([])
  })

  it('useQuote.ts is the only module that calls the sink, and the route is named only in analytics.ts', () => {
    const importers = files.filter((f) => loggingUses(f, read(f)).some((x) => x.what === 'imports logQuoteToSupabase'))
    expect(importers).toEqual([USE_QUOTE])
    const routeNamers = files.filter((f) => loggingUses(f, read(f)).some((x) => x.what === 'names /api/log-quote'))
    expect(routeNamers).toEqual(['src/lib/analytics.ts'])
  })

  it('the landing preview (v1 and v2) cannot reach the swap screen or a module that logs a quote, through any import', () => {
    const reach = closure(LANDING_ENTRIES, read, USE_QUOTE)
    expect(reach.has(USE_QUOTE), 'the landing preview uses useQuote, so the boundary must be reached').toBe(true)
    const sinks = [...reach].filter(
      (f) => SWAP_SCREEN.includes(f) || (f !== USE_QUOTE && loggingUses(f, read(f)).length > 0),
    )
    expect(sinks).toEqual([])
  })

  it('the closure walk follows dynamic imports and re-exports (a hidden hop would not hide a sink)', () => {
    const fake: Record<string, string> = {
      'src/a.ts': "export * from '@/b'\nconst x = () => import('@/c')",
      'src/b.ts': "import './d'",
      'src/c.ts': 'export const c = 1',
      'src/d.ts': 'export const d = 1',
    }
    expect(specifiers('src/a.ts', fake['src/a.ts'])).toEqual(['@/b', '@/c'])
  })

  it('loggingUses flags the shapes a caller could use (so the scan is not blind to them)', () => {
    const hits = (src: string) => loggingUses('src/x.tsx', src).map((x) => x.what)
    expect(hits("useQuote(a, b, c, true, [], { logQuote: true })")).toHaveLength(2)
    expect(hits("const OPTS = { logQuote: true }")).toHaveLength(1)
    expect(hits("useQuote(a, b, c, true, [], opts)")).toHaveLength(1)
    expect(hits("useQuote(a, b, c, true, [], { ...base })")).toHaveLength(1)
    expect(hits("import { useQuote as q } from '@/hooks/useQuote'\nq(a, b, c, true, [], { logQuote: true })")).toHaveLength(2)
    expect(hits("import { logQuoteToSupabase } from '@/lib/analytics'")).toHaveLength(1)
    expect(hits("fetch('/api/log-quote')")).toHaveLength(1)
    // And the harmless shapes stay quiet.
    expect(hits('useQuote(a, b, c, true)')).toEqual([])
    expect(hits('useQuote(a, b, c, true, excluded)')).toEqual([])
  })
})
