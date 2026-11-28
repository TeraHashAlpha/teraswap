// @vitest-environment jsdom
/**
 * [fix/remove-post-execution-claim, owner 2026-11-28] No visible surface of v1 or v2 claims a post-execution check
 * while nothing calls the validator (src/lib/post-execution-validator.ts stays in the repo, uncalled).
 *
 * Two reads, because each misses what the other sees:
 *   - every string and JSX text in the UI trees (comments are not read), so copy behind a wallet state or a modal counts;
 *   - the rendered text of both landings and both Docs pages, so a phrase split across elements counts.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// v1 reads matchMedia / IntersectionObserver at module load; both must exist before it is imported.
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion: reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
})

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBlockNumber: () => ({ data: 23_541_870n }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn() }) }))
// v1 loads its below-fold half through next/dynamic; here the two halves are rendered explicitly.
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1 }))
vi.mock('@/hooks/useQuote', () => ({
  useQuote: () => ({ meta: { best: { toAmount: '1266342000' } }, loading: false, error: null }),
}))
vi.mock('@/lib/sounds', async () => ({ ...(await vi.importActual<typeof import('@/lib/sounds')>('@/lib/sounds')), playTouchMP3: vi.fn() }))

import LandingPage from '@/components/LandingPage'
import LandingBelowFold from '@/components/LandingBelowFold'
import DocsPage from '@/components/DocsPage'
import { LandingV2 } from '@/ui/v2/landing'
import { DocsTabV2 } from '@/ui/v2/docs-legal/DocsTabV2'

const ROOT = process.cwd()
const noop = () => {}

/** The wording of the retired claim: its name, its stage, its number's noun and its two effects. */
const CLAIM_RE =
  /post[\s_-]*(?:execution|swap|trade)|shortfall|auto(?:matically)?[\s-]*disabl|\bP0 alert|transfer (?:event )?logs?|actual (?:output|amount) (?:vs|versus|against)/i

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'lib', 'cache', 'broadcast'])
const isTestFile = (rel: string) => /\.test\.|__tests__|(^|\/)test-utils\//.test(rel)

function walk(rel: string, wanted: RegExp, skipDirs: ReadonlySet<string> = new Set(['node_modules', '.next'])): string[] {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const child = `${rel}/${e.name}`
    if (e.isDirectory()) return skipDirs.has(e.name) ? [] : walk(child, wanted, skipDirs)
    return wanted.test(e.name) && !isTestFile(child) ? [child] : []
  })
}

/** Every string, template part and JSX text of a TS/JS source. Comments never appear here. */
function codeStrings(source: string, fileName: string): string[] {
  const kind = /\.[tj]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) found.push(node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

const claimsIn = (strings: readonly string[]) => strings.filter((s) => CLAIM_RE.test(s)).map((s) => s.replace(/\s+/g, ' ').trim())

// ── Is there a caller? ───────────────────────────────────────────────────────

const VALIDATOR = 'src/lib/post-execution-validator.ts'
const REFERENCE_RE = /post-execution-validator|monitor\/validate-execution|validate-execution\/route/
const ROUTE_REFERENCE_RE = /monitor\/validate-execution|validate-execution\/route/

/** The module specifiers a source loads: import / export-from, `import()` and `require()`. */
function moduleSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName)
}

/**
 * True when `source` loads the validator, or names the route in code. A comment is not a caller, and neither is a
 * plain string with the validator's file path (a list of files is not a call).
 */
