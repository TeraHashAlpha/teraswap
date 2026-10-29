// @vitest-environment jsdom
/**
 * [feat/frontend-rpc-diet] Measurement harness — characterises browser JSON-RPC traffic per UI state.
 * Prints a markdown table (and writes it to $RPC_TABLE_OUT when set). Budget assertions live in
 * `guards.test.tsx`; this file only proves the harness counts and the hidden path is measurable.
 */
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/rpc-guarded-transport', async () => (await import('@/test-utils/rpc-harness')).mockGuardedTransportModule())
vi.mock('@/components/BackgroundMusic', () => ({ default: () => null }))
vi.mock('@/components/UsageTracker', () => ({ default: () => null }))
vi.mock('@/lib/sounds', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/sounds')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]))
})
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null, setParticleTurbo: vi.fn() }))

import { installHarnessGlobals, runScenario, sum, type ScenarioResult, type State, type Ui } from './scenarios'

const results: ScenarioResult[] = []

beforeAll(() => installHarnessGlobals())

afterAll(() => {
  const methods = (m: Record<string, number> | null) =>
    Object.entries(m ?? {})
      .map(([k, v]) => `${k}×${v}`)
      .join(' ')
  const rows = results.map(
    (r) =>
      `| ${r.ui} | ${r.state} | ${sum(r.mount)} (${methods(r.mount)}) | ${sum(r.steady)} | ${methods(r.steady) || '—'} | ${r.hidden ? sum(r.hidden) : '—'} | ${r.returned ? sum(r.returned) : '—'} |`,
  )
  const table = [
    '| UI | state | mount burst (by method) | steady calls/min | steady by method | hidden 60 s | on return (5 s) |',
    '|---|---|---:|---:|---|---:|---:|',
    ...rows,
  ].join('\n')
  console.log(`\nRPC TABLE\n${table}\n`)
  if (process.env.RPC_TABLE_OUT) writeFileSync(process.env.RPC_TABLE_OUT, `${table}\n`)
})

const STATES: State[] = ['a0', 'a', 'b', 'c', 'c20']

describe.each(['v1', 'v2'] as Ui[])('browser RPC harness — %s', (ui) => {
  it.each(STATES)('state %s: visible then hidden', async (state) => {
    const r = await runScenario({ ui, state, hide: true })
    results.push(r)
    // Harness sanity only: something is counted, and the numbers are finite.
    expect(sum(r.mount)).toBeGreaterThan(0)
    expect(Number.isFinite(sum(r.steady))).toBe(true)
  }, 60_000)
})
