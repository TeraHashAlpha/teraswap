// @vitest-environment node
/**
 * [fix/script-stdout-truncated-on-exit] audit-gate prints one block per blocking advisory on STDERR and then fails the build. It ended
 * with process.exit(1), which drops what a slow pipe has not taken yet: a CI log (or `| tee`) showed a failing gate with the end of
 * the list, and the "Resolve via an npm overrides pin" instructions, missing.
 *
 * A fake `npm` on PATH answers `npm audit --json` with 3,000 high advisories that are not allowlisted. Both streams are held back
 * until the script's module has finished (signal-after-main.mjs): no network, no sleep, no load.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { runWithHeldBackOutput } from './lib/held-back-reader.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUNNER = path.join(ROOT, 'scripts/lib/signal-after-main.mjs')
const SCRIPT = path.join(ROOT, 'scripts/audit-gate.mjs')
const N = 3000

describe('audit-gate: a slow reader still gets the whole failure report', () => {
  it(`${N} blocking advisories: every block, the instructions at the end, stdout summary, exit code 1`, async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'fake-npm-'))
    try {
      const vulnerabilities = Object.fromEntries(Array.from({ length: N }, (_, i) => [
        `pkg-${i}`,
        { via: [{ severity: 'high', name: `pkg-${i}`, source: 1000 + i, url: `https://github.com/advisories/GHSA-test-${String(i).padStart(4, '0')}`, title: `Prototype pollution in pkg-${i}` }] },
      ]))
      const fake = path.join(bin, 'npm')
      writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ vulnerabilities }))})\nprocess.exitCode = 1\n`)
      chmodSync(fake, 0o755)

      const r = await runWithHeldBackOutput({
        command: process.execPath,
        args: [RUNNER, SCRIPT],
        cwd: ROOT,
        env: { PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: process.env.HOME },
      })
      const err = r.stderr.toString('utf8')
      const out = r.stdout.toString('utf8')
      expect(err.split('\n').filter((l) => l === '  NOT allowlisted:').length).toBe(N)
      expect(err).toContain(`audit-gate FAILED — ${N} problems:`)
      expect(err).toContain(`GHSA-test-${String(N - 1).padStart(4, '0')}`) // the LAST advisory
      expect(err.trimEnd().endsWith('Architect review).')).toBe(true) // the instructions after the list
      expect(out).toContain(`audit-gate: ${N} high/critical advisories present, 0 allowlisted, ${N} blocking.`)
      expect(err.length).toBeGreaterThan(256 * 1024) // bigger than both buffers, so the lines above mean something
      expect(r.code).toBe(1)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
