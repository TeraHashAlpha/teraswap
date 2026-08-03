/**
 * [CHORE-DCA-VISIBILITY-AND-STATS #2] /api/history — DCA fills merged into the
 * wallet activity feed.
 *
 * Two layers:
 *  1. Pure merge/dedup/mapping (mapSwapRow / mapFillRow / mergeHistory) — the
 *     swaps-first tx_hash dedup blueprint reused from /api/analytics.
 *  2. The W6 read-auth gate on the GET handler: instant swaps stay public, DCA
 *     fills appear ONLY for a caller who proves wallet ownership with the same
 *     per-session read signature as /api/orders. Signatures are real (viem local
 *     accounts); only Supabase is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildOrdersReadTypedData,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'

// ── Supabase mock — a table-aware chainable/thenable builder ─────────────────
let swapsResult: { data: unknown[]; error: unknown; count: number } = { data: [], error: null, count: 0 }
let fillsResult: { data: unknown[]; error: unknown } = { data: [], error: null }
// Records the .eq(column, value) filters applied to the order_executions query,
// so a test can prove the fills fetch is wallet-scoped + confirmed-only.
let fillEqCalls: Array<[unknown, unknown]> = []

function makeBuilder(table: string, result: unknown) {
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'limit', 'in', 'gte']) {
    builder[m] = () => builder
  }
  builder.range = (from: number, to: number) => {
    if (table === 'swaps') capturedRange = [from, to]
    return builder
  }
  builder.eq = (col: unknown, val: unknown) => {
    if (table === 'order_executions') fillEqCalls.push([col, val])
    return builder
  }
  builder.then = (resolve: (v: unknown) => void) => resolve(result)
  return builder
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) =>
      makeBuilder(table, table === 'swaps' ? swapsResult : fillsResult),
  }),
}))

// [CHORE-API-HARDENING-2 / P3d] The route is now rate-limited; default to
// allowed so the pre-existing tests are unaffected. Rate-limit-specific tests
// override this per-test.
const checkRateLimitMock = vi.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: 1_000 })
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...a),
}))

// Captures the .range(offset, offset+limit-1) call so a test can assert the
// clamped offset actually reached the query.
let capturedRange: [number, number] | null = null

import { GET, mapSwapRow, mapFillRow, mergeHistory, type HistoryItem } from './route'

// ── Fixtures ────────────────────────────────────────────────────────────────
// Published Anvil/Hardhat default account #0 key — throwaway local-dev fixture,
// value-allowlisted in .gitleaks.toml (NOT a secret).
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // gitleaks:allow
const account = privateKeyToAccount(PK)
const WALLET = account.address
const otherAccount = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111', // gitleaks:allow — throwaway test key
)

function swapRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'swap-1',
    wallet: WALLET.toLowerCase(),
    tx_hash: '0xswap1',
    source: '1inch',
    token_in_symbol: 'WETH',
    token_out_symbol: 'USDC',
    amount_in: (1n * 10n ** 18n).toString(),
    amount_out: '3500000000',
    amount_in_usd: 3500,
    amount_out_usd: 3500,
    status: 'confirmed',
    fee_collected: true,
    created_at: '2026-07-06T10:00:00.000Z',
    chain_id: 1,
    ...overrides,
  }
}

// A confirmed DCA fill (order_executions) with the parent order embedded via the
// inner join. Mirrors the golden Base DCA 0x5449dea0 (WETH→ETHFI).
function fillRow(
  overrides: Record<string, unknown> = {},
  orderOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'fill-1',
    created_at: '2026-07-05T11:52:00.000Z',
    tx_hash: '0xfill1',
    amount_in: (4n * 10n ** 15n).toString(), // 0.004 WETH — ACTUAL per-fill
    amount_out: (1957n * 10n ** 16n).toString(), // 19.57 ETHFI — ACTUAL received
    status: 'confirmed',
    execution_number: 5,
    order_id: 'order-5449dea0',
    orders: {
      wallet: WALLET.toLowerCase(),
      order_type: 'dca',
      token_in_symbol: 'WETH',
      token_out_symbol: 'ETHFI',
      token_in_decimals: 18,
      token_out_decimals: 18,
      chain_id: 8453,
      dca_total: 5,
      dca_executed: 5,
      ...orderOverrides,
    },
    ...overrides,
  }
}

async function readAuthHeaders(wallet = WALLET, signer = account, issuedAt = Math.floor(Date.now() / 1000)) {
  const signature = await signer.signTypedData(buildOrdersReadTypedData(wallet, issuedAt))
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: signature,
  }
}

function getReq(params: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/history?${params}`, { headers })
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-stub')
  swapsResult = { data: [swapRow()], error: null, count: 1 }
  fillsResult = { data: [fillRow()], error: null }
  fillEqCalls = []
  capturedRange = null
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 29, resetAt: 1_000 })
})

// ── Pure merge/dedup/mapping ────────────────────────────────────────────────
describe('history mapping + merge (pure)', () => {
  it('mapSwapRow tags kind:swap and preserves every column', () => {
    const item = mapSwapRow(swapRow())
    expect(item.kind).toBe('swap')
    expect(item.token_in_symbol).toBe('WETH')
    expect((item as unknown as Record<string, unknown>).fee_collected).toBe(true)
  })

  it('mapFillRow lifts the embedded order into a dca_fill with ACTUAL amounts', () => {
    const item = mapFillRow(fillRow())!
    expect(item.kind).toBe('dca_fill')
    expect(item.token_in_symbol).toBe('WETH')
    expect(item.token_out_symbol).toBe('ETHFI')
    expect(item.amount_in).toBe((4n * 10n ** 15n).toString())
    expect(item.amount_out).toBe((1957n * 10n ** 16n).toString())
    expect(item.order_id).toBe('order-5449dea0')
    expect(item.order_type).toBe('dca')
    expect(item.execution_number).toBe(5)
    expect(item.chain_id).toBe(8453)
    expect(item.amount_in_usd).toBeNull() // no fabricated USD
  })

  it('mapFillRow accepts the embed as an array (PostgREST shape) and returns null when absent', () => {
    expect(mapFillRow(fillRow({ orders: [fillRow().orders] }))!.token_out_symbol).toBe('ETHFI')
    expect(mapFillRow(fillRow({ orders: null }))).toBeNull()
  })

  it('mergeHistory orders newest-first and dedups a shared tx_hash swaps-first', () => {
    const swaps = [mapSwapRow(swapRow({ tx_hash: '0xdup', created_at: '2026-07-06T10:00:00.000Z' }))]
    const fills = [
      mapFillRow(fillRow({ tx_hash: '0xdup', created_at: '2026-07-05T11:52:00.000Z' }))!, // dupe → dropped
      mapFillRow(fillRow({ id: 'fill-2', tx_hash: '0xfill2', created_at: '2026-07-07T09:00:00.000Z' }))!,
    ]
    const merged = mergeHistory(swaps, fills)
    expect(merged).toHaveLength(2)
    expect(merged[0].tx_hash).toBe('0xfill2') // newest
    expect(merged[1].tx_hash).toBe('0xdup')
    expect(merged.find((m) => m.tx_hash === '0xdup')!.kind).toBe('swap') // swap won the dedup
  })

  it('mergeHistory respects the limit slice', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      mapSwapRow(swapRow({ id: `s${i}`, tx_hash: `0x${i}`, created_at: `2026-07-0${i + 1}T00:00:00.000Z` })),
    )
    expect(mergeHistory(items, [], 3)).toHaveLength(3)
  })
})

// ── W6 read-auth gate on GET ────────────────────────────────────────────────
describe('GET /api/history — DCA fills are W6-gated [CHORE-DCA-VISIBILITY-AND-STATS #2]', () => {
  it('returns only swaps for an unauthenticated caller (fills withheld, feed not broken)', async () => {
    const res = await GET(getReq(`wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.fillsIncluded).toBe(false)
    expect(json.swaps.every((s: HistoryItem) => s.kind === 'swap')).toBe(true)
    expect(json.swaps).toHaveLength(1)
    expect(fillEqCalls).toHaveLength(0) // the fills query never ran
  })

  it('merges the wallet own DCA fills when a valid session signature is presented', async () => {
    const res = await GET(getReq(`wallet=${WALLET}`, await readAuthHeaders()))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.fillsIncluded).toBe(true)
    const kinds = json.swaps.map((s: HistoryItem) => s.kind)
    expect(kinds).toContain('swap')
    expect(kinds).toContain('dca_fill')
    // Newest-first: the swap (07-06) precedes the fill (07-05).
    expect(json.swaps[0].kind).toBe('swap')
    // The fills query was wallet-scoped + confirmed-only.
    expect(fillEqCalls).toContainEqual(['orders.wallet', WALLET.toLowerCase()])
    expect(fillEqCalls).toContainEqual(['status', 'confirmed'])
  })

  it("withholds fills for a signature from a DIFFERENT wallet (can't read another's fills)", async () => {
    const res = await GET(getReq(`wallet=${WALLET}`, await readAuthHeaders(WALLET, otherAccount)))
    const json = await res.json()
    expect(json.fillsIncluded).toBe(false)
    expect(json.swaps.some((s: HistoryItem) => s.kind === 'dca_fill')).toBe(false)
    expect(fillEqCalls).toHaveLength(0)
  })

  it('withholds fills for an expired signature', async () => {
    const stale = Math.floor(Date.now() / 1000) - 25 * 3600
    const res = await GET(getReq(`wallet=${WALLET}`, await readAuthHeaders(WALLET, account, stale)))
    const json = await res.json()
    expect(json.fillsIncluded).toBe(false)
  })

  it('dedups a fill that shares a swap tx_hash (swap wins) even when authenticated', async () => {
    swapsResult = { data: [swapRow({ tx_hash: '0xshared' })], error: null, count: 1 }
    fillsResult = { data: [fillRow({ tx_hash: '0xshared' })], error: null }
    const res = await GET(getReq(`wallet=${WALLET}`, await readAuthHeaders()))
    const json = await res.json()
    const shared = json.swaps.filter((s: HistoryItem) => s.tx_hash === '0xshared')
    expect(shared).toHaveLength(1)
    expect(shared[0].kind).toBe('swap')
  })

  it('rejects a missing wallet param', async () => {
    const res = await GET(getReq('limit=50'))
    expect(res.status).toBe(400)
  })
})

// ── P3d: rate limit + offset cap [CHORE-API-HARDENING-2] ────────────────────
describe('GET /api/history — rate limit + offset cap (P3d)', () => {
  it('is rate-limited per wallet (429 with Retry headers when exceeded)', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 123_456 })
    const res = await GET(getReq(`wallet=${WALLET}`))
    expect(res.status).toBe(429)
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(checkRateLimitMock).toHaveBeenCalledWith(`history:${WALLET.toLowerCase()}`, 30, 60_000)
  })

  it('clamps an oversized offset to the cap instead of scanning unbounded', async () => {
    const res = await GET(getReq(`wallet=${WALLET}&offset=999999999`))
    expect(res.status).toBe(200)
    expect(capturedRange).not.toBeNull()
    const [from] = capturedRange!
    expect(from).toBe(2_000) // MAX_OFFSET
  })

  it('rejects a negative offset by clamping to 0', async () => {
    const res = await GET(getReq(`wallet=${WALLET}&offset=-50`))
    expect(res.status).toBe(200)
    expect(capturedRange![0]).toBe(0)
  })

  it('passes a normal offset through unchanged', async () => {
    await GET(getReq(`wallet=${WALLET}&offset=40&limit=20`))
    expect(capturedRange).toEqual([40, 59])
  })
})
