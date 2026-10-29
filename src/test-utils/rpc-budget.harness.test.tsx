// @vitest-environment jsdom
/**
 * [feat/frontend-rpc-diet] Measurement harness — characterises browser JSON-RPC traffic per UI state.
 * Prints a markdown table (and writes it to $RPC_TABLE_OUT when set). Budget assertions live in
 * `rpc-budget.guards.test.tsx`; this file only proves the harness counts and the hidden path is measurable.
 */
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/rpc-guarded-transport', async () => (await import('./rpc-harness')).mockGuardedTransportModule())
vi.mock('@/components/BackgroundMusic', () => ({ default: () => null }))
vi.mock('@/components/UsageTracker', () => ({ default: () => null }))
vi.mock('@/lib/sounds', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/sounds')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]))
})
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null, setParticleTurbo: vi.fn() }))

import { fixtureMeta } from '@/ui/v2/swap/test-fixtures'
import { runScenario, sum, type ScenarioResult, type State, type Ui } from './rpc-scenarios'

const results: ScenarioResult[] = []

beforeAll(() => {
  // jsdom has no IntersectionObserver (framer-motion's useInView on the landing needs one).
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    },
  )
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  // /api/quote answers with a real-shaped 5-source quote (HTTP is not RPC; the quote only has to EXIST so the oracle /
  // approval hooks that key off it are active, exactly as for a user who typed an amount). Everything else: `{}`.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      let body: unknown = {}
      if (url.includes('/api/quote')) {
        // Echo the request's identity exactly as /api/quote does (useQuote rejects a quote that does not name its pair).
        const q = new URL(url, 'http://localhost').searchParams
        body = {
          ...fixtureMeta({ fetchedAt: Date.now() }),
          tokenIn: q.get('src'),
          tokenOut: q.get('dst'),
          chainId: Number(q.get('chainId') ?? 1),
          decimalsIn: Number(q.get('srcDecimals')),
          decimalsOut: Number(q.get('dstDecimals')),
          amountIn: q.get('amount'),
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})

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
