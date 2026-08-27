// @vitest-environment node
/**
 * [FIX-CLOSE-COMMENT-ENFORCED-BOUNDARIES / #424 L-2] POST /api/orders — the REAL composition of
 * getOrderExecutorV3 and the route's fail-closed 400, with NOTHING mocked in
 * '@/lib/order-engine/config'.
 *
 * Every other v3 test in this directory (orders-v3.test.ts, orders-create.validation.test.ts)
 * mocks getOrderExecutorV3 directly, which proves the ROUTE calls the getter and 400s on null —
 * it never proves the getter itself, wired to the real ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS
 * allowlist, actually returns null for a non-eligible chain with its env slot populated. That
 * composition is exactly what INC-2026-08-26-001 got wrong: one Vercel env var made
 * ORDER_EXECUTOR_V3_BY_CHAIN[42161] non-null, and nothing composed that with the eligibility
 * decision until a human looked.
 *
 * This file sets the REAL Arbitrum v3 env var, imports the REAL config module (not a vi.mock'd
 * one) and the REAL route.ts, and posts a v3-shaped order for chain 42161. Both halves are
 * verified independently before the composition is trusted:
 *   1. the raw env slot reached the module (ORDER_EXECUTOR_V3_BY_CHAIN[42161] is non-null) —
 *      imported from '@/lib/order-engine/config' directly, never from the public barrel (L-1);
 *   2. getOrderExecutorV3(42161) is still null because 42161 is not on
 *      ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS;
 * only then is the route's 400 asserted. If either sanity check ever fails, the 400 assertion
 * would be passing for the wrong reason (or vacuously), and this file is deliberately built so a
 * regression in the ALLOWLIST — not just the route — makes it fail. See "Prove the test bites"
 * below, and the FEEDBACK for this branch for the demonstration transcript.
 *
 * Module-load-time env reads (config.ts reads process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_*
 * at the top level, exactly like dca-launch.arbitrum-activation.test.ts and
 * page.arbitrum-dark.test.tsx), so every case stubs env and resets the module registry BEFORE
 * dynamically importing route.ts and order-engine/config. vi.mock registrations below (supabase,
 * kv-rate-limiter) survive vi.resetModules() and are NOT order-engine/config, so the allowlist
 * logic under test is never touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: vi.fn(async () => ({ data: true })),
    from: vi.fn(() => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'order-uuid-1' }, error: null }) }) }),
    })),
  }),
}))

vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return {
    ...actual,
    checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })),
  }
})

const WALLET = '0x1111111111111111111111111111111111111111'
const TOKEN_IN = '0x2222222222222222222222222222222222222222'
const TOKEN_OUT = '0x3333333333333333333333333333333333333333'
const ROUTER = '0x4444444444444444444444444444444444444444'
const SIG = '0x' + 'cc'.repeat(65)
const ZERO_HASH = '0x' + '00'.repeat(32)
const ARBITRUM_V3_STUB = '0x5555555555555555555555555555555555555555'

const NOW_MS = Date.UTC(2026, 6, 9, 0, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)

function v3BodyForChain(chainId: number) {
  return {
    wallet: WALLET,
    chainId,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    router: ROUTER,
    signature: SIG,
    orderHash: '0x' + 'ab'.repeat(32),
    amountIn: '1000000000000000000',
    minAmountOut: (100n * 10n ** 18n).toString(),
    tokenOutDecimals: 18,
    orderType: 'dca',
    priceCondition: 'above',
    targetPrice: '0',
    priceFeed: '0x0000000000000000000000000000000000000000',
    expiry: NOW_S + 3600,
    nonce: 0,
    routerDataHash: ZERO_HASH,
    dcaInterval: 3600,
    dcaTotal: 3,
    maxSlippageBps: 300,
  }
}

function req(body: unknown) {
  return new NextRequest('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const ENV0 = { ...process.env }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetModules()
  process.env = { ...ENV0 }
})

describe('POST /api/orders — real getOrderExecutorV3 composition (#424 L-2, nothing mocked in order-engine/config)', () => {
  it('the Arbitrum v3 env var SET + 42161 not on the eligibility allowlist ⇒ the REAL route composes to 400', async () => {
    // The exact INC-2026-08-26-001 shape: the env slot for a non-eligible chain is populated.
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', ARBITRUM_V3_STUB)
    vi.resetModules()

    // ── Sanity, BEFORE trusting the 400: the env genuinely reached the REAL modules ──
    // 1. The raw slot is populated — imported from the internal module, never the public barrel
    //    (order-engine/index.ts deliberately does not re-export this map — L-1 of this branch).
    const { ORDER_EXECUTOR_V3_BY_CHAIN, ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS, getOrderExecutorV3 } =
      await import('@/lib/order-engine/config')
    expect(ORDER_EXECUTOR_V3_BY_CHAIN[42161]).toBe(ARBITRUM_V3_STUB)
    // 2. 42161 is not on the eligibility allowlist today (the code-level decision this test must
    //    never widen — the Do NOT list forbids touching ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS itself).
    expect(ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.includes(42161)).toBe(false)
    // 3. Therefore the REAL getter — the same one the route imports — is null for 42161, with the
    //    populated slot proving this isn't null for lack of an address.
    expect(getOrderExecutorV3(42161)).toBeNull()

    // ── Now the composition under test: the route, dynamically imported AFTER the env stub and
    //    module reset, so it resolves the SAME real config module instance just verified above. ──
    const { POST } = await import('./route')
    const res = await POST(req(v3BodyForChain(42161)))
    const json = (await res.json()) as { error?: string }

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/not yet available on chain 42161/)
  })

  it('positive control — the same real composition on Base (8453, the eligible chain) does NOT fail closed here', async () => {
    // Without this, the 400 above could pass because the route always 400s regardless of chain.
    // Base needs no env stub: its own env slot in orders-create tests is unset by default, but the
    // config module still resolves it via NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE.
    const BASE_V3_STUB = '0x6666666666666666666666666666666666666666'
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', BASE_V3_STUB)
    vi.resetModules()

    const { ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS, getOrderExecutorV3 } =
      await import('@/lib/order-engine/config')
    expect(ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.includes(8453)).toBe(true)
    expect(getOrderExecutorV3(8453)).toBe(BASE_V3_STUB)

    const { POST } = await import('./route')
    const res = await POST(req(v3BodyForChain(8453)))

    // Not a 400-for-chain-eligibility rejection — it may still fail later in the pipeline (a real
    // EIP-712 signature is never actually produced by this fixture's SIG constant), but it must
    // not be THIS 400, proving the chain-eligibility branch is not what blocked it.
    if (res.status === 400) {
      const json = (await res.json()) as { error?: string }
      expect(json.error).not.toMatch(/not yet available on chain/)
    }
  })
})
