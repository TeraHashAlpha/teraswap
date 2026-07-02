/**
 * [AUDIT-W6] /api/orders hardening — W6-M-01 read gate + W6-M-02 rate limit +
 * W6-L-01 body cap.
 *
 * - GET  /api/orders: reads that include ACTIVE/PENDING order strategy require
 *   proof-of-wallet-ownership (per-session signature, see read-auth.ts);
 *   terminal-status-only reads stay public (owner-decided boundary).
 * - GET  /api/orders/[id]: a row in a protected (live) status requires the same
 *   proof; terminal rows stay public.
 * - POST /api/orders: per-IP rate limit BEFORE body parse/signature work → 429;
 *   oversized body → 413.
 *
 * Signatures are real (viem local accounts) — only Supabase, the KV rate
 * limiter, and the DCA freeze flag are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import { buildOrdersReadTypedData, ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE } from '@/lib/order-engine/read-auth'

// ── Supabase mock — a permissive chainable/thenable builder ─────────────────
let listRows: Array<Record<string, unknown>> = []
let singleRow: Record<string, unknown> | null = null
const statusFilters: Array<unknown> = []

function makeBuilder() {
  const builder: Record<string, unknown> = {}
  const chain = (name: string) =>
    ((...args: unknown[]) => {
      if (name === 'eq' && args[0] === 'status') statusFilters.push(args[1])
      if (name === 'in' && args[0] === 'status') statusFilters.push(args[1])
      return builder
    })
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'insert']) builder[m] = chain(m)
  builder.single = async () =>
    singleRow ? { data: singleRow, error: null } : { data: null, error: { message: 'not found' } }
  // Awaiting the builder resolves the list query.
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: listRows, error: null })
  return builder
}

const rpcMock = vi.fn(async (..._args: unknown[]) => ({ data: true }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => makeBuilder(),
    rpc: (...args: unknown[]) => rpcMock(...args),
  }),
}))

// ── KV rate limiter mock (constants kept real) ──────────────────────────────
const mockCheckRateLimit = vi.fn(async (..._args: unknown[]) => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 }))
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return { ...actual, checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args) }
})

vi.mock('@/lib/dca-freeze', () => ({
  getDcaFreezeState: vi.fn(async () => ({ frozen: false })),
}))

import { GET, POST } from './route'
import { GET as GET_BY_ID } from './[id]/route'

// ── Fixtures ────────────────────────────────────────────────────────────────
// Published Anvil/Hardhat default account #0 key — a throwaway local-dev
// fixture, value-allowlisted in .gitleaks.toml (NOT a secret).
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const account = privateKeyToAccount(PK)
const WALLET = account.address
const otherAccount = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111')

async function readAuthHeaders(wallet: string = WALLET, signer = account, issuedAt = Math.floor(Date.now() / 1000)) {
  const signature = await signer.signTypedData(buildOrdersReadTypedData(wallet, issuedAt))
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: signature,
  }
}

function getReq(params: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/orders?${params}`, { headers })
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
  listRows = [{ id: 'o1', wallet: WALLET.toLowerCase(), status: 'active', target_price: '123' }]
  singleRow = null
  statusFilters.length = 0
  rpcMock.mockClear()
  mockCheckRateLimit.mockClear()
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 })
})

// ── GET /api/orders — W6-M-01 read gate ─────────────────────────────────────
describe('GET /api/orders — active/pending strategy requires proof-of-ownership [W6-M-01]', () => {
  it('refuses an unauthenticated read that includes active orders (explicit status)', async () => {
    const res = await GET(getReq(`wallet=${WALLET}&status=active`))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.code).toBe('READ_AUTH_REQUIRED')
  })

  it('refuses an unauthenticated read with NO status filter (defaults include active)', async () => {
    const res = await GET(getReq(`wallet=${WALLET}`))
    expect(res.status).toBe(401)
  })

  it('refuses live statuses in a mixed list (the poll query) without auth', async () => {
    const res = await GET(
      getReq(`wallet=${WALLET}&status=active,executing,partially_filled,executed,failed,cancelled,expired`),
    )
    expect(res.status).toBe(401)
  })

  it('keeps terminal-status-only reads public (owner-decided boundary)', async () => {
    listRows = [{ id: 'o2', wallet: WALLET.toLowerCase(), status: 'executed' }]
    const res = await GET(getReq(`wallet=${WALLET}&status=executed,cancelled,expired,failed`))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.orders).toHaveLength(1)
  })

  it('returns the orders when the owner presents a valid session signature', async () => {
    const headers = await readAuthHeaders()
    const res = await GET(getReq(`wallet=${WALLET}&status=active`, headers))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.orders[0].id).toBe('o1')
  })

  it('binds case-insensitively (lowercase wallet in the query, checksummed at signing)', async () => {
    const headers = await readAuthHeaders(WALLET)
    const res = await GET(getReq(`wallet=${WALLET.toLowerCase()}&status=active`, headers))
    expect(res.status).toBe(200)
  })

  it("refuses a signature from a different wallet (can't read someone else's strategy)", async () => {
    const headers = await readAuthHeaders(WALLET, otherAccount)
    const res = await GET(getReq(`wallet=${WALLET}&status=active`, headers))
    expect(res.status).toBe(401)
  })

  it('refuses an expired session signature', async () => {
    const staleIssued = Math.floor(Date.now() / 1000) - 25 * 3600
    const headers = await readAuthHeaders(WALLET, account, staleIssued)
    const res = await GET(getReq(`wallet=${WALLET}&status=active`, headers))
    expect(res.status).toBe(401)
  })

  it('unknown statuses are treated as protected (default-deny), not public', async () => {
    const res = await GET(getReq(`wallet=${WALLET}&status=some_new_status`))
    expect(res.status).toBe(401)
  })
})

// ── GET /api/orders/[id] — same boundary for single-row reads ──────────────
describe('GET /api/orders/[id] — protected statuses need proof [W6-M-01]', () => {
  const params = { params: Promise.resolve({ id: 'o1' }) }

  it('refuses an unauthenticated read of a live order', async () => {
    singleRow = { id: 'o1', wallet: WALLET.toLowerCase(), status: 'active', target_price: '123' }
    const res = await GET_BY_ID(new NextRequest(`http://localhost/api/orders/o1?wallet=${WALLET}`), params)
    expect(res.status).toBe(401)
  })

  it('keeps terminal rows public', async () => {
    singleRow = { id: 'o1', wallet: WALLET.toLowerCase(), status: 'executed' }
    const res = await GET_BY_ID(new NextRequest(`http://localhost/api/orders/o1?wallet=${WALLET}`), params)
    expect(res.status).toBe(200)
  })

  it('returns a live order to its authenticated owner', async () => {
    singleRow = { id: 'o1', wallet: WALLET.toLowerCase(), status: 'active', target_price: '123' }
    const headers = await readAuthHeaders()
    const res = await GET_BY_ID(
      new NextRequest(`http://localhost/api/orders/o1?wallet=${WALLET}`, { headers }),
      params,
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.order.id).toBe('o1')
  })
})

// ── POST /api/orders — W6-M-02 per-IP rate limit + W6-L-01 body cap ─────────
describe('POST /api/orders — per-IP rate limit + body cap', () => {
  function postReq(body: string, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  }

  it('returns 429 when the per-IP limit is exceeded — before any body/signature work [W6-M-02]', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    // Body is deliberately invalid JSON: a 429 (not a parse error) proves the
    // limiter runs before the body is even read.
    const res = await POST(postReq('not-json', { 'x-forwarded-for': '1.2.3.4' }))
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error).toMatch(/rate limit/i)
  })

  it('keys the limit by IP with the orders: prefix', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 })
    await POST(postReq('{}', { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))
    expect(mockCheckRateLimit).toHaveBeenCalledWith('orders:9.9.9.9', expect.any(Number), expect.any(Number))
  })

  it('returns 413 for an oversized body (content-length) [W6-L-01]', async () => {
    const res = await POST(postReq('{}', { 'content-length': '50000' }))
    expect(res.status).toBe(413)
    const json = await res.json()
    expect(json.error).toMatch(/too large/i)
  })

  it('still proceeds to normal validation when allowed (limiter is not a lockout)', async () => {
    const res = await POST(postReq(JSON.stringify({ wallet: 'nope' })))
    expect(res.status).toBe(400) // fails address validation, NOT 429/413
  })
})
