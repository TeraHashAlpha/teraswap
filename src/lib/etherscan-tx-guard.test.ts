/**
 * [fix/tx-links-remaining] `ETHERSCAN_TX` (`src/lib/constants.ts`) is mainnet-only — a Base/Arbitrum
 * tx rendered against it links to an etherscan.io page where that tx does not exist. Every real
 * caller (SwapBox, ToastProvider, LimitOrderPanel, ConditionalOrderPanel, AdminMonitor) migrated to
 * the chain-aware `explorerTxUrl` from `@/lib/chains/tokens`, and the export itself is marked
 * `@deprecated` and kept (CLAUDE.md rule #4: never delete).
 *
 * This guard enforces the "0 remaining callers" half of that deprecation structurally, the same way
 * `lib/order-engine/usd-scope-guard.test.ts` enforces the APPROX_PRICES boundary: a SYNTACTIC scan
 * (no AST, no cross-file resolution) over every .ts/.tsx under src/ for a reference that actually
 * REACHES the constant — a brace import/re-export naming it, or a namespace import of the constants
 * module followed by a member touch (`ns.ETHERSCAN_TX`). It does NOT detect a bare mention in a
 * comment or string (so this file, and the deprecation comment on the export itself, pass freely),
 * and a module that reaches the constant via something exotic (`globalThis['ETHERSCAN' + '_TX']`,
 * a dynamic `await import(...)` bound to a variable) would slip through undetected — that residual
 * gap is accepted, not claimed closed, exactly as documented for the APPROX_PRICES guard.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..')

/** The only two files allowed to reference the name: the definition itself, and this guard. */
const ALLOWED = new Set([
  'lib/constants.ts',
  'lib/etherscan-tx-guard.test.ts',
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

/** True for a module specifier that is the constants module itself. */
function isConstantsModuleSpecifier(spec: string): boolean {
  return /(^|\/)constants$/.test(spec)
}

/** Does this file reach `ETHERSCAN_TX` (as opposed to merely mentioning it in a comment/string)? */
function importsEtherscanTx(source: string): boolean {
  // import { A, B } from '...'  /  export { A, B } from '...'
  const BRACE_RE = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*['"]/gs
  for (const match of source.matchAll(BRACE_RE)) {
    const names = match[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim())
    if (names.includes('ETHERSCAN_TX')) return true
  }

  // import * as name from '...'  — namespace import of the constants module, gated on member access.
  const NS_IMPORT_RE = /import\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]*)['"]/g
  for (const match of source.matchAll(NS_IMPORT_RE)) {
    const [, name, spec] = match
    if (isConstantsModuleSpecifier(spec) && new RegExp(`\\b${name}\\.ETHERSCAN_TX\\b`).test(source)) return true
  }

  return false
}

describe('[fix/tx-links-remaining] ETHERSCAN_TX is deprecated — 0 callers outside its own definition', () => {
  const FILES = walk(SRC)

  it('the scan reaches the whole tree (guard is not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(200)
    expect(FILES).toContain('lib/constants.ts')
    expect(FILES).toContain('components/SwapBox.tsx')
  })

  it('the detector recognises a real import and ignores a mere mention', () => {
    expect(importsEtherscanTx("import { ETHERSCAN_TX } from '@/lib/constants'")).toBe(true)
    expect(importsEtherscanTx("import { ETHERSCAN_TX, AGGREGATOR_META } from '@/lib/constants'")).toBe(true)
    expect(importsEtherscanTx('// ETHERSCAN_TX is deprecated — see docs/feedback/fix-tx-links-remaining.md')).toBe(false)
    expect(importsEtherscanTx("import { ETHERSCAN_TX_SOMETHING_ELSE } from './x'")).toBe(false)
    expect(importsEtherscanTx("import * as constants from '@/lib/constants'\nconstants.ETHERSCAN_TX")).toBe(true)
    expect(importsEtherscanTx("import * as constants from '@/lib/constants'\nconstants.AGGREGATOR_META")).toBe(false)
  })

  it.each(FILES.filter((f) => !ALLOWED.has(f)))('%s does not import ETHERSCAN_TX', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8')
    expect(importsEtherscanTx(source)).toBe(false)
  })
})
