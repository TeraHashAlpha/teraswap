// @vitest-environment node
/**
 * [SPRINT-47-ARBITRUM-ACTIVATION-PREP, updated SPRINT-48-ARBITRUM-DCA-PREP] End-to-end
 * order-engine isolation under the REAL activated state.
 *
 * dca-launch.test.ts already pins isDcaLive's DCA_CHAINS-allowlist logic with every dependency
 * mocked (isChainActive, getOrderExecutorV3). That proves the gate's OWN logic is correct, but
 * not that the ACTUAL wiring stays isolated once Arbitrum genuinely activates. This file uses
 * the REAL chains/registry, chains/activation, and order-engine modules (no mocks) with
 * NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR really set via vi.stubEnv — the exact env flip the owner
 * will perform per docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md — and confirms:
 *   1. isChainActive(42161) really does flip to true (activation plumbing works end-to-end), and
 *   2. isDcaLive(42161) STILL returns false regardless (SPRINT-48-ARBITRUM-DCA-PREP put 42161 IN
 *      the DCA_CHAINS allowlist, but shipped it DARK — no OrderExecutorV3 is wired there yet, so
 *      the v3-wired AND term alone keeps it fail-closed until a real deploy + env flip).
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

    const { getOrderExecutorV3, ORDER_EXECUTOR_V3_BY_CHAIN } = await import('@/lib/order-engine')
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
