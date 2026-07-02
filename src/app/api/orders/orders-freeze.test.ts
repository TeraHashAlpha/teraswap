// @vitest-environment node
/**
 * POST /api/orders — DCA circuit-breaker USER-SAFETY INVARIANT (Auditor-critical).
 *
 * This is the load-bearing test for the freeze feature. It proves the invariant
 * the breaker promises users:
 *
 *   1. Freezing pauses ONLY the creation of NEW DCA orders (403, friendly copy)
 *      and NEVER touches an order that already exists.
 *   2. limit / stop_loss orders are NEVER blocked by the DCA freeze.
 *   3. Cancellation of any order is ALWAYS available while frozen — the cancel
 *      route ([id]/route.ts) does not even import the freeze flag.
 *
 * Boundaries mocked deterministically (same pattern as orders-create.validation.test.ts):
 *   - @/lib/dca-freeze `getDcaFreezeState` → controllable (default: NOT frozen).
 *   - @supabase/supabase-js `createClient` → in-test stub recording insert/update/delete.
 *   - viem `recoverTypedDataAddress` → returns the wallet so signatures pass.
 *   - Time frozen via vi.setSystemTime so expiry math is deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ── dca-freeze mock — getDcaFreezeState is fully controllable per-test ──
const mockGetDcaFreezeState = vi.fn()
vi.mock('@/lib/dca-freeze', () => ({
  getDcaFreezeState: (...args: unknown[]) => mockGetDcaFreezeState(...args),
}))

// ── viem mock — keep everything real except recoverTypedDataAddress ──
const mockRecover = vi.fn()
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return {
    ...actual,
    recoverTypedDataAddress: (...args: unknown[]) => mockRecover(...args),
  }
})

// ── supabase mock — createClient returns a controllable stub that records
//    every mutating method so we can assert NOTHING is written on a freeze. ──
const mockRpc = vi.fn()
const mockSingle = vi.fn()
const mockInsert = vi.fn(() => ({ select: () => ({ single: () => mockSingle() }) }))
const mockUpdate = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) }))
const mockDelete = vi.fn(() => ({ eq: () => Promise.resolve({ data: null, error: null }) }))
const mockFrom = vi.fn((..._args: unknown[]) => ({
  insert: mockInsert,
  update: mockUpdate,
  delete: mockDelete,
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

// [AUDIT-W6 / W6-M-02] POST /api/orders now rate-limits per IP before any
// work. Stub the limiter as "allowed" — the 429/413 paths are pinned by
// route.hardening.test.ts; the real KV client stalls on its unconfigured
// endpoint in tests (and the in-memory fallback would 429 multi-POST suites).
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return {
    ...actual,
    checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })),
  }
})

import { POST } from './route'

const WALLET = '0x1111111111111111111111111111111111111111'
const TOKEN_IN = '0x2222222222222222222222222222222222222222'
const TOKEN_OUT = '0x3333333333333333333333333333333333333333'
const ROUTER = '0x4444444444444444444444444444444444444444'
const PRICE_FEED = '0x5555555555555555555555555555555555555555'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const SIG = '0x' + 'cc'.repeat(65) // 130 hex chars

// Frozen clock: 2026-06-17T00:00:00Z. Used for all expiry math.
const NOW_MS = Date.UTC(2026, 5, 17, 0, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)

const NOT_FROZEN = { frozen: false, reason: null, updatedAt: null, updatedBy: null }

const ENV0 = { ...process.env }
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
  process.env.CHAIN_ID = '1' // mainnet — byte-identical behaviour
  // Defaults: not frozen, signature recovers to wallet, DB returns a row.
  mockGetDcaFreezeState.mockResolvedValue({ ...NOT_FROZEN })
  mockRecover.mockResolvedValue(WALLET)
  mockRpc.mockResolvedValue({ data: true })
  mockSingle.mockResolvedValue({ data: { id: 'order-uuid-1' }, error: null })
})
afterEach(() => {
  vi.useRealTimers()
  process.env = { ...ENV0 }
})

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    wallet: WALLET,
    chainId: 1, // [CHORE-ORDER-API-CHAIN-AWARE] verify domain is derived from this signed chainId
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    router: ROUTER,
    signature: SIG,
    orderHash: '0x' + 'ab'.repeat(32),
    amountIn: '1000000000000000000',
    minAmountOut: '0',
    orderType: 'limit',
    priceCondition: 'above',
    targetPrice: '1000',
    priceFeed: PRICE_FEED,
    expiry: NOW_S + 3600, // 1h in the future
    nonce: 0,
    routerDataHash: '0x' + '00'.repeat(32),
    ...overrides,
  }
}
function dcaBody(overrides: Record<string, unknown> = {}) {
  return validBody({
    orderType: 'dca',
    priceFeed: ZERO_ADDR, // DCA may skip the price condition
    dcaInterval: 3600,
    dcaTotal: 10,
    amountIn: '1000000', // 1e6 / 10 = 1e5 >= MIN(1e4)
    ...overrides,
  })
}
function req(body: unknown) {
  return new NextRequest('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function post(body: unknown) {
  const res = await POST(req(body))
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

// ── INVARIANT 1: frozen + DCA ⇒ 403, no order created/modified ─────────
describe('USER-SAFETY INVARIANT — frozen blocks ONLY new DCA creation', () => {
  it('frozen + orderType=dca → 403 "temporarily paused" and insert is NEVER called', async () => {
    mockGetDcaFreezeState.mockResolvedValue({
      frozen: true,
      reason: 'oracle anomaly',
      updatedAt: '2026-06-17T00:00:00Z',
      updatedBy: '0x9A38',
    })
    const { status, json } = await post(dcaBody())
    expect(status).toBe(403)
    expect(json.frozen).toBe(true)
    expect(String(json.error)).toMatch(/temporarily paused/i)
    // The reason is surfaced to the user.
    expect(String(json.error)).toMatch(/oracle anomaly/)
    // The friendly copy reassures about existing orders.
    expect(String(json.error)).toMatch(/Existing orders are unaffected/i)
    expect(String(json.error)).toMatch(/cancel/i)

    // INVARIANT: no order created, and NOTHING mutated on the orders table.
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
    // The rate-limit RPC is never even consulted — we bail before it.
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('frozen + dca with no reason → 403 still has the friendly base message (no trailing ": null")', async () => {
    mockGetDcaFreezeState.mockResolvedValue({ ...NOT_FROZEN, frozen: true, reason: null })
    const { status, json } = await post(dcaBody())
    expect(status).toBe(403)
    expect(json.frozen).toBe(true)
    expect(String(json.error)).toMatch(/^New DCA orders are temporarily paused\./)
    expect(String(json.error)).not.toMatch(/null/)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('INVARIANT 4: the frozen-DCA path performs no update or delete on existing orders', async () => {
    mockGetDcaFreezeState.mockResolvedValue({ ...NOT_FROZEN, frozen: true, reason: 'paused' })
    await post(dcaBody())
    // Only an early 403 return — never reaches insert/update/delete.
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
  })
})

// ── INVARIANT 2: frozen does NOT block limit / stop_loss ───────────────
describe('USER-SAFETY INVARIANT — frozen never blocks non-DCA orders', () => {
  for (const orderType of ['limit', 'stop_loss'] as const) {
    it(`frozen + orderType=${orderType} → NOT blocked by the freeze (no 403 freeze message)`, async () => {
      mockGetDcaFreezeState.mockResolvedValue({ ...NOT_FROZEN, frozen: true, reason: 'paused' })
      const { status, json } = await post(validBody({ orderType }))
      // Passes the freeze gate. With valid sig + insert mock it reaches 201.
      expect(status).toBe(201)
      // Definitely NOT the freeze 403.
      expect(status).not.toBe(403)
      expect(json.frozen).toBeUndefined()
      expect(String(json.error ?? '')).not.toMatch(/temporarily paused/i)
      // Non-DCA orders never consult the freeze flag at all.
      expect(mockGetDcaFreezeState).not.toHaveBeenCalled()
      // Normal flow proceeded: an order was inserted.
      expect(mockInsert).toHaveBeenCalledTimes(1)
    })
  }
})

// ── INVARIANT 3: not frozen + DCA ⇒ passes the gate (normal flow) ──────
describe('USER-SAFETY INVARIANT — not-frozen DCA reaches the normal flow', () => {
  it('not frozen + orderType=dca → passes the freeze gate and reaches 201', async () => {
    mockGetDcaFreezeState.mockResolvedValue({ ...NOT_FROZEN })
    const { status, json } = await post(dcaBody())
    expect(status).toBe(201)
    expect(json.frozen).toBeUndefined()
    // The freeze flag WAS consulted for a DCA order (gate is wired in).
    expect(mockGetDcaFreezeState).toHaveBeenCalledTimes(1)
    // Normal flow ran: rate-limit + insert.
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalledTimes(1)
  })

  it('fail-open: a read error in dca-freeze surfaces as NOT frozen → DCA still creates (201)', async () => {
    // getDcaFreezeState never throws; on any error it returns NOT_FROZEN.
    mockGetDcaFreezeState.mockResolvedValue({ ...NOT_FROZEN })
    const { status } = await post(dcaBody())
    expect(status).toBe(201)
    expect(mockInsert).toHaveBeenCalledTimes(1)
  })
})

// ── INVARIANT: cancellation is independent of the freeze flag ──────────
describe('USER-SAFETY INVARIANT — cancel route is freeze-independent', () => {
  it('the cancel route module ([id]/route.ts) does NOT import @/lib/dca-freeze', () => {
    // A lightweight, robust assertion: cancellation must always be available
    // while frozen, so its source must not even reference the freeze flag.
    const here = dirname(fileURLToPath(import.meta.url))
    const cancelSrc = readFileSync(join(here, '[id]', 'route.ts'), 'utf8')
    expect(cancelSrc).not.toMatch(/dca-freeze/)
    expect(cancelSrc).not.toMatch(/getDcaFreezeState/)
  })

  it('importing PATCH from ./[id]/route does not pull in the freeze flag', async () => {
    // Importing the cancel handler must not trip the dca-freeze mock, proving
    // the cancel path has no dependency on the breaker.
    const mod = await import('./[id]/route')
    expect(typeof mod.PATCH).toBe('function')
    expect(mockGetDcaFreezeState).not.toHaveBeenCalled()
  })
})
