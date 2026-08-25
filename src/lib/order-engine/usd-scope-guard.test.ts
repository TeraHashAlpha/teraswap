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
 * closed here instead: this suite enumerates every module that imports the table (or `fillUsd`,
 * which is the table wearing a function) and fails on any importer not on the display/analytics
 * allowlist below.
 *
 * Adding a module to the allowlist is therefore a deliberate, reviewable act, and the comment
 * required next to each entry has to say why a stale estimate is harmless there.
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

/**
 * Does this file IMPORT the table (as opposed to merely mentioning it in a comment)? Matching the
 * import statement rather than the bare identifier is the whole trick: every module that was moved
 * OFF the table in this change still names it in a docblock explaining why, and a naive grep would
 * flag exactly the files that were fixed.
 */
function importsApproxPrices(source: string): boolean {
  const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*['"]/gs
  for (const match of source.matchAll(IMPORT_RE)) {
    const names = match[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim())
    if (names.includes('APPROX_PRICES') || names.includes('fillUsd')) return true
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
