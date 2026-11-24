// @vitest-environment node
/**
 * [fix/script-stdout-truncated-on-exit] Repo guard: a script that writes to stdout and ends with process.exit loses output.
 *
 * Why: stdout is a pipe in CI and in `| tee` / `| less`, and a pipe write is asynchronous. process.exit drops what the kernel has not
 * taken yet (about 64 KB), so a large report arrived cut: scripts/orders/check-order-hashes.test.ts failed in CI on PR #720 with 335 of
 * ~666 lines. The fix is to set process.exitCode and let the process end, or to wait for the streams (contracts/order-engine/executor/
 * exit-drained.js).
 *
 * HOW IT DECIDES (a text rule, on purpose, so it needs no run and no network). A file under scripts/ or
 * contracts/order-engine/executor/ (.js .mjs .cjs .ts .mts .cts) FAILS when, after comment lines are dropped, it contains BOTH
 *   - a stdout write: console.log / console.info / console.table / console.dir, process.stdout.write or <x>.stdout.write, and
 *   - a call or reference to process.exit (process.exitCode is fine).
 * It is a file-level rule: it does not try to order the two, because a helper such as `say()` defined at the top and a `fail()` called
 * after it are exactly the shape that lost output.
 *
 * WHAT IT EXEMPTS
 *   - test files (*.test.*), __fixtures__ and node_modules: they are not operator scripts and a test may exit a child.
 *   - EXEMPT_DAEMONS: long-running processes whose exits are boot refusals and signal handlers, not the end of a report.
 *   - ALLOWED: a file that still has the pattern, each with a WRITTEN reason that its stdout cannot reach a pipe's capacity before it
 *     exits (a fixed handful of lines, bounded by an in-repo list). An allowlisted file that no longer has the pattern fails the test
 *     (delete the entry), and so does an entry without a reason: the list cannot rot into "everything".
 * Adding a new script with the pattern means fixing it (exitCode / exit-drained.js) or adding an entry here that says why it is bounded.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const TREES = ['scripts', 'contracts/order-engine/executor']
const EXT = /\.(?:js|mjs|cjs|ts|mts|cts)$/

/** Daemons: process.exit there is a boot refusal or a signal handler (executor.js is also out of this change's scope). */
const EXEMPT_DAEMONS = {
  'contracts/order-engine/executor/executor.js': 'the keeper daemon: exits are boot refusals and signal handlers, its stdout is a log stream',
  'contracts/order-engine/executor/exit-drained.js': 'the fix itself: writes an empty chunk to each stream and exits from the last write callback',
}

/**
 * path -> why its stdout is bounded below a pipe's capacity (about 64 KB) before the exit. Read from the code on 2026-11-24, not
 * measured per run: "fixed" = literal text, "in-repo list" = a loop over a table that lives in this repository.
 */
const ALLOWED = {
  'scripts/capture-endpoint-baseline.ts': 'one line per monitored endpoint (the in-repo MONITORED_ENDPOINTS list) plus a few fixed lines',
  'scripts/check-agents-parity.mjs': 'two fixed one-line messages; the exits are the failure paths that print to stderr',
  'scripts/check-bash3-compat.mjs': 'its only stdout line is fixed text written after the one exit (the failure path exits first)',
  'scripts/check-circular.mjs': 'its only stdout line is fixed text written after both exits (the failure paths exit first)',
  'scripts/check-deployed-sources.mjs': 'its stdout is written after the one exit (the failure path exits first), a short fixed summary',
  'scripts/dca-feeds/batch.ts': 'every exit precedes the only stdout write (the config, a single write at the very end)',
  'scripts/dca-feeds/build-config.mjs': 'the one exit is the usage refusal at the top, before any stdout; the rest is a few lines per chain',
  'scripts/check-color-contrast.mjs': 'prints 807 bytes: the report covers a fixed set of status-colour pairs, whatever the config it is given',
  'scripts/dca-feeds/candidates.ts': 'every exit precedes the only stdout write (the report, a single write at the very end)',
  'scripts/dca-feeds/plan.ts': 'ONE JSON of the in-repo config\'s enabled rows (28 today, tens of KB); the test below fails when that count passes 40',
  'scripts/dca-feeds/verify.ts': 'one line per feed row of the in-repo config (tens of rows) plus a header per chain',
  'scripts/fiat/build-eur-usd-feed.mjs': 'the one exit precedes the only stdout write (the feed file text, written last)',
  'scripts/gen-claude-state.mjs': 'the CLAUDE.md state block (about 4 KB) or a one-line status',
  'scripts/generate-arbitrum-catalog.mjs': 'two fixed one-line messages; both exits precede them',
  'scripts/goal-lint.mjs': 'one FAIL line per violated rule (about ten rules) for a goal text capped at 4000 characters',
  'scripts/og-image/build.mjs': 'one short block per generated image (a handful); the exit is the failure path',
  'scripts/setup-telegram-webhook.ts': 'a few fixed lines about one webhook',
  'scripts/sync-readme-deployments.mjs': 'one line per contract address in docs/DEPLOYMENTS.md (tens) plus one summary line',
  'scripts/sync-token-categories.ts': 'two fixed lines: a superseded stub that only prints a pointer and exits 0',
  'scripts/token-catalog/refresh-issue.ts': 'one line per chain (three chains)',
  'scripts/token-catalog/report-diff.ts': 'formatDiffSummary caps each list at 20 entries: at most 61 lines',
  'scripts/verify-arbitrum-addresses.mjs': 'one line per address of the in-repo Arbitrum manifest (tens) plus a summary',
  'scripts/verify-arbitrum-chainlink-feeds.mjs': 'one line per feed of the in-repo Arbitrum feed table (tens) plus a summary',
  'scripts/verify-base-cbeth-feeds.mjs': 'a few lines per feed for the three cbETH feeds',
  'scripts/verify-curve-pool-types.mjs': 'a few lines per Curve pool and candidate poolType of the in-repo tables, plus a summary',
  'scripts/verify-deployed-sources.mjs': 'one line per deployed contract of docs/DEPLOYMENTS.md (tens) plus a summary',
}

