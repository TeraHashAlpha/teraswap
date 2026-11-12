/**
 * [fix/portfolio-tokens-view] GET /api/portfolio/tokens: pageKey paging, the catalog guarantee and `truncated`.
 *
 * Owner report (Base): the wallet holds 78.6 UNI (a catalog token) but Portfolio listed only ETH, WETH and airdropped junk.
 * Cause: one `alchemy_getTokenBalances` call, no pageKey, then `.slice(0, MAX_TOKENS)` in Alchemy's order.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60_000 }),
}))

import { GET } from './route'

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'
const BASE_UNI = '0xc3De830EA07524a0761646a6a4e4be0e114a3C83'
const ONE = '0x' + (10n ** 18n).toString(16)
const ZERO_PADDED = '0x' + '0'.repeat(64)

interface Bal { contractAddress: string; tokenBalance: string | null }
interface Call { method: string; params: unknown[] }
type Row = { address: string; isDefault: boolean; symbol: string }

function junk(from: number, count: number): Bal[] {
  const out: Bal[] = []
  for (let i = from; i < from + count; i++) {
    out.push({ contractAddress: `0x${(i + 1).toString(16).padStart(40, 'a')}`, tokenBalance: '0x1' })
  }
  return out
}

/**
 * Alchemy stand-in. 'erc20' calls walk `pages` by pageKey (p1, p2, ...); `endless` makes every page point at another.
 * Address-array calls answer from `held` (zero-padded hex for what the wallet does not hold, as the real API does).
 */
function pagedMock(opts: { pages: Bal[][]; endless?: boolean; failPage?: number; held?: Record<string, string> }) {
  const calls: Call[] = []
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Call
    calls.push(body)
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
    if (body.method !== 'alchemy_getTokenBalances') return ok(null) // metadata: none, the route uses its fallback
    if (Array.isArray(body.params[1])) {
      const held = opts.held ?? {}
      return ok({
        address: WALLET,
        tokenBalances: (body.params[1] as string[]).map((a) => ({ contractAddress: a, tokenBalance: held[a.toLowerCase()] ?? ZERO_PADDED })),
      })
    }
    const options = (body.params[2] ?? {}) as { pageKey?: string }
    const idx = options.pageKey ? Number(options.pageKey.slice(1)) : 0
    if (opts.failPage === idx) return new Response(JSON.stringify({ error: { message: 'page down' } }), { status: 200 })
    const page = opts.pages[Math.min(idx, opts.pages.length - 1)] ?? []
    const hasNext = opts.endless || idx + 1 < opts.pages.length
    return ok({ address: WALLET, tokenBalances: page, ...(hasNext ? { pageKey: `p${idx + 1}` } : {}) })
  }) as unknown as typeof fetch
  return { mock, calls }
}

const erc20Calls = (calls: Call[]) => calls.filter((c) => c.method === 'alchemy_getTokenBalances' && !Array.isArray(c.params[1]))
const catalogCalls = (calls: Call[]) => calls.filter((c) => c.method === 'alchemy_getTokenBalances' && Array.isArray(c.params[1]))
const metadataCalls = (calls: Call[]) => calls.filter((c) => c.method === 'alchemy_getTokenMetadata')

async function ask(chain = 8453) {
  const res = await GET(new NextRequest(`http://localhost/api/portfolio/tokens?address=${WALLET}&chainId=${chain}`))
  return { res, body: (await res.json()) as { tokens: Row[]; truncated: boolean } }
}

const ORIGINAL_KEY = process.env.ALCHEMY_API_KEY
beforeEach(() => { process.env.ALCHEMY_API_KEY = 'test-key' })
afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_KEY === undefined) delete process.env.ALCHEMY_API_KEY
  else process.env.ALCHEMY_API_KEY = ORIGINAL_KEY
})

