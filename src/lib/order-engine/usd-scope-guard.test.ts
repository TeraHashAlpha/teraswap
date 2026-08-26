/**
 * [FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE / INC-2026-08-07-001 follow-up 1] The APPROX_PRICES
 * boundary, enforced structurally rather than by comment.
 *
 * `APPROX_PRICES` is a table of hand-edited constants. It said `ETH: 3500` while the live Base
 * ETH/USD feed read 1911.90, and `CBETH: 3600` against a real ~2204. Wrong by ~83% on the single
 * most-traded asset in the catalogue, and wrong silently — nothing in the type system distinguished
 * it from a quote.
 *
 * The severity of that depends entirely on WHERE it is read:
 *   - a LABEL on a historical fill  → a wrong label. Acceptable, and its actual job.
 *   - a GATE input                  → the guard mis-sizes what it lets through. A HIGH reading
 *                                     over-values the order and waves through the dust chunks the
 *                                     SC-02 min-chunk guard exists to stop.
 *   - a SIGNED minimum              → an on-chain commitment the user cannot revise. Order
 *                                     ef85438b reverted 516 times.
 *
 * #408 closed the signing case in the type system (the `approxPrice*` parameters were REMOVED from
 * `DeriveSigningMinParams`, so reintroducing the table there fails `tsc`). The gate case has no
 * equivalent compiler expression — any module can import a `Record<string, number>` — so it is
 * addressed here instead: this suite enumerates every module that imports the table (or `fillUsd`,
 * which is the table wearing a function) and fails on any importer not on the display/analytics
 * allowlist below.
 *
 * Adding a module to the allowlist is therefore a deliberate, reviewable act, and the comment
 * required next to each entry has to say why a stale estimate is harmless there.
 *
 * ── DETECTOR SCOPE [FIX-USD-SCOPE-GUARD-AND-UNCHECKABLE-DUST-GUARD, L-1] ──────────────────────────
 * `importsApproxPrices()` is a SYNTACTIC pattern match over source text, not a semantic/type-aware
 * analysis (no AST, no cross-file resolution of what a name actually refers to). It DETECTS, for a
 * reference to `APPROX_PRICES` or `fillUsd`:
 *   - a brace-form import:            `import { APPROX_PRICES } from '...'`
 *   - a brace-form re-export:         `export { APPROX_PRICES } from '...'`
 *   - a namespace import of the usd module itself (member access irrelevant — that module's entire
 *     surface IS the table): `import * as usd from '.../usd'`
 *   - a namespace import of the barrel, gated on an actual member touch: `import * as oe from
 *     '@/lib/order-engine'` followed by `oe.APPROX_PRICES` / `oe.fillUsd`
 *   - a full re-export of the usd module: `export * from '.../usd'`
 *   - a CommonJS destructure: `const { fillUsd } = require('.../usd')`
 *   - a dynamic import bound to a variable, gated on a member touch on that variable:
 *     `const m = await import('.../usd')` followed by `m.APPROX_PRICES`
 * It does NOT detect, and must not: a bare mention of the name in a comment or string, or a brace
 * import of an unrelated name from an unrelated module (`fillUsdSomethingElse`, the barrel imported
 * for other names entirely). A module that dodges every pattern above while still reaching the table
 * at runtime (e.g. `globalThis['APPROX' + '_PRICES']`) would pass this guard undetected — that residual
 * gap is accepted, not claimed closed; this suite narrows the hole a brace-only match left, it does
 * not eliminate the class.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', '..')

/**
 * Modules permitted to read the approximate price table. Every entry is DISPLAY or ANALYTICS: the
 * worst outcome of a stale value is a wrong number next to a completed fill, which the UI already
 * renders with an explicit "~$" marker.
 */