const STDOUT_WRITE = /\bconsole\.(?:log|info|table|dir)\s*\(|\bprocess\.stdout\.write\s*\(|\bstdout\.write\s*\(/
const PROCESS_EXIT = /\bprocess\.exit\b/

/** Drop whole-line comments (//, /*, *). Inline trailing comments and strings are left alone: a miss there is a visible allowlist entry. */
export function stripComments(text) {
  return text.split('\n').filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l)).join('\n')
}

export function hasPattern(text) {
  const code = stripComments(text)
  return STDOUT_WRITE.test(code) && PROCESS_EXIT.test(code)
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__fixtures__') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXT.test(name) && !/\.test\.[^.]+$/.test(name)) out.push(p)
  }
}

function flaggedFiles() {
  const files = []
  for (const t of TREES) walk(join(ROOT, t), files)
  return files
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((rel) => !(rel in EXEMPT_DAEMONS))
    .filter((rel) => hasPattern(readFileSync(join(ROOT, rel), 'utf8')))
    .sort()
}

describe('scripts that write to stdout must not end with process.exit', () => {
  const flagged = flaggedFiles()

  it('every file with the pattern is allowlisted with a reason', () => {
    const unexplained = flagged.filter((f) => !(f in ALLOWED))
    expect(unexplained, 'set process.exitCode (or use exit-drained.js) instead of process.exit, or add a written reason to ALLOWED').toEqual([])
  })

  it('no allowlist entry is stale or unexplained', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !flagged.includes(f))
    expect(stale, 'these no longer have the pattern (or do not exist): delete the entry').toEqual([])
    const thin = Object.entries(ALLOWED).filter(([, why]) => typeof why !== 'string' || why.trim().length < 25).map(([f]) => f)
    expect(thin, 'give each entry a real reason').toEqual([])
  })

  it('plan.ts stays allowlisted only while its JSON is small: at most 40 enabled rows (about 2.5 KB each, estimated, not run: it needs a live RPC)', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'src/config/dca-feed-registrations.json'), 'utf8'))
    const enabled = Object.values(cfg.chains).flatMap((c) => c.rows).filter((r) => r.enabled).length
    expect(enabled, 'plan.ts prints one JSON for all enabled rows, then exits: past ~50 rows it can pass a pipe. Set process.exitCode there and drop its ALLOWED entry').toBeLessThanOrEqual(40)
  })

  it('the detector: what it flags and what it leaves alone', () => {
    expect(hasPattern('console.log("x")\nprocess.exit(1)')).toBe(true)
    expect(hasPattern('process.stdout.write(s)\nif (!ok) process.exit(2)')).toBe(true)
    expect(hasPattern('io.stdout.write(s)\nprocess.exit(main())')).toBe(true)
    expect(hasPattern('const say = (m) => console.info(m)\nconst bye = process.exit')).toBe(true)
    expect(hasPattern('console.log("x")\nprocess.exitCode = 1')).toBe(false)
    expect(hasPattern('console.error("x")\nprocess.exit(1)')).toBe(false) // stderr-only: small messages, out of scope here
    expect(hasPattern('console.log("x")\n// process.exit(1) would drop the output\n * process.exit(1)')).toBe(false)
    expect(hasPattern('process.exit(1)')).toBe(false) // no stdout write
  })

  it('the trees it scans exist and are not empty (a moved directory must not make the guard pass by scanning nothing)', () => {
    const files = []
    for (const t of TREES) walk(join(ROOT, t), files)
    expect(files.length).toBeGreaterThan(40)
    expect(files.some((f) => f.endsWith(`${sep}exit-drained.js`))).toBe(true)
    expect(files.some((f) => f.endsWith(`${sep}check-order-hashes.ts`))).toBe(true)
  })
})
