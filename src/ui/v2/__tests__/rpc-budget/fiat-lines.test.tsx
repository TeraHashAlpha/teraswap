// @vitest-environment jsdom
/**
 * [feat/ui-v2-fiat-value C3] "No extra RPC polling" for the fiat lines, measured on the Swap tab (visitor + amount, wallet + amount):
 * the lines cost ZERO JSON-RPC calls (their price is the Portfolio's HTTP route, their euro rate is our own HTTP route), they poll at most
 * once a minute, nothing at all while the tab is hidden, and the euro rate is probed once on mount (never in the steady minute).
 */
import { writeFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/rpc-guarded-transport', async () => (await import('@/test-utils/rpc-harness')).mockGuardedTransportModule())
vi.mock('@/components/BackgroundMusic', () => ({ default: () => null }))
vi.mock('@/lib/sounds', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/sounds')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]))
})
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/portfolio' }))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null, setParticleTurbo: vi.fn() }))

import { installHarnessGlobals, runScenario, sum, type State } from './scenarios'

beforeAll(() => installHarnessGlobals())

describe('Swap tab with the fiat lines: no RPC added, HTTP at most once a minute', () => {
  it.each(['b', 'c', 'c20'] as State[])('state %s: v2 calls no RPC method v1 does not, ≤ v1 in the steady window and the mount burst; prices ≤ 1/min, 0 hidden, the EUR probe is once on mount', async (state) => {
    const v1 = await runScenario({ ui: 'v1', state, hide: true })
    const v2 = await runScenario({ ui: 'v2', state, hide: true })
    if (process.env.RPC_FIAT_OUT) writeFileSync(process.env.RPC_FIAT_OUT, `${JSON.stringify({ state, v1, v2 })}\n`, { flag: 'a' }) // evidence for the feedback file

    expect(Object.keys(v2.steady).filter((m) => !(m in v1.steady)), `v2 steady ${JSON.stringify(v2.steady)}`).toEqual([])
    expect(sum(v2.steady)).toBeLessThanOrEqual(sum(v1.steady))
    expect(sum(v2.mount)).toBeLessThanOrEqual(sum(v1.mount))
    expect(sum(v2.hidden ?? {})).toBe(0)

    // The fiat lines' own traffic is HTTP to our origin: the Portfolio price route, one merged request per tick …
    expect(v2.http.steady['/api/portfolio/prices'] ?? 0).toBeLessThanOrEqual(1)
    expect(v2.http.hidden?.['/api/portfolio/prices'] ?? 0).toBe(0)
    // … the on-card switch probes the euro rate ONCE on mount (an hour-cached read of our own route): never in the steady minute, never hidden.
    expect(v2.http.steady['/api/fiat/eur-usd'] ?? 0).toBe(0)
    expect(v2.http.hidden?.['/api/fiat/eur-usd'] ?? 0).toBe(0)
    // v1 is untouched by all of this.
    expect(v1.http.steady['/api/portfolio/prices'] ?? 0).toBe(0)
    expect(v1.http.steady['/api/fiat/eur-usd'] ?? 0).toBe(0)
  }, 180_000)
})