function callsValidator(source: string, fileName: string): boolean {
  if (!REFERENCE_RE.test(source)) return false
  if (/\.(?:[cm]?[tj]sx?)$/.test(fileName)) {
    return (
      moduleSpecifiers(source).some((s) => /(?:^|\/)post-execution-validator(?:\.[cm]?[tj]s)?$/.test(s)) ||
      codeStrings(source, fileName).some((s) => ROUTE_REFERENCE_RE.test(s))
    )
  }
  // YAML / TOML / shell / JSON: whole-line `#` comments are not calls.
  return source.split('\n').some((line) => !/^\s*#/.test(line) && REFERENCE_RE.test(line))
}

function validatorCallers(): string[] {
  const CALLER_FILES = /\.(?:[cm]?[tj]sx?|ya?ml|toml|json|sh)$/
  return [
    ...walk('src', CALLER_FILES),
    ...walk('scripts', CALLER_FILES),
    ...walk('workers', CALLER_FILES),
    ...walk('contracts/order-engine/executor', CALLER_FILES, SKIP_DIRS),
    ...walk('.github', CALLER_FILES),
    'vercel.json',
    'package.json',
  ].filter((rel) => rel !== VALIDATOR && existsSync(join(ROOT, rel)) && callsValidator(readFileSync(join(ROOT, rel), 'utf8'), rel))
}

const CALLERS = validatorCallers()

// ── Visible surfaces ─────────────────────────────────────────────────────────

const UI_SOURCES = [
  ...walk('src/components', /\.tsx?$/),
  ...walk('src/ui', /\.tsx?$/),
  // src/app/api answers machines, not visitors; the validator's own route lives there.
  ...walk('src/app', /\.tsx?$/).filter((f) => !f.startsWith('src/app/api/')),
  // Copy the UI imports: the claims module and the constants that carry visible reasons.
  'src/config/product-claims.ts',
  'src/lib/constants.ts',
]
const PUBLIC_TEXT = walk('public', /\.(?:json|txt|html|webmanifest|md)$/)

afterEach(cleanup)

describe('guard: no post-execution claim while nothing calls the validator', () => {
  it('today nothing calls it. If this fails: prove the caller RUNS (its secret set) before any copy returns', () => {
    expect(existsSync(join(ROOT, VALIDATOR))).toBe(true)
    expect(CALLERS).toEqual([])
  })

  it.runIf(CALLERS.length === 0)('no string or JSX text in the v1 / v2 UI sources claims it', () => {
    expect(UI_SOURCES.length).toBeGreaterThan(150)
    for (const must of ['src/components/LandingBelowFold.tsx', 'src/ui/v2/landing/Sections.tsx', 'src/components/DocsPage.tsx', 'src/ui/v2/docs-legal/DocsTabV2.tsx']) {
      expect(UI_SOURCES).toContain(must)
    }
    const hits = UI_SOURCES.flatMap((rel) => {
      const source = readFileSync(join(ROOT, rel), 'utf8')
      return CLAIM_RE.test(source) ? claimsIn(codeStrings(source, rel)).map((s) => `${relative(ROOT, join(ROOT, rel))}: ${s}`) : []
    })
    expect(hits).toEqual([])
  })

  it.runIf(CALLERS.length === 0)('no static file under public/ claims it', () => {
    expect(PUBLIC_TEXT).toContain('public/manifest.json')
    expect(PUBLIC_TEXT.filter((rel) => CLAIM_RE.test(readFileSync(join(ROOT, rel), 'utf8')))).toEqual([])
  })

  it.runIf(CALLERS.length === 0).each([
    ['v1 landing', () => render(<><LandingPage onLaunchApp={noop} /><LandingBelowFold onLaunchApp={noop} /></>), 'Institutional-Grade'],
    ['v2 landing', () => render(<LandingV2 onLaunchApp={noop} />), 'Institutional-Grade'],
    ['v1 Docs', () => render(<DocsPage />), 'Chainlink Oracle Validation'],
    ['v2 Docs', () => render(<DocsTabV2 />), 'Chainlink Oracle Validation'],
  ])('the rendered %s does not claim it', (_name, mount, anchor) => {
    const text = mount().container.textContent ?? ''
    expect(text).toContain(anchor) // the page really rendered
    expect(text.match(new RegExp(CLAIM_RE.source, 'gi')) ?? []).toEqual([])
  })
})

describe('the guard itself (so a green run means something)', () => {
  it('flags each sentence the site used to show', () => {
    for (const old of [
      'Post-execution verified',
      'POST-SWAP',
      'Post-Execution Validation',
      'Transfer event logs verify actual output vs expected.',
      'Shortfall above 2% triggers a P0 alert and the source is auto-disabled.',
      'post-execution-shortfall',
      'the source is automatically disabled',
    ]) {
      expect(claimsIn([old]), old).toHaveLength(1)
    }
  })

  it('leaves the pre-trade copy alone', () => {
    expect(
      claimsIn([
        'Deviations above 3% are blocked automatically, before your trade happens, not after.',
        'Pre-swap simulation passed: transaction verified safe',
        'security layers that protect users at every stage of a trade',
      ]),
    ).toEqual([])
  })

  it('reads strings and JSX text, never comments', () => {
    const source = "// post-execution validator\nexport const A = () => <p>Post-swap {`shortfall ${1}`}</p> /* auto-disabled */\n"
    expect(claimsIn(codeStrings(source, 'a.tsx'))).toEqual(['Post-swap', 'shortfall'])
  })

  it('counts an import or an HTTP call as a caller, and a comment as none', () => {
    expect(callsValidator("import { validateExecution } from '@/lib/post-execution-validator'", 'a.ts')).toBe(true)
    expect(callsValidator("await import('../post-execution-validator')", 'a.mjs')).toBe(true)
    expect(callsValidator("await fetch(`${base}/api/monitor/validate-execution`, { method: 'POST' })", 'a.ts')).toBe(true)
    expect(callsValidator('      run: curl -X POST "$URL/api/monitor/validate-execution"', 'a.yml')).toBe(true)
    expect(callsValidator('// see post-execution-validator and monitor/validate-execution\nexport {}', 'a.ts')).toBe(false)
    expect(callsValidator('# see /api/monitor/validate-execution', 'a.yml')).toBe(false)
    expect(callsValidator("export const PROOF = 'src/lib/post-execution-validator.ts'", 'a.ts')).toBe(false)
    expect(callsValidator("export { validateExecution } from './post-execution-validator'", 'a.ts')).toBe(true)
    expect(callsValidator("const m = require('./post-execution-validator.ts')", 'a.cjs')).toBe(true)
  })
})
