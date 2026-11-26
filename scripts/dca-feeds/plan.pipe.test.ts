// @vitest-environment node
/**
 * [fix/script-stdout-truncated-on-exit] plan.ts prints ONE JSON (every plan item, with the live feed reading) and ended with
 * process.exit(exitCode): a slow pipe got the first ~64 KB of it, which is not JSON. The RPC is an in-process stub
 * (plan-rpc-stub.mjs: real config, real DEPLOYMENTS.md, feed descriptions padded so the report is far bigger than a pipe); the reader
 * is held back until the script's module has finished (signal-after-main.mjs): no network, no sleep, no load.
 */
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { rowsFor, inPlanScope } from './lib'
import { runWithHeldBackOutput } from '../lib/held-back-reader.mjs'

const ROOT = resolve(__dirname, '../..')
const RUNNER = resolve(ROOT, 'scripts/lib/signal-after-main.mjs')
const STUB = resolve(__dirname, 'plan-rpc-stub.mjs')
const PLAN = resolve(__dirname, 'plan.ts')

describe('plan.ts: a slow reader still gets the whole JSON', () => {
  it('Base, every in-scope row with a padded feed description: complete JSON, exit code 1 (rows BLOCKED), summary on stderr', async () => {
    const inScope = rowsFor(8453).filter(inPlanScope).length
    expect(inScope).toBeGreaterThan(10)

    const r = await runWithHeldBackOutput({
      command: process.execPath,
      args: ['--no-warnings', '--import', STUB, RUNNER, PLAN, '--chain', 'base'],
      cwd: ROOT,
    })
    const text = r.stdout.toString('utf8')
    expect(r.stderr.toString('utf8')).toContain('summary:')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text) // a cut report is not JSON
    expect(parsed).toHaveLength(1)
    expect(parsed[0].items).toHaveLength(inScope)
    expect(text.length).toBeGreaterThan(256 * 1024) // bigger than both buffers, so the lines above mean something
    expect(r.code).toBe(1)
  })
})