describe('GET /api/portfolio/tokens: paging and the catalog guarantee', () => {
  it('follows pageKey: 300 junk tokens (three full pages), then UNI on the next page -> UNI is returned as a catalog token', async () => {
    const { mock, calls } = pagedMock({
      pages: [junk(0, 100), junk(100, 100), junk(200, 100), [{ contractAddress: BASE_UNI, tokenBalance: ONE }]],
    })
    vi.stubGlobal('fetch', mock)
    const { res, body } = await ask()
    expect(res.status).toBe(200)
    const uni = body.tokens.find((t) => t.address === BASE_UNI.toLowerCase())
    expect(uni).toBeTruthy()
    expect(uni!.isDefault).toBe(true)
    expect(uni!.symbol).toBe('UNI')
    // catalog first: UNI leads the list even though Alchemy returned it last
    expect(body.tokens[0].address).toBe(BASE_UNI.toLowerCase())
    // 301 holdings > MAX_TOKENS (200): trimmed, and the response says so
    expect(body.tokens).toHaveLength(200)
    expect(body.truncated).toBe(true)
    // the scan reached a short last page, so no catalog check; calls 2.. carried the pageKey; maxCount is the documented 100
    expect(catalogCalls(calls)).toHaveLength(0)
    expect(erc20Calls(calls).map((c) => (c.params[2] as { pageKey?: string }).pageKey)).toEqual([undefined, 'p1', 'p2', 'p3'])
    expect((erc20Calls(calls)[0].params[2] as { maxCount: number }).maxCount).toBe(100)
  })

  it('UNI on page 3 of a 298-junk wallet (short last page): found, no catalog check needed', async () => {
    const { mock, calls } = pagedMock({
      pages: [junk(0, 100), junk(100, 100), [...junk(200, 98), { contractAddress: BASE_UNI, tokenBalance: ONE }]],
    })
    vi.stubGlobal('fetch', mock)
    const { body } = await ask()
    expect(body.tokens[0].address).toBe(BASE_UNI.toLowerCase())
    expect(body.tokens[0].isDefault).toBe(true)
    expect(catalogCalls(calls)).toHaveLength(0)
  })

  it('a FULL last page with no pageKey proves nothing (the docs show no pageKey in the response): catalog check runs, truncated', async () => {
    const { mock, calls } = pagedMock({ pages: [junk(0, 100)], held: { [BASE_UNI.toLowerCase()]: ONE } })
    vi.stubGlobal('fetch', mock)
    const { body } = await ask()
    expect(erc20Calls(calls)).toHaveLength(1)
    expect(catalogCalls(calls).length).toBeGreaterThan(0)
    expect(body.truncated).toBe(true)
    expect(body.tokens.some((t) => t.address === BASE_UNI.toLowerCase() && t.isDefault)).toBe(true)
  })

  it('page cap reached: truncated, and the catalog check still returns a UNI that sits beyond the cap', async () => {
    const { mock, calls } = pagedMock({ pages: [junk(0, 100)], endless: true, held: { [BASE_UNI.toLowerCase()]: ONE } })
    vi.stubGlobal('fetch', mock)
    const { res, body } = await ask()
    expect(res.status).toBe(200)
    expect(body.truncated).toBe(true)
    expect(erc20Calls(calls)).toHaveLength(5) // MAX_BALANCE_PAGES, never more
    expect(catalogCalls(calls).length).toBeGreaterThan(0)
    for (const c of catalogCalls(calls)) expect((c.params[1] as string[]).length).toBeLessThanOrEqual(100)
    expect(body.tokens.find((t) => t.address === BASE_UNI.toLowerCase())?.isDefault).toBe(true)
    // the native-ETH sentinel is not a contract and is never queried
    const queried = catalogCalls(calls).flatMap((c) => c.params[1] as string[]).map((a) => a.toLowerCase())
    expect(queried).not.toContain('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
  })

  it('Alchemy error on page 2: page 1 is still served (truncated) and catalog holdings are still found', async () => {
    const { mock } = pagedMock({ pages: [junk(0, 5), junk(5, 5)], failPage: 1, held: { [BASE_UNI.toLowerCase()]: ONE } })
    vi.stubGlobal('fetch', mock)
    const { res, body } = await ask()
    expect(res.status).toBe(200)
    expect(body.truncated).toBe(true)
    expect(body.tokens.some((t) => t.address === BASE_UNI.toLowerCase())).toBe(true)
    expect(body.tokens.filter((t) => !t.isDefault)).toHaveLength(5) // page 1's five junk entries
  })

  it('a wallet that fits one page costs one balances call and is not truncated (compute units unchanged)', async () => {
    const { mock, calls } = pagedMock({ pages: [[{ contractAddress: BASE_UNI, tokenBalance: ONE }]] })
    vi.stubGlobal('fetch', mock)
    const { body } = await ask()
    expect(body.truncated).toBe(false)
    expect(body.tokens).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'alchemy_getTokenBalances')).toHaveLength(1)
    expect(metadataCalls(calls)).toHaveLength(0) // UNI comes from the catalog
  })

  it('drops zero-padded 32-byte balances: they take no slot and no metadata call', async () => {
    const { mock, calls } = pagedMock({
      pages: [[{ contractAddress: junk(0, 1)[0].contractAddress, tokenBalance: ZERO_PADDED }, { contractAddress: BASE_UNI, tokenBalance: ONE }]],
    })
    vi.stubGlobal('fetch', mock)
    const { body } = await ask()
    expect(body.tokens.map((t) => t.address)).toEqual([BASE_UNI.toLowerCase()])
    expect(metadataCalls(calls)).toHaveLength(0)
  })

  it('still 502s when page 1 itself fails', async () => {
    const { mock } = pagedMock({ pages: [junk(0, 3)], failPage: 0 })
    vi.stubGlobal('fetch', mock)
    const res = await GET(new NextRequest(`http://localhost/api/portfolio/tokens?address=${WALLET}&chainId=8453`))
    expect(res.status).toBe(502)
  })
})
