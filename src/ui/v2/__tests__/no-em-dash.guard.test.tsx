// @vitest-environment jsdom
/**
 * [fix/ui-v2-walkthrough-polish C3] GUARD: no em dash (U+2014) and no SPACED en dash (U+2013) in any text a visitor reads,
 * v1 and v2. Owner decision: rewrite with a comma, colon, period or parentheses; an unspaced numeric range ("5–10") stays.
 * Code comments are not copy and are not scanned. A placeholder for "no value" reads `n/a`.
 *
 * Four nets, because each one alone has a hole (the fourth, the web app manifest, is below net 2):
 *   1. SOURCE SCAN (TypeScript AST): every string literal, template part and JSX text node of the visitor-facing code. This is the
 *      one that reaches conditional UI (modals, error states, gate notices) no render can reach cheaply. Logs (`console.*`),
 *      server routes, monitors and alert channels are not visitor copy and are outside the scope list below.
 *   2. VALUES: every string exported by `product-claims.ts` and `help-content.ts`, at any depth.
 *   3. RENDER: the routes that mount with small mocks (v1 Docs, v2 Docs, v2 landing), text content plus the accessible attributes.
 *      Privacy and Terms (v1 and v2) are rendered by `src/ui/v2/docs-legal/privacy-copy.test.tsx`, which asserts the same two rules on
 *      them; the other routes (wallet-bound tabs, admin, status) are covered by net 1.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

const EM = '—'
const SPACED_EN = ' – '
const bad = (s: string) => s.includes(EM) || s.includes(SPACED_EN)

const ROOT = join(__dirname, '..', '..', '..', '..')

// ── scope of the source scan ────────────────────────────────────────────────────────────────────────────────────────────
/** Visitor-facing directories (everything under them is scanned, minus tests and API routes). */
const VISITOR_DIRS = ['src/components', 'src/ui/v2', 'src/hooks', 'src/app', 'src/config']
/** Visitor-facing modules outside those directories: messages that reach a toast, a notice, a receipt or a wallet prompt. */
const VISITOR_LIB = [
  'src/lib/api.ts',
  'src/lib/constants.ts', // DISABLED_SOURCES reasons are rendered on the Docs page (found by net 3)
  'src/lib/adapters/shared.ts',
  'src/lib/depeg-gate.ts',
  'src/lib/minimum-output.ts',
  'src/lib/simulation.ts',
  'src/lib/swap-simulation.ts',
  'src/lib/gasless-engine.ts',
  'src/lib/dca/settlement-receipt.ts',
  'src/lib/dca-quick-fill.ts',
  'src/lib/fetch-json.ts',
  'src/lib/format.ts',
  'src/lib/chains/sequencer-check.ts',
  'src/lib/order-engine/canonical-route.ts',
  'src/lib/order-engine/check-route.ts',
  'src/lib/order-engine/config.ts',
  'src/lib/order-engine/dca-custom.ts',
  'src/lib/order-engine/economic-floor.ts',
  'src/lib/order-engine/failed-reason.ts',
  'src/lib/order-engine/read-auth.ts',
  'src/lib/wagmiConfig.ts',
  'src/lib/help-content.ts',
]
const isTest = (p: string) => /\.test\.tsx?$|\.d\.ts$|[\\/]__tests__[\\/]/.test(p)

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name) && !isTest(p)) out.push(p)
  }
  return out
}
const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

function scopedFiles(): string[] {
  const files = new Set<string>()
  for (const d of VISITOR_DIRS) for (const f of walk(join(ROOT, d))) files.add(rel(f))
  for (const f of VISITOR_LIB) files.add(f)
  return [...files].filter((f) => !f.startsWith('src/app/api/')).sort()
}

const inConsole = (n: ts.Node): boolean => {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && /^console\.(log|warn|error|info|debug)$/.test(p.expression.getText())) return true
    if (ts.isBlock(p) || ts.isJsxElement(p)) break
  }
  return false
}

/** Every string-like node (literal, template part, JSX text) that holds a bad dash. Comments are not nodes. */
function badNodes(file: string): { line: number; text: string }[] {
  const abs = join(ROOT, file)
  const src = readFileSync(abs, 'utf8')
  if (!/[—–]|\\u201[34]/.test(src)) return []
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: { line: number; text: string }[] = []
  const visit = (n: ts.Node) => {
    let text: string | null = null
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) text = n.text
    if (text !== null && bad(text) && !inConsole(n)) {
      hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: text.replace(/\s+/g, ' ').trim().slice(0, 140) })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

describe('net 1: source scan of visitor-facing code', () => {
  const files = scopedFiles()

  it('covers the visitor-facing tree (guard against an empty scan)', () => {
    expect(files.length).toBeGreaterThan(150)
    for (const must of ['src/components/SwapBox.tsx', 'src/ui/v2/landing/Sections.tsx', 'src/components/DocsPage.tsx', 'src/ui/v2/docs-legal/DocsTabV2.tsx', 'src/lib/help-content.ts', 'src/config/product-claims.ts', 'src/app/layout.tsx']) {
      expect(files, must).toContain(must)
    }
    expect(files.some((f) => f.startsWith('src/app/api/'))).toBe(false)
  })

  it('no em dash and no spaced en dash in a string literal, template part or JSX text (Privacy and Terms included)', () => {
    const offenders: string[] = []
    for (const f of files) {
      for (const h of badNodes(f)) offenders.push(`${f}:${h.line}  ${h.text}`)
    }
    expect(offenders).toEqual([])
  })
})