const ALLOWED = new Set([
  // The table itself, and its own unit test.
  'lib/order-engine/usd.ts',
  'lib/order-engine/usd.test.ts',
  // The barrel re-export. Re-exporting is not reading; the importers of the barrel are what this
  // suite actually checks, and they are listed individually here.
  'lib/order-engine/index.ts',
  // DISPLAY: per-fill USD in the DCA fills timeline, rendered as "~$…" / "<$0.01" and "—" when the
  // token is unpriced. Labels a fill that already happened; gates nothing.
  'components/dca/DCAFillsTimeline.tsx',
  // DISPLAY: the timeline's own test.
  'components/dca/__tests__/DCAFillsTimeline.test.tsx',
  // This suite. It carries SYNTHETIC import strings as fixtures for the detector's own self-test
  // (below) — they are string literals, not imports, and excluding the guard from its own scan is
  // the only honest way to keep those fixtures.
  'lib/order-engine/usd-scope-guard.test.ts',
])

/** Every .ts/.tsx under src/, as a POSIX-style path relative to src/. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full, out); continue }
    if (/\.tsx?$/.test(entry)) out.push(relative(SRC, full).split(sep).join('/'))
  }
  return out
}

/** The names this guard cares about. */
const TABLE_NAMES = ['APPROX_PRICES', 'fillUsd']

/** True for a module specifier that IS the usd.ts module itself — its entire export surface is the
 *  table, so a namespace import of it is an offender with or without a subsequent member access. */
function isUsdModuleSpecifier(spec: string): boolean {
  return /(^|\/)usd$/.test(spec)
}

/** True for a module specifier that is the order-engine BARREL — it re-exports many names, so a
 *  namespace import of it is only an offender if the table's members are actually touched. */
function isBarrelModuleSpecifier(spec: string): boolean {
  return /(^|\/)order-engine$/.test(spec)
}

/**
 * Does this file reach the table (as opposed to merely mentioning it in a comment)? Matching import
 * / re-export / require syntax rather than the bare identifier is the whole trick: every module that
 * was moved OFF the table in this change still names it in a docblock explaining why, and a naive
 * grep would flag exactly the files that were fixed.
 *
 * SYNTACTIC, not semantic — see the DETECTOR SCOPE docblock above for exactly what is and is not
 * covered.
 */
function importsApproxPrices(source: string): boolean {
  // import { A, B } from '...'  /  export { A, B } from '...'
  const BRACE_RE = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*['"]/gs
  for (const match of source.matchAll(BRACE_RE)) {
    const names = match[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim())
    if (names.some((n) => TABLE_NAMES.includes(n))) return true
  }

  // export * from '...'  — full re-export; only an offender when the target IS the usd module.
  const STAR_EXPORT_RE = /export\s+\*\s+from\s*['"]([^'"]*)['"]/g
  for (const match of source.matchAll(STAR_EXPORT_RE)) {
    if (isUsdModuleSpecifier(match[1])) return true
  }

  // import * as name from '...'  — namespace import.
  const NS_IMPORT_RE = /import\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]*)['"]/g
  for (const match of source.matchAll(NS_IMPORT_RE)) {
    const [, name, spec] = match
    if (isUsdModuleSpecifier(spec)) return true
    if (isBarrelModuleSpecifier(spec) && new RegExp(`\\b${name}\\.(${TABLE_NAMES.join('|')})\\b`).test(source)) {
      return true
    }
  }

  // const { A } = require('...')  — CommonJS destructure.
  const REQUIRE_RE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*['"]\s*\)/g
  for (const match of source.matchAll(REQUIRE_RE)) {
    const names = match[1].split(',').map((n) => n.trim().split(/\s*:\s*/)[0].trim())
    if (names.some((n) => TABLE_NAMES.includes(n))) return true
  }

  // const name = await import('...')  — dynamic import bound to a variable, gated on member access.
  const DYNAMIC_IMPORT_RE = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+import\(\s*['"]([^'"]*)['"]\s*\)/g
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    const [, name, spec] = match
    if (!isUsdModuleSpecifier(spec) && !isBarrelModuleSpecifier(spec)) continue
    if (new RegExp(`\\b${name}\\.(${TABLE_NAMES.join('|')})\\b`).test(source)) return true
  }

  return false
}

