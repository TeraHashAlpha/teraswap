// @vitest-environment node
/**
 * [SPRINT-47-ARBITRUM-ACTIVATION-PREP] End-to-end order-engine isolation under the REAL
 * activated state.
 *
 * dca-launch.test.ts already pins isDcaLive's BASE_CHAIN_ID-pin logic with every dependency
 * mocked (isChainActive, getOrderExecutor). That proves the gate's OWN logic is correct, but not
 * that the ACTUAL wiring stays isolated once Arbitrum genuinely activates. This file uses the
 * REAL chains/registry, chains/activation, and order-engine modules (no mocks) with
 * NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR really set via vi.stubEnv — the exact env flip the owner
 * will perform per docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md — and confirms:
 *   1. isChainActive(42161) really does flip to true (activation plumbing works end-to-end), and
 *   2. isDcaLive(42161) STILL returns false regardless (order-engine/DCA on 42161 stays
 *      fail-closed — no OrderExecutor is wired, and the BASE_CHAIN_ID pin blocks it either way).
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
    // ...but DCA on Arbitrum is still fail-closed: no OrderExecutor is wired there, and the
    // BASE_CHAIN_ID pin blocks any chain that isn't Base regardless of activation state.
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

  it('the real order-engine has no OrderExecutor wired for 42161, activated or not', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')

    const { getOrderExecutor, ORDER_EXECUTOR_BY_CHAIN } = await import('@/lib/order-engine')
    expect(getOrderExecutor(42161)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(ORDER_EXECUTOR_BY_CHAIN, 42161)).toBe(false)
  })

  it('mainnet + Base swap activation are unaffected by the Arbitrum env flip (real registry)', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR', '0x000000000000000000000000000000000000dEaD')

    const { isChainActive } = await import('@/lib/chains')
    expect(isChainActive(1)).toBe(true) // mainnet always active
    expect(isChainActive(8453)).toBe(false) // Base's own env var still unset
  })
})