// ── net 2: values ───────────────────────────────────────────────────────────────────────────────────────────────────────
function strings(value: unknown, path: string, out: { path: string; text: string }[], depth = 0): void {
  if (typeof value === 'string') out.push({ path, text: value })
  else if (depth < 6 && Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out, depth + 1))
  else if (depth < 6 && value && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) strings(v, `${path}.${k}`, out, depth + 1)
}

describe('net 2: product-claims and help-content values', () => {
  it('product-claims: no bad dash in any exported string, at any depth (PRIVACY_* included)', async () => {
    const mod = (await import('@/config/product-claims')) as Record<string, unknown>
    const all: { path: string; text: string }[] = []
    for (const [k, v] of Object.entries(mod)) strings(v, k, all)
    expect(all.length).toBeGreaterThan(30)
    // the claims that take a chain id are values too: ask them for the three live chains
    for (const chainId of [1, 8453, 42161]) {
      for (const k of ['chainNameFor', 'dcaFeatureTitle'] as const) {
        const fn = mod[k] as ((id: number) => unknown) | undefined
        if (typeof fn === 'function') strings(fn(chainId), `${k}(${chainId})`, all)
      }
    }
    expect(all.filter((s) => bad(s.text)).map((s) => `${s.path}: ${s.text.slice(0, 120)}`)).toEqual([])
  })

  it('help-content: no bad dash in any exported string', async () => {
    const mod = (await import('@/lib/help-content')) as Record<string, unknown>
    const all: { path: string; text: string }[] = []
    for (const [k, v] of Object.entries(mod)) strings(v, k, all)
    expect(all.length).toBeGreaterThan(20)
    expect(all.filter((s) => bad(s.text)).map((s) => `${s.path}: ${s.text.slice(0, 120)}`)).toEqual([])
  })
})

// ── net 4: the web app manifest ─────────────────────────────────────────────────────────────────────────────────────────
// public/manifest.json is read by the install prompt and the app switcher, outside any component: nets 1-3 cannot see it.
// (layout.tsx, which holds the page metadata, is in net 1's scope; its "covers the visitor-facing tree" test pins that.)
describe('net 4: public/manifest.json', () => {
  it('no bad dash in any string of the manifest, at any depth', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.json'), 'utf8')) as unknown
    const all: { path: string; text: string }[] = []
    strings(manifest, 'manifest', all)
    expect(all.length).toBeGreaterThan(20)
    expect(all.filter((s) => bad(s.text)).map((s) => `${s.path}: ${s.text.slice(0, 120)}`)).toEqual([])
  })
})

// ── net 3: rendered routes ──────────────────────────────────────────────────────────────────────────────────────────────
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
const h = vi.hoisted(() => ({ chainId: 1 }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId }))
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBlockNumber: () => ({ data: 23_541_870n }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => ({ meta: { best: { toAmount: '1266342000' } }, loading: false, error: null }) }))

/** What a visitor reads from a mounted tree: text content plus the accessible attributes. */
function visibleText(root: HTMLElement): string[] {
  const out: string[] = [root.textContent ?? '']
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const a of ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-roledescription', 'value']) {
      const v = el.getAttribute(a)
      if (v) out.push(v)
    }
  }
  return out
}

/** A short window around every bad dash in `t`, so a failure says where it is. */
function around(t: string): string[] {
  return Array.from(t.matchAll(/—| – /g), (m) => t.slice(Math.max(0, (m.index ?? 0) - 50), (m.index ?? 0) + 50))
}

afterEach(cleanup)

describe('net 3: rendered routes', () => {
  it.each([1, 8453, 42161])('v1 /docs and v2 /v2/docs on chain %i', async (chainId) => {
    h.chainId = chainId
    const { default: DocsPage } = await import('@/components/DocsPage')
    const { DocsTabV2 } = await import('@/ui/v2/docs-legal/DocsTabV2')
    for (const [name, Page] of [['v1 /docs', DocsPage], ['v2 /v2/docs', DocsTabV2]] as const) {
      const { container, unmount } = render(<Page />)
      const text = visibleText(container)
      expect(text[0].length, `${name} rendered something`).toBeGreaterThan(2000)
      expect(text.flatMap(around), name).toEqual([])
      unmount()
    }
  })

  it('v2 landing (/v2, and "/" when UI_V2_ENABLED)', async () => {
    h.chainId = 1
    const { LandingV2 } = await import('@/ui/v2/landing')
    const { container } = render(<LandingV2 onLaunchApp={() => {}} />)
    const text = visibleText(container)
    expect(text.join(' ')).toContain('Verified')
    expect(text.flatMap(around)).toEqual([])
  })
})
