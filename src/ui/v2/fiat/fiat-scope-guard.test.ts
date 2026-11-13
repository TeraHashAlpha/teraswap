/**
 * [feat/ui-v2-fiat-value C3] GUARD: a fiat value is DISPLAY ONLY. The modules that fetch or hold an approximate price, the euro rate or the
 * visitor's currency choice may be imported ONLY by the display surfaces listed below; and no gate, review, consent or signing path may
 * reach them, directly or through anything it imports (by value; `import type` is erased and carries no code).
 *
 * "Price-bearing" = everything under src/ui/v2/fiat/ except `fiat-format.ts` (a pure formatter that takes a number someone else computed and
 * returns text), plus `src/lib/eur-usd-feed.ts` and `src/app/api/fiat/**`. Reasoning in the style of usd-scope-guard.test.ts: a stale
 * estimate next to an amount is a wrong label; the same estimate inside a gate, a minimum output, a tier, a consent, calldata or a signature
 * is a wrong commitment.
 *
 * DETECTOR SCOPE: a syntactic match over import/export-from/dynamic-import specifiers (no AST, no type information). It does not see a
 * specifier assembled at runtime; that residual gap is accepted, as in usd-scope-guard.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const posix = (p: string) => p.split(sep).join('/')
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(posix(relative(SRC, full)))
  }
  return out
}
const FILES = walk(SRC)
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /\/__tests__\//.test(f) || /test-(fixtures|stubs)\.tsx?$/.test(f) || /-harness\.tsx?$/.test(f) || /-fake\.tsx?$/.test(f)

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/** Value import specifiers of a source text (`import type …` excluded; `export … from`, `import 'x'` and `import('x')` included; comments ignored). */
export function importSpecifiers(source: string): string[] {
  const text = stripComments(source)
  const out: string[] = []
  // The binding list never contains a quote or a semicolon, so a bare `import 'x'` cannot swallow a later `from`.
  const re = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[4]) out.push(m[4])
    else if (!m[2] && (m[1] === 'import' || /\bfrom\b/.test(m[0]))) out.push(m[3])
  }
  return out
}

/** A specifier resolved to a file under src/ (posix, relative to src/), or null for a package / unresolved path. */
function resolveSpec(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(join(SRC, from)), spec)
  else return null
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return posix(relative(SRC, cand))
  }
  return null
}

/** Price-bearing fiat modules (everything the guard protects). */
const isFiatModule = (f: string) =>
  (f.startsWith('ui/v2/fiat/') && !isTest(f) && f !== 'ui/v2/fiat/fiat-format.ts') || f === 'lib/eur-usd-feed.ts' || f.startsWith('app/api/fiat/')

/** The ONLY non-test modules allowed to import a price-bearing fiat module. */
const ALLOWED_IMPORTERS = new Set([
  // The display surfaces: the Swap card's Sell / Receive lines and its gas / fee context, and the account menu's switch.
  'ui/v2/swap/SwapCard.tsx',
  'ui/v2/shell/AccountPanel.tsx',
  // The fiat package itself.
  'ui/v2/fiat/use-fiat-value.ts',
  'ui/v2/fiat/CurrencySwitch.tsx',
  'ui/v2/fiat/eur-rate.ts',
  // The server route that reads the feed (imports the pure lib module and the validator; nothing imports the route).
  'app/api/fiat/eur-usd/route.ts',
])

/** Roots of the gate / review / consent / signing paths. Everything they import (by value) is checked too. */
function signingRoots(): string[] {
  const starts = [
    'ui/v2/modals/', // review, consent, Permit2, split and CoW review sheets, review-model
    'ui/v2/swap/lifecycle/', // gates, approval, execution, the split plan
    'ui/v2/dca/', // DCA review and signing
    'ui/v2/orders/', // order cancel / signing
    'lib/order-engine/', // order signing, floors, the keeper-facing maths
  ]
  const exact = [
    'ui/v2/swap/cta.ts',
    'hooks/useSwap.ts',
    'hooks/useApproval.ts',
    'hooks/useSwapPriceTier.ts',
    'hooks/useDepegCheck.ts',
    'lib/minimum-output.ts',
    'lib/swap-price-tier.ts',
    'lib/depeg-gate.ts',
    'lib/chainlink.ts',
    'lib/permit2.ts',
  ]
  return FILES.filter((f) => !isTest(f) && (starts.some((s) => f.startsWith(s)) || exact.includes(f)))
}

