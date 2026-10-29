// @vitest-environment jsdom
/**
 * [feat/frontend-rpc-diet] Per-tab browser-RPC budgets. Each case fails if a future change makes a tab pay more
 * JSON-RPC requests than the budget below — the point of the diet is that this number stays down.
 *
 * Budgets (calls per minute, steady state of a visible tab, v1 AND v2):
 *   a0 landing, a swap idle                ≤ 1   (owner: the live footer block is the only on-chain figure; relaxed from 0)
 *   b  visitor, pair + amount (quoting)    ≤ 6
 *   c  wallet, pair + amount (ETH→USDC)    ≤ 12   c20 the same with an ERC-20 sell (USDC→ETH)
 *   d  hidden tab                          = 0, and returning to visible refreshes each source once (0 < n ≤ mount burst)
 * The page-load burst is reported by the harness table, not budgeted per minute; it is capped here so it cannot grow unnoticed.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/rpc-guarded-transport', async () => (await import('@/test-utils/rpc-harness')).mockGuardedTransportModule())
vi.mock('@/components/BackgroundMusic', () => ({ default: () => null }))
vi.mock('@/components/UsageTracker', () => ({ default: () => null }))
vi.mock('@/lib/sounds', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/sounds')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]))
})
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null, setParticleTurbo: vi.fn() }))

import { installHarnessGlobals, runScenario, sum, type State, type Ui } from './scenarios'

beforeAll(() => installHarnessGlobals())

const BUDGET_PER_MIN: Record<State, number> = { a0: 1, a: 1, b: 6, c: 12, c20: 12 }
/** One-time page-load burst ceilings (block + 2 fee reads + Chainlink/gas multicall, plus wallet reads). */
const MOUNT_CEILING: Record<State, number> = { a0: 4, a: 4, b: 4, c: 12, c20: 12 }

describe.each(['v1', 'v2'] as Ui[])('browser RPC budgets — %s', (ui) => {
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
    for (const state of ['a0', 'a', 'b'] as State[]) {
      const r = await runScenario({ ui, state })
      expect(Object.keys(r.steady).filter((m) => m !== 'eth_blockNumber'), `${state}: ${JSON.stringify(r.steady)}`).toEqual([])
    }
  }, 60_000)
})
