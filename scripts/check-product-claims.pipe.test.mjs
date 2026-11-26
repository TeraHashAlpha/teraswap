// @vitest-environment node
/**
 * [fix/script-stdout-truncated-on-exit] check-product-claims prints its failure report on STDERR, one line per hard-coded claim, and
 * used to end with process.exit(result.code): a file with thousands of claims lost the end of the report on a slow reader.
 * Both streams are held back until the script's module has finished (signal-after-main.mjs): no sleep, no load.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { ROOT, checkFiles, formatReport } from './check-product-claims.mjs'
import { runWithHeldBackOutput } from './lib/held-back-reader.mjs'

const RUNNER = path.join(ROOT, 'scripts/lib/signal-after-main.mjs')
const SCRIPT = path.join(ROOT, 'scripts/check-product-claims.mjs')

describe('check-product-claims: a slow reader still gets the whole failure report', () => {
  it('4,000 hard-coded claims: every report line on stderr, exit code 1', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claims-'))
    try {
      const file = path.join(dir, 'many-claims.tsx')
      writeFileSync(file, Array.from({ length: 4000 }, (_, i) => `const t${i} = 'Aggregates 12 liquidity sources for you'`).join('\n') + '\n')
      const rel = path.relative(ROOT, file) // the CLI resolves --file against the repo root
      const expected = formatReport(checkFiles(ROOT, [rel]))
      expect(expected.failed).toBe(4000)

      const r = await runWithHeldBackOutput({ command: process.execPath, args: [RUNNER, SCRIPT, '--file', rel], cwd: ROOT })
      const want = `product-claims check failed (4000 hard-coded claim(s)):\n${expected.text}\n`
      expect(r.stderr.toString('utf8').length).toBe(want.length)
      expect(r.stderr.toString('utf8')).toBe(want)
      expect(want.length).toBeGreaterThan(256 * 1024) // bigger than both buffers, so the line above means something
      expect(r.stdout.length).toBe(0)
      expect(r.code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