describe('[FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE] APPROX_PRICES is display-only', () => {
  const FILES = walk(SRC)

  it('the scan reaches the whole tree (guard is not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(200)
    expect(FILES).toContain('lib/order-engine/usd.ts')
    expect(FILES).toContain('components/DCAPanel.tsx')
  })

  it('the detector recognises a real import and ignores a mere mention', () => {
    expect(importsApproxPrices("import { fillUsd } from '@/lib/order-engine/usd'")).toBe(true)
    expect(importsApproxPrices("import { APPROX_PRICES, foo } from '@/lib/order-engine'")).toBe(true)
    expect(importsApproxPrices('// APPROX_PRICES is NOT passed here — see INC-2026-08-07-001')).toBe(false)
    expect(importsApproxPrices("import { fillUsdSomethingElse } from './x'")).toBe(false)

    // [L-1 fixtures — DETECTED]
    // 1. Namespace import of the usd module itself — offender with OR without member access.
    expect(importsApproxPrices("import * as usd from '@/lib/order-engine/usd'")).toBe(true)
    expect(
      importsApproxPrices("import * as usd from '@/lib/order-engine/usd'\nconsole.log(usd.APPROX_PRICES)"),
    ).toBe(true)
    // 2. Namespace import of the BARREL — offender only once a table member is actually touched.
    expect(
      importsApproxPrices("import * as oe from '@/lib/order-engine'\nconsole.log(oe.APPROX_PRICES)"),
    ).toBe(true)
    expect(
      importsApproxPrices("import * as oe from '@/lib/order-engine'\noe.fillUsd(1, 'ETH')"),
    ).toBe(true)
    // 3. Brace-form re-export.
    expect(importsApproxPrices("export { APPROX_PRICES } from './usd'")).toBe(true)
    // 4. Full re-export of the usd module.
    expect(importsApproxPrices("export * from './usd'")).toBe(true)
    // 5. CommonJS destructure.
    expect(importsApproxPrices("const { fillUsd } = require('@/lib/order-engine/usd')")).toBe(true)
    // 6. Dynamic import bound to a variable, then a member touch on that variable.
    expect(
      importsApproxPrices("const m = await import('./usd')\nconsole.log(m.APPROX_PRICES)"),
    ).toBe(true)

    // [L-1 fixtures — MUST STAY UNDETECTED]
    // 7. A comment mentioning the name is not an import — this property is the whole point.
    expect(importsApproxPrices("// APPROX_PRICES is NOT passed here")).toBe(false)
    // 8. An unrelated name from an unrelated module.
    expect(importsApproxPrices("import { fillUsdSomethingElse } from './x'")).toBe(false)
    // 9. The barrel imported for OTHER names, with the table named only in a comment — DCAPanel.tsx's
    // own shape. Must not become an offender.
    expect(
      importsApproxPrices(
        "// APPROX_PRICES is NOT passed here — see INC-2026-08-07-001\n" +
          "import { getOrderExecutorV3, deriveSigningMinAmountOut } from '@/lib/order-engine'",
      ),
    ).toBe(false)
  })

  it('NO module outside the display/analytics allowlist imports the approximate price table', () => {
    const offenders = FILES.filter(
      (f) => !ALLOWED.has(f) && importsApproxPrices(readFileSync(join(SRC, f), 'utf8')),
    )
    expect(
      offenders,
      'These modules import APPROX_PRICES/fillUsd but are not on the display-only allowlist.\n' +
        'If the import is a GATE or a SIGNING input it must read the live Chainlink → DefiLlama\n' +
        'price instead (see DCAPanel.livePriceIn). If it is genuinely display, add it to ALLOWED\n' +
        'with a comment saying why a stale estimate is harmless there:\n' +
        offenders.join('\n'),
    ).toEqual([])
  })

  it('the two modules this change moved OFF the table stay off it', () => {
    // Named explicitly so a revert is unmistakable in the failure output, rather than showing up as
    // an anonymous entry in the list above.
    for (const f of ['components/DCAPanel.tsx', 'hooks/useOrderEngine.ts']) {
      expect(importsApproxPrices(readFileSync(join(SRC, f), 'utf8')), f).toBe(false)
    }
  })

  it('every allowlisted path still exists — a stale allowlist silently widens the hole', () => {
    for (const f of ALLOWED) expect(FILES, f).toContain(f)
  })
})
