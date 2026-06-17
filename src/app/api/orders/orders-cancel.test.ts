// @vitest-environment node
/**
 * [FULL-H-01] PATCH /api/orders/[id] — EIP-712 owner-only cancel auth, plus GET.
 *
 * This module had 0% coverage. We exercise the full PATCH validation/auth ladder
 * (wallet/signature/chainId shape → supabase configured → EIP-712 signer recovery
 * == declared wallet → atomic conditional UPDATE → 404/403/409 disambiguation) and
 * the GET read path (wallet-gated, configured, single() outcomes).
 *
 * Boundaries mocked deterministically:
 *   - @supabase/supabase-js createClient → a chainable query-builder spy whose
 *     terminal results we set per test (the UPDATE…select() promise, the probe
 *     .single(), and the GET .single()).
 *   - viem recoverTypedDataAddress → we control the recovered signer so we can
 *     drive the owner-only branch without real signatures.
 *
 * No wall-clock, no network. recoverTypedDataAddress's call args are asserted to
 * be the byte-identical per-chain EIP-712 domain + CANCEL_ORDER_TYPES + message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── viem boundary ────────────────────────────────────────
const mockRecover = vi.fn()
vi.mock('viem', () => ({
  recoverTypedDataAddress: (...args: unknown[]) => mockRecover(...args),
}))

// ── supabase boundary ────────────────────────────────────
// One chainable builder. Every chaining method returns `this`. Three terminals
// resolve configurable results:
//   - the UPDATE chain ends in .select('id') which is awaited directly (thenable)
//   - the probe / GET chains end in .single() (returns a promise)
// `selectResult` is the awaited result of the builder when used as the UPDATE's
// terminal .select(); `singleResult` is what .single() resolves to. We let each
// test set them. The builder also records the call chain for assertions.
type QueryResult = { data: unknown; error: unknown }

let selectResult: QueryResult // resolved when UPDATE chain is awaited (.select('id'))
let singleResult: QueryResult // resolved by .single() (probe + GET)
let updateMode = false // true once .update() seen → the terminal .select() is the awaited UPDATE result
const calls = {
  from: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
}

function makeBuilder() {
  const builder: Record<string, unknown> = {}
  // Each new query starts with .from(); reset the per-query mode so the probe /
  // GET selects (which run AFTER the UPDATE in the same request) chain normally.
  builder.from = (...a: unknown[]) => { calls.from(...a); updateMode = false; return builder }
  builder.update = (...a: unknown[]) => { calls.update(...a); updateMode = true; return builder }
  builder.eq = (...a: unknown[]) => { calls.eq(...a); return builder }
  builder.single = (...a: unknown[]) => { calls.single(...a); return Promise.resolve(singleResult) }
  builder.select = (...a: unknown[]) => {
    calls.select(...a)
    if (updateMode) {
      // Terminal of the UPDATE chain: the route awaits this directly.
      return Promise.resolve(selectResult)
    }
    // GET's .select('*') is followed by .eq().eq().single() — keep chaining.
    return builder
  }
  return builder
}

const mockCreateClient = vi.fn((..._args: unknown[]) => makeBuilder())
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}))

import { PATCH, GET } from './[id]/route'
import { CANCEL_ORDER_TYPES, getOrderExecutorDomain } from '@/lib/order-engine/config'

const ENV0 = { ...process.env }
const WALLET = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const SIG = '0x' + 'ab'.repeat(65)
const ORDER_ID = 'ord-uuid-1234'

beforeEach(() => {
  vi.clearAllMocks()
  updateMode = false
  selectResult = { data: [{ id: ORDER_ID }], error: null }
  singleResult = { data: null, error: null }
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  // Default: recovered signer == declared wallet (owner) for happy paths.
  mockRecover.mockResolvedValue(WALLET)
})
afterEach(() => { process.env = { ...ENV0 } })

function patchReq(body: unknown) {
  return new NextRequest('http://localhost/api/orders/' + ORDER_ID, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function getReq(wallet?: string) {
  const u = new URL('http://localhost/api/orders/' + ORDER_ID)
  if (wallet !== undefined) u.searchParams.set('wallet', wallet)
  return new NextRequest(u, { method: 'GET' })
}
const ctx = (id = ORDER_ID) => ({ params: Promise.resolve({ id }) })

function validPatchBody(overrides: Record<string, unknown> = {}) {
  return { wallet: WALLET, signature: SIG, chainId: 1, ...overrides }
}

describe('PATCH /api/orders/[id] — input validation', () => {
  it('rejects a missing wallet with 400 "Invalid wallet"', async () => {
    const res = await PATCH(patchReq(validPatchBody({ wallet: undefined })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid wallet')
    expect(mockRecover).not.toHaveBeenCalled()
  })

  it('rejects a malformed (non-40-hex) wallet with 400 "Invalid wallet"', async () => {
    const res = await PATCH(patchReq(validPatchBody({ wallet: '0xnothex' })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid wallet')
  })

  it('rejects a non-hex-string signature with 400 "Invalid signature"', async () => {
    const res = await PATCH(patchReq(validPatchBody({ signature: 'not-a-hex' })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid signature')
    expect(mockRecover).not.toHaveBeenCalled()
  })

  it('rejects a non-string (numeric) signature with 400 "Invalid signature"', async () => {
    const res = await PATCH(patchReq(validPatchBody({ signature: 12345 })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid signature')
  })

  it('rejects a non-integer chainId with 400 "Invalid chainId"', async () => {
    const res = await PATCH(patchReq(validPatchBody({ chainId: 1.5 })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid chainId')
  })

  it('rejects a string chainId with 400 "Invalid chainId"', async () => {
    const res = await PATCH(patchReq(validPatchBody({ chainId: '1' })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid chainId')
    expect(mockRecover).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/orders/[id] — supabase configuration', () => {
  it('returns 503 when supabase is not configured', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('Not configured')
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/orders/[id] — [FULL-H-01] owner-only EIP-712 auth', () => {
  it('rejects when the recovered signer != declared wallet (non-owner) with 400 "Signature verification failed"', async () => {
    mockRecover.mockResolvedValue(OTHER) // a valid signature, but NOT the wallet's owner
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Signature verification failed')
    // Crucially: never reached the UPDATE — no one else's order touched.
    expect(calls.update).not.toHaveBeenCalled()
  })

  it('accepts an owner signature that differs only in address casing (case-insensitive match)', async () => {
    mockRecover.mockResolvedValue(WALLET.toUpperCase().replace('0X', '0x'))
    selectResult = { data: [{ id: ORDER_ID }], error: null }
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('verifies against the byte-identical per-chain domain + CANCEL_ORDER_TYPES + {id, action:"cancel"} message', async () => {
    await PATCH(patchReq(validPatchBody({ chainId: 1 })), ctx(ORDER_ID))
    expect(mockRecover).toHaveBeenCalledTimes(1)
    const arg = mockRecover.mock.calls[0][0] as Record<string, unknown>
    expect(arg.domain).toEqual(getOrderExecutorDomain(1))
    // Sanity-pin the mainnet verifyingContract inside that domain.
    expect((arg.domain as { verifyingContract: string }).verifyingContract).toBe(
      '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    )
    expect(arg.types).toBe(CANCEL_ORDER_TYPES)
    expect(arg.primaryType).toBe('CancelOrder')
    expect(arg.message).toEqual({ id: ORDER_ID, action: 'cancel' })
    expect(arg.signature).toBe(SIG)
  })

  it('an UNWIRED chain (42161) → getOrderExecutorDomain throws → caught → 400 "Invalid cancel signature" (never verifies against a non-existent executor)', async () => {
    // chainId 42161 (Arbitrum) is not in ORDER_EXECUTOR_BY_CHAIN. The domain
    // factory throws synchronously inside the try, so recover is never reached.
    mockRecover.mockResolvedValue(WALLET) // would pass if it were ever called
    const res = await PATCH(patchReq(validPatchBody({ chainId: 42161 })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid cancel signature')
    expect(mockRecover).not.toHaveBeenCalled()
    expect(calls.update).not.toHaveBeenCalled()
  })

  it('a verification throw (recover rejects) → 400 "Invalid cancel signature"', async () => {
    mockRecover.mockRejectedValue(new Error('bad sig encoding'))
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid cancel signature')
  })
})

describe('PATCH /api/orders/[id] — atomic cancel outcomes', () => {
  it('happy path: owner verified + UPDATE returns a non-empty row → { ok: true }, wallet lowercased in WHERE', async () => {
    selectResult = { data: [{ id: ORDER_ID }], error: null }
    const mixed = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
    mockRecover.mockResolvedValue(mixed)
    const res = await PATCH(patchReq(validPatchBody({ wallet: mixed })), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // The atomic UPDATE gates on status='active' AND the lowercased wallet.
    expect(calls.update).toHaveBeenCalledWith({ status: 'cancelled' })
    const eqArgs = calls.eq.mock.calls.map((c) => c)
    expect(eqArgs).toContainEqual(['id', ORDER_ID])
    expect(eqArgs).toContainEqual(['wallet', mixed.toLowerCase()])
    expect(eqArgs).toContainEqual(['status', 'active'])
  })

  it('UPDATE error → 500 with the supabase error message', async () => {
    selectResult = { data: null, error: { message: 'db exploded' } }
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('db exploded')
  })

  it('UPDATE matched nothing + probe finds no order → 404 "Order not found"', async () => {
    selectResult = { data: [], error: null }
    singleResult = { data: null, error: null }
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Order not found')
  })

  it('UPDATE matched nothing + probe order belongs to a different wallet → 403 "Not authorized"', async () => {
    selectResult = { data: [], error: null }
    singleResult = { data: { wallet: OTHER.toLowerCase(), status: 'active' }, error: null }
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Not authorized')
  })

  it('UPDATE matched nothing + probe order is owned but already filled → 409 "Cannot cancel order in status"', async () => {
    selectResult = { data: [], error: null }
    singleResult = { data: { wallet: WALLET.toLowerCase(), status: 'filled' }, error: null }
    const res = await PATCH(patchReq(validPatchBody()), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Cannot cancel order in status: filled')
  })
})

describe('GET /api/orders/[id]', () => {
  it('rejects a missing wallet param with 400', async () => {
    const res = await GET(getReq(undefined), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Missing or invalid wallet parameter')
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('rejects a malformed wallet param with 400', async () => {
    const res = await GET(getReq('0xdeadbeef'), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Missing or invalid wallet parameter')
  })

  it('returns 503 when supabase is not configured', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await GET(getReq(WALLET), ctx())
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('Not configured')
  })

  it('returns 404 when .single() reports an error', async () => {
    singleResult = { data: null, error: { message: 'no rows' } }
    const res = await GET(getReq(WALLET), ctx())
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Order not found')
  })

  it('returns 404 when .single() yields no data', async () => {
    singleResult = { data: null, error: null }
    const res = await GET(getReq(WALLET), ctx())
    expect(res.status).toBe(404)
  })

  it('returns 200 { order } when the row is found, gating on the lowercased wallet', async () => {
    const row = { id: ORDER_ID, wallet: WALLET.toLowerCase(), status: 'active' }
    singleResult = { data: row, error: null }
    const res = await GET(getReq(WALLET.toUpperCase().replace('0X', '0x')), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ order: row })
    // The read is scoped to id + the caller's lowercased wallet (no data leakage).
    const eqArgs = calls.eq.mock.calls.map((c) => c)
    expect(eqArgs).toContainEqual(['id', ORDER_ID])
    expect(eqArgs).toContainEqual(['wallet', WALLET.toLowerCase()])
  })
})
