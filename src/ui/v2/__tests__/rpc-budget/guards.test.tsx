// @vitest-environment jsdom
/**
 * [feat/frontend-rpc-diet] Per-tab browser-RPC budgets. Each case fails if a future change makes a tab pay more
 * JSON-RPC requests than the budget below — the point of the diet is that this number stays down.
 *
 * Budgets (calls per minute, steady state of a visible tab, v1 AND v2):
 *   a0 landing, a swap idle                ≤ 1   (owner: the live footer block is the only on-chain figure; relaxed from 0)
 *   b  visitor, pair + amount (quoting)    ≤ 6
 *   c  wallet, pair + amount (ETH→USDC)    ≤ 12   c20 the same with an ERC-20 sell (USDC→ETH)
 *   p  wallet on the Portfolio tab (B8)    ≤ 6    (measured 4 for v1 and v2: the footer block + 3 wallet reads; the holdings add none of their own)
 *   an wallet on the Analytics tab (B9)   ≤ 6    (the same reads as `p`: the footer block + the wallet's own; the three Analytics reads are HTTP, not RPC)
 *   docs disconnected visitor on /docs (feat/ui-v2-docs-legal)  ≤ 1   (no wallet/chain reads of its own — product-claims are pure functions — same budget as a0/a)
 *   d  hidden tab                          = 0, and returning to visible refreshes each source once (0 < n ≤ mount burst)
 * The page-load burst is reported by the harness table, not budgeted per minute; it is capped here so it cannot grow unnoticed.
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
// [B8] the v2 Portfolio tab's Swap button navigates with the App Router (no Next app mounted here; nothing is pressed).
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/portfolio' }))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null, setParticleTurbo: vi.fn() }))

import { installHarnessGlobals, runScenario, sum, type State, type Ui } from './scenarios'

beforeAll(() => installHarnessGlobals())

const BUDGET_PER_MIN: Record<State, number> = { a0: 1, a: 1, b: 6, c: 12, c20: 12, p: 6, an: 6, docs: 1 }
/** One-time page-load burst ceilings (block + 2 fee reads + Chainlink/gas multicall, plus wallet reads). */
const MOUNT_CEILING: Record<State, number> = { a0: 4, a: 4, b: 4, c: 12, c20: 12, p: 12, an: 12, docs: 4 }

describe.each(['v1', 'v2'] as Ui[])('browser RPC budgets: %s', (ui) => {
  it.each(Object.keys(BUDGET_PER_MIN) as State[])('state %s: visible ≤ budget, hidden = 0, return refreshes once', async (state) => {
    const r = await runScenario({ ui, state, hide: true })
    const perMin = sum(r.steady)

    expect(perMin, `visible steady calls/min ${JSON.stringify(r.steady)}`).toBeLessThanOrEqual(BUDGET_PER_MIN[state])
    expect(sum(r.mount), `page-load burst ${JSON.stringify(r.mount)}`).toBeLessThanOrEqual(MOUNT_CEILING[state])
    // (d) a hidden tab pays nothing …
    expect(sum(r.hidden), `hidden 60 s ${JSON.stringify(r.hidden)}`).toBe(0)
    // … and coming back refreshes what is on screen — at least once, never more than a fresh page load would.
    expect(sum(r.returned), `return burst ${JSON.stringify(r.returned)}`).toBeGreaterThan(0)
    expect(sum(r.returned)).toBeLessThanOrEqual(sum(r.mount))
  }, 60_000)

  it('the only wallet-less poll is eth_blockNumber (the footer)', async () => {
    for (const state of ['a0', 'a', 'b', 'docs'] as State[]) {
      const r = await runScenario({ ui, state })
      expect(Object.keys(r.steady).filter((m) => m !== 'eth_blockNumber'), `${state}: ${JSON.stringify(r.steady)}`).toEqual([])
    }
  }, 60_000)
})

/**
 * [B9] "No RPC polling beyond v1" on the Analytics tab, measured both ways round: v2's visible steady rate and its mount burst are never above
 * v1's, nothing new polls while hidden (0 RPC — and the `an` row above holds that for both), and v2 makes the SAME HTTP requests as v1 in the
 * same windows (v1's own `useAnalytics` keeps its 30 s `/api/analytics` refresh; v2 reuses it unchanged and adds none).
 */
describe('Analytics tab (B9): v2 pays no more than v1', () => {
  it('RPC: steady, mount and hidden are ≤ v1 / 0; HTTP: the same paths, the same counts', async () => {
    const v1 = await runScenario({ ui: 'v1', state: 'an', hide: true })
    const v2 = await runScenario({ ui: 'v2', state: 'an', hide: true })
    if (process.env.RPC_AN_OUT) writeFileSync(process.env.RPC_AN_OUT, `${JSON.stringify({ v1, v2 })}\n`) // evidence for the feedback file
    expect(sum(v2.steady)).toBeLessThanOrEqual(sum(v1.steady))
    expect(sum(v2.mount)).toBeLessThanOrEqual(sum(v1.mount))
    expect(sum(v2.hidden)).toBe(0)
    expect(Object.keys(v2.steady).filter((m) => !(m in v1.steady))).toEqual([]) // no RPC method v1 does not call
    expect(v2.http.steady).toEqual(v1.http.steady)
    expect(v2.http.hidden).toEqual(v1.http.hidden)
    // the polled path is v1's: /api/analytics twice a minute (30 s), /api/stats and /personal are once-on-mount reads, not in the window
    expect(v1.http.steady['/api/analytics']).toBe(2)
    expect(v1.http.steady['/api/stats'] ?? 0).toBe(0)
    expect(v1.http.steady['/api/analytics/personal'] ?? 0).toBe(0)
  }, 120_000)
})
