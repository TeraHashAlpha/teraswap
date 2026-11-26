// @vitest-environment node
/**
 * [fix/script-stdout-truncated-on-exit] check-color-contrast ended with process.exit(main()) right after writing its report.
 * Its report is a fixed 807 bytes, so a real pipe never fills and no real-pipe test can fail on the unfixed script. This test SIMULATES
 * the asynchronous write (scripts/lib/async-stdio.mjs: queue, flush on the next loop turn) and requires the whole report and the
 * same exit code as a plain run: on the unfixed script the queue is dropped and the report is empty.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts/check-color-contrast.mjs')
const PRELOAD = path.join(ROOT, 'scripts/lib/async-stdio.mjs')
const run = (extra) => spawnSync(process.execPath, [...extra, SCRIPT], { cwd: ROOT, encoding: 'utf8' })

describe('check-color-contrast: an asynchronous stdout still delivers the whole report', () => {
  it('prints the same report and exits with the same code as a plain run', () => {
    const plain = run([])
    expect(plain.stdout.length).toBeGreaterThan(500)
    const slow = run(['--import', PRELOAD])
    expect(slow.stdout).toBe(plain.stdout)
    expect(slow.stderr).toBe(plain.stderr)
    expect(slow.status).toBe(plain.status)
    expect(slow.status).toBe(0)
  })
})