describe('[feat/ui-v2-fiat-value] a fiat value is display-only', () => {
  it('the scan reaches the tree and the detector sees real imports (guard is not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(500)
    expect(FILES.filter(isFiatModule).length).toBeGreaterThanOrEqual(6)
    const swapCard = readFileSync(join(SRC, 'ui/v2/swap/SwapCard.tsx'), 'utf8')
    const resolved = importSpecifiers(swapCard).map((s) => resolveSpec('ui/v2/swap/SwapCard.tsx', s))
    expect(resolved).toContain('ui/v2/fiat/use-fiat-value.ts')
    expect(resolved).toContain('ui/v2/fiat/approx-prices.ts')
    expect(signingRoots().length).toBeGreaterThan(40)
  })

  it('the detector: value imports count, type-only imports and mentions do not', () => {
    const t = `import type { X } from '@/ui/v2/fiat/approx-prices'\nimport { a } from "@/ui/v2/fiat/use-fiat-value"\nexport { b } from './eur-rate'\nconst m = await import('./approx-prices')\nimport './side'\n// import { z } from '@/ui/v2/fiat/eur-rate'\nconst s = "from '@/lib/eur-usd-feed'"`
    expect(importSpecifiers(t).sort()).toEqual(['./approx-prices', './eur-rate', './side', '@/ui/v2/fiat/use-fiat-value'].sort())
  })

  it('NO module outside the display allow-list imports a price-bearing fiat module', () => {
    const offenders = FILES.filter((f) => !isTest(f) && !isFiatModule(f) && !ALLOWED_IMPORTERS.has(f)).filter((f) =>
      importSpecifiers(readFileSync(join(SRC, f), 'utf8')).some((s) => {
        const r = resolveSpec(f, s)
        return r !== null && isFiatModule(r)
      }),
    )
    expect(offenders, `These import a fiat module but are not display surfaces. Fiat values must never feed a gate, minimum, tier, consent, calldata or signature:\n${offenders.join('\n')}`).toEqual([])
  })

  it('NO gate, review, consent or signing path reaches a fiat module, directly or through what it imports', () => {
    const seen = new Set<string>()
    const via = new Map<string, string>()
    const queue = signingRoots()
    for (const r of queue) via.set(r, r)
    const hits: string[] = []
    while (queue.length) {
      const f = queue.shift() as string
      if (seen.has(f)) continue
      seen.add(f)
      if (isFiatModule(f)) {
        hits.push(`${via.get(f)} -> ${f}`)
        continue
      }
      for (const s of importSpecifiers(readFileSync(join(SRC, f), 'utf8'))) {
        const r = resolveSpec(f, s)
        if (r && !isTest(r) && !seen.has(r)) {
          if (!via.has(r)) via.set(r, via.get(f) as string)
          queue.push(r)
        }
      }
    }
    expect(seen.size, 'the closure walk reached nothing: the guard would be vacuous').toBeGreaterThan(100)
    expect(hits, `A signing / review / gate path reaches a fiat module:\n${hits.join('\n')}`).toEqual([])
  })

  it('every allow-listed importer still exists (a stale entry silently widens the hole)', () => {
    for (const f of ALLOWED_IMPORTERS) expect(FILES, f).toContain(f)
  })

  it('the hook returns text only: no number leaves useFiatValue for anything to compute with', () => {
    const src = readFileSync(join(SRC, 'ui/v2/fiat/use-fiat-value.ts'), 'utf8')
    expect(src).toMatch(/useFiatValue\([^)]*\): \{ text: string \| null \}/)
  })

  it('the review model is built from the dollar view: SwapCard never hands the panel view to buildReviewModel', () => {
    const src = readFileSync(join(SRC, 'ui/v2/swap/SwapCard.tsx'), 'utf8')
    expect(src).toMatch(/buildReviewModel\(\{ view,/)
    expect(src).not.toMatch(/buildReviewModel\(\{ panelView/)
  })
})
