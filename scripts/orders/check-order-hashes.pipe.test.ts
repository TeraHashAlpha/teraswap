// @vitest-environment node
/**
 * [fix/script-stdout-truncated-on-exit] check-order-hashes must deliver EVERY stdout line to a reader that is slower than it.
 * CI (PR #720, Linux) lost the second half of a 1,000-row run: the script wrote its rows with console.log (asynchronous on a pipe)
 * and ended with process.exit, which drops what the kernel has not taken yet.
 *
 * The reader here starts only after the script's stderr summary has arrived (see held-back-reader.mjs): no sleep, no load. On the
 * unfixed script this run delivers about 131 KB of ~880 KB on macOS; the Linux CI figure was 335 of ~666 lines.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { checkRows, groupRows } from './check-order-hashes-lib'
// @ts-expect-error TS5097 the harness is plain .mjs next to its .d.mts
import { runWithHeldBackStdout } from '../lib/held-back-reader.mjs'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = resolve(__dirname, 'check-order-hashes.ts')
const fixture = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/order-rows.json'), 'utf8')) as Record<string, unknown>[]
const differs = fixture.find((r) => r.id === 'v3-caller-text')!

// 4,000 rows: stdout is several times the ~128 KB a kernel pipe plus the reader's buffer hold, whatever the platform's pipe size.
const ROWS = 4000
const input = Array.from({ length: ROWS }, (_, i) => ({ ...differs, id: `row-${i}`, signature: `0x${(i + 1).toString(16).padStart(130, '1')}` }))

describe('check-order-hashes: a slow stdout reader still gets every line', () => {
  it('delivers every row line and the groups, then exits with the same code', async () => {
    const verdicts = checkRows(input)
    const groups = groupRows(input, verdicts)
    const expectedLines = verdicts.filter((v) => v.verdict === 'differs' || v.verdict === 'non-canonical').length +
      groups.sameComputedHash.length + groups.sameSignature.length
    expect(expectedLines).toBeGreaterThan(ROWS) // every row differs, plus the group lines: the oracle is not the script

    const r = await runWithHeldBackStdout({
      command: process.execPath,
      args: ['--no-warnings', SCRIPT],
      cwd: ROOT,
      input: JSON.stringify(input),
      releaseWhen: (stderr: string) => /checked \d+ rows/.test(stderr),
    })
    const text = r.stdout.toString('utf8')
    const lines = text.split('\n').filter(Boolean)

    expect(lines.length).toBe(expectedLines)
    expect(r.stdout.length).toBeGreaterThan(256 * 1024) // the run is big enough to overflow both buffers, so the line above means something
    expect(text.endsWith('\n')).toBe(true)
    for (const l of lines) JSON.parse(l) // no line cut in the middle
    expect(new Set(lines.filter((l) => l.includes('"verdict":"differs"')).map((l) => (JSON.parse(l) as { id: string }).id)).size).toBe(ROWS)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`checked ${ROWS} rows`)
  })

  it('exit code 2 for unreadable input is unchanged', async () => {
    const r = await runWithHeldBackStdout({
      command: process.execPath,
      args: ['--no-warnings', SCRIPT],
      cwd: ROOT,
      input: 'not json',
      releaseWhen: () => true,
    })
    expect(r.code).toBe(2)
    expect(r.stdout.length).toBe(0)
    expect(r.stderr).toContain('check-order-hashes:')
  })
})
