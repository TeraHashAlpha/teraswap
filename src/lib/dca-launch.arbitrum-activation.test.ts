// @vitest-environment node
/**
 * [SPRINT-47-ARBITRUM-ACTIVATION-PREP, updated SPRINT-48-ARBITRUM-DCA-PREP, repaired
 * INC-2026-08-26-001] End-to-end order-engine isolation under the REAL activated state.
 *
 * dca-launch.test.ts already pins isDcaLive's DCA_CHAINS-allowlist logic with every dependency
 * mocked (isChainActive, getOrderExecutorV3). That proves the gate's OWN logic is correct, but
 * not that the ACTUAL wiring stays isolated once Arbitrum genuinely activates. This file uses
 * the REAL chains/registry, chains/activation, and order-engine modules (no mocks) with the
 * Arbitrum env vars really set via vi.stubEnv, and confirms:
 *   1. isChainActive(42161) really does flip to true once NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR is set
 *      (activation plumbing works end-to-end), and
 *   2. isDcaLive(42161) STILL returns false — with the v3 env var UNSET (block 1) AND, since
 *      INC-2026-08-26-001, with ALL THREE vars SET (block 2): v3 chain eligibility is a code
 *      decision (ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS, src/lib/order-engine/config.ts), so a populated
 *      NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM no longer makes getOrderExecutorV3(42161)
 *      non-null. Block 2 previously asserted the opposite and specified the defect.
 *
 * Modules read env vars at call time / module-load time, so each case re-imports fresh.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('order-engine isolation on Arbitrum — REAL activated state (not mocked)', () => {
  it('activating Arbitrum (real env, real registry) does NOT make DCA live there', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')

    const { isChainActive } = await import('@/lib/chains')
    const { isDcaLive, BASE_CHAIN_ID } = await import('./dca-launch')

    // Sanity: the activation plumbing genuinely flipped — this is a REAL, non-mocked read.
    expect(isChainActive(42161)).toBe(true)
    // ...but DCA on Arbitrum is still fail-closed: 42161 IS in DCA_CHAINS now, yet no real
    // OrderExecutorV3 is wired there (NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM unset in
    // this test env) — the v3-wired term alone keeps it dark until a real deploy + env flip.
    expect(isDcaLive(42161)).toBe(false)
    expect(BASE_CHAIN_ID).toBe(8453)
  })

  it('activating Arbitrum does not disturb the real Base DCA gate (still needs its own flag)', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')
    // NEXT_PUBLIC_DCA_ENABLED deliberately left unset.

    const { isDcaLive } = await import('./dca-launch')
    expect(isDcaLive(8453)).toBe(false) // launch flag still off — Arbitrum activation is unrelated
  })

  it('the real order-engine has no v2 OrderExecutor wired for 42161, activated or not', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')

    const { getOrderExecutor, ORDER_EXECUTOR_BY_CHAIN } = await import('@/lib/order-engine')
    expect(getOrderExecutor(42161)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(ORDER_EXECUTOR_BY_CHAIN, 42161)).toBe(false)
  })

  // [SPRINT-48-ARBITRUM-DCA-PREP] The v3 slot DOES exist as a key now (unlike v2 above) but
  // still resolves null with no env override — the dark-state regression this sprint exists
  // to prove, exercised here against the REAL (unmocked) config module.
  it('the real order-engine HAS a 42161 v3 slot but it resolves null with no env override (dark)', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')

    const { getOrderExecutorV3 } = await import('@/lib/order-engine')
    // [FIX-CLOSE-COMMENT-ENFORCED-BOUNDARIES / #424 L-1] The raw map is not re-exported from the
    // public barrel — read from '@/lib/order-engine/config' directly for this sanity check.
    const { ORDER_EXECUTOR_V3_BY_CHAIN } = await import('@/lib/order-engine/config')
    expect(getOrderExecutorV3(42161)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(ORDER_EXECUTOR_V3_BY_CHAIN, 42161)).toBe(true)
  })

  it('mainnet + Base swap activation are unaffected by the Arbitrum env flip (real registry)', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')

    const { isChainActive } = await import('@/lib/chains')
    expect(isChainActive(1)).toBe(true) // mainnet always active
    expect(isChainActive(8453)).toBe(false) // Base's own env var still unset
  })
})

// [INC-2026-08-26-001] The block above proves the unset state end-to-end (real modules, no mocks).
// This block pins the state that was ACTUALLY in Production from 2026-08-04 to 2026-08-26 —
// NEXT_PUBLIC_DCA_ENABLED, NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR and
// NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM all SET — and proves it does NOT make DCA live on
// Arbitrum: v3 chain eligibility is decided in code (ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS), not by env.
// The previous version of this block asserted the opposite ("ALL FOUR real conditions satisfied ⇒
// isDcaLive(42161) is true") — it specified the defect, and it was green for the whole incident.
//
// Real modules throughout (never mocking isChainActive/getOrderExecutorV3 themselves — a mock is a
// bet the consumer keeps calling it the same way; stubbing the env underneath the real modules
// verifies the whole chain including that plumbing, not just isDcaLive's own boolean algebra).
// The positive control and the per-term falsifications now run on Base, the one eligible chain —
// on Arbitrum the v3 term is false by code, so no other term can be isolated there any more.
describe('dca-launch — env alone cannot light a chain: the 2026-08-04 → 08-26 Production shape (real modules, env-driven)', () => {
  // Synthetic, syntactically valid 20-byte test addresses (this repo's existing test constants).
  const FEE_COLLECTOR_STUB = '0x000000000000000000000000000000000000dEaD'
  const ARBITRUM_V3_STUB = '0x5555555555555555555555555555555555555555'
  const BASE_V3_STUB = '0x4444444444444444444444444444444444444444'
  const MAINNET_V3_STUB = '0x3333333333333333333333333333333333333333'

  const BASE_ALL_SET: Record<string, string> = {
    NEXT_PUBLIC_DCA_ENABLED: 'true',
    NEXT_PUBLIC_BASE_FEE_COLLECTOR: FEE_COLLECTOR_STUB,
    NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE: BASE_V3_STUB,
  }

  it('all three Arbitrum vars SET ⇒ the env reaches the real modules (chain active, raw v3 slot populated, 42161 in DCA_CHAINS) yet getOrderExecutorV3(42161) is null and isDcaLive(42161) is false', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', FEE_COLLECTOR_STUB)
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', ARBITRUM_V3_STUB)

    const { isChainActive } = await import('@/lib/chains')
    const { getOrderExecutorV3, ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS } =
      await import('@/lib/order-engine')
    // [FIX-CLOSE-COMMENT-ENFORCED-BOUNDARIES / #424 L-1] The raw map is not re-exported from the
    // public barrel — read from '@/lib/order-engine/config' directly for this sanity check.
    const { ORDER_EXECUTOR_V3_BY_CHAIN } = await import('@/lib/order-engine/config')
    const { isDcaLive, isDcaLaunchEnabled, DCA_CHAINS } = await import('./dca-launch')

    // Sanity: the three env-driven terms genuinely reached the real modules — this is the exact
    // Production state of the incident, not a strawman.
    expect(isDcaLaunchEnabled()).toBe(true)
    expect(isChainActive(42161)).toBe(true)
    expect(DCA_CHAINS.includes(42161)).toBe(true)
    expect(ORDER_EXECUTOR_V3_BY_CHAIN[42161]).toBe(ARBITRUM_V3_STUB)
    // ...and the gate still says no. Against a config.ts where env alone can enable a chain, THIS
    // is the assertion that fails (`expected '0x5555…' to be null`) — the incident, as a test.
    expect(getOrderExecutorV3(42161)).toBeNull()
    expect(isDcaLive(42161)).toBe(false)
    // The code-level decision is what keeps it dark.
    expect(ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.includes(42161)).toBe(false)
  })

  it('positive control — the gate CAN open, on the eligible chain: all three Base vars SET ⇒ isDcaLive(8453) is true', async () => {
    vi.resetModules()
    for (const [key, value] of Object.entries(BASE_ALL_SET)) vi.stubEnv(key, value)

    const { isChainActive } = await import('@/lib/chains')
    const { getOrderExecutorV3, ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS } = await import('@/lib/order-engine')
    const { isDcaLive } = await import('./dca-launch')

    expect(isChainActive(8453)).toBe(true)
    expect(getOrderExecutorV3(8453)).toBe(BASE_V3_STUB)
    expect(isDcaLive(8453)).toBe(true)
    expect(ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.includes(8453)).toBe(true)
  })

  it.each([
    ['NEXT_PUBLIC_DCA_ENABLED', 'launch flag'],
    ['NEXT_PUBLIC_BASE_FEE_COLLECTOR', 'FeeCollector / isChainActive'],
    ['NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', 'v3 executor slot'],
  ])('env keeps the power to DISABLE — Base with only %s unset (%s falsified) ⇒ isDcaLive(8453) is false', async (missing) => {
    vi.resetModules()
    for (const [key, value] of Object.entries(BASE_ALL_SET)) vi.stubEnv(key, key === missing ? undefined : value)

    const { isDcaLive } = await import('./dca-launch')
    expect(isDcaLive(8453)).toBe(false)
  })

  it('mainnet: its own v3 var SET ⇒ blocked at BOTH layers — not eligible in config (getOrderExecutorV3(1) null) AND absent from DCA_CHAINS', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_DCA_ENABLED', 'true')
    // Mainnet's own real v3 slot (not an Arbitrum var). Before INC-2026-08-26-001 only DCA_CHAINS
    // stood between this state and a live mainnet DCA gate; now the config allowlist does too.
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS', MAINNET_V3_STUB)

    const { isChainActive } = await import('@/lib/chains')
    const { getOrderExecutorV3 } = await import('@/lib/order-engine')
    // [FIX-CLOSE-COMMENT-ENFORCED-BOUNDARIES / #424 L-1] The raw map is not re-exported from the
    // public barrel — read from '@/lib/order-engine/config' directly for this sanity check.
    const { ORDER_EXECUTOR_V3_BY_CHAIN } = await import('@/lib/order-engine/config')
    const { isDcaLive, DCA_CHAINS } = await import('./dca-launch')

    expect(isChainActive(1)).toBe(true)
    expect(ORDER_EXECUTOR_V3_BY_CHAIN[1]).toBe(MAINNET_V3_STUB) // env reached the raw slot
    expect(getOrderExecutorV3(1)).toBeNull()                    // layer 1: config eligibility
    expect(DCA_CHAINS.includes(1)).toBe(false)                  // layer 2: DCA allowlist
    expect(isDcaLive(1)).toBe(false)
  })
})
