#!/usr/bin/env node
/**
 * [INC-2026-05-31-001] Circular-import CI guard.
 *
 * A circular import can resolve to `undefined` exports in the Next.js PRODUCTION
 * bundle while Vitest's module resolver tolerates it — the exact class of defect
 * investigated in INC-2026-05-31-001 (unit tests green, prod bundle 502). This
 * guard fails CI on any NEW cycle under src/lib.
 *
 * The cycles in the alerting subsystem (alert-wrapper <-> alert-channels/*,
 * source-state-machine <-> alert-wrapper) are PRE-EXISTING and baselined here so
 * the guard flags only newly introduced cycles. Shrink the allowlist as the
 * pre-existing cycles are paid down.
 *
 * Uses `npx madge` so no production/runtime dependency is added.
 */
import { execFileSync } from 'node:child_process'

// A cycle is allowed (baselined) only if EVERY file in it is in this subsystem.
const BASELINE_SUBSYSTEM = /(^|\/)(alert-wrapper|alert-channels\/|source-state-machine)/

// Fixed argument array (no shell, no interpolation) — execFile avoids shell injection.
const MADGE_ARGS = ['--yes', 'madge', '--circular', '--json', '--ts-config', 'tsconfig.json', '--extensions', 'ts,tsx', 'src/lib']

function runMadge() {
  try {
    // Exit 0 (no cycles): stdout holds the JSON ("[]").
    return execFileSync('npx', MADGE_ARGS, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    // madge exits non-zero when cycles exist; the JSON is still on stdout.
    const out = err.stdout ? err.stdout.toString() : ''
    if (out.trim().startsWith('[')) return out
    console.error('check-circular: failed to run madge:', err.message)
    process.exit(2)
  }
}

const cycles = JSON.parse(runMadge() || '[]')
const isBaselined = (cycle) => cycle.every((f) => BASELINE_SUBSYSTEM.test(f))
const novel = cycles.filter((c) => !isBaselined(c))

if (novel.length > 0) {
  console.error(`\n✖ ${novel.length} NEW circular dependency(ies) in src/lib (not baselined):`)
  novel.forEach((c, i) => console.error(`  ${i + 1}) ${c.join(' → ')}`))
  console.error(
    '\nCircular imports can yield undefined exports in the Next prod bundle ' +
      '(see Audits/Incidents/INC-2026-05-31-001.md). Break the cycle before merging.\n',
  )
  process.exit(1)
}
console.log(`✓ check-circular: no new circular dependencies (${cycles.length} known/baselined).`)
