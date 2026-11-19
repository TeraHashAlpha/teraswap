// @vitest-environment node
/**
 * [fix/server-builds-order-data, A89 R2-3/R2-4] The pre-insert signature lookup through the REAL @supabase/supabase-js
 * (postgrest-js, with its GET retries) against a stub PostgREST `fetch` (no network): the query the real builder sends,
 * and the 3 s deadline. Before the fix a hung lookup never answered (A89: no answer in 45 s) and a 503-answering one took
 * about 7 s (retries 1 + 2 + 4 s); `Retry-After: 5` stretched it to 15 s. Every case must answer 503 within 4 s, fail
 * closed (nothing inserted). Real timers: the deadline is wall-clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { keccak256, toBytes, zeroAddress, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

vi.hoisted(() => {
  vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', '0x686b4f812291F4De238E59ED00BA6dD6129e60a0')
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  return { ...actual, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })) }
})
vi.mock('@/lib/dca-freeze', () => ({ getDcaFreezeState: vi.fn(async () => ({ frozen: false })) }))
vi.mock('@/lib/order-engine/token-on-chain', () => ({
  checkTokenOnChain: vi.fn(async () => ({ onChain: true })),
  _clearTokenOnChainCache: vi.fn(),
}))
vi.mock('@/lib/order-engine/dca-floor-tier', () => ({ classifyDcaFloor: vi.fn(async () => 'onchain-feed') }))
vi.mock('@/lib/defillama', () => ({
  fetchDefiLlamaPrice: vi.fn(async () => ({ price: 1, symbol: 'USDC', timestamp: 0, confidence: 1 })),
  HIGH_VALUE_THRESHOLD_USD: 10_000,
  validateSwapPrice: vi.fn(),
}))
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: vi.fn(async () => null),
  fetchErc20Decimals: vi.fn(async () => 18),
}))

import { POST, maxDuration } from './route'
import { ORDER_V3_EIP712_TYPES } from '@/lib/order-engine/types'

const account = privateKeyToAccount(keccak256(toBytes('fix/server-builds-order-data deadline test')))
const BASE_V3 = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'

async function signedBody(salt: string) {
  const now = Math.floor(Date.now() / 1000)
  const message = {
    owner: account.address, tokenIn: '0x2222222222222222222222222222222222222222',
    tokenOut: '0x3333333333333333333333333333333333333333', amountIn: 10n ** 18n, minAmountOut: 100n * 10n ** 18n,
    maxSlippageBps: 300, orderType: 2, condition: 0, targetPrice: 0n, priceFeed: zeroAddress, expiry: BigInt(now + 3600),
    nonce: BigInt(keccak256(toBytes(salt))) % 2n ** 31n, router: '0x4444444444444444444444444444444444444444',
    routerDataHash: zeroHash, dcaInterval: 3600n, dcaTotal: 3n,
  } as const
  const signature = await account.signTypedData({
    domain: { name: 'TeraSwapOrderExecutor', version: '3', chainId: 8453, verifyingContract: BASE_V3 },
    types: ORDER_V3_EIP712_TYPES, primaryType: 'Order', message,
  })
  return {
    wallet: account.address, chainId: 8453, tokenIn: message.tokenIn, tokenOut: message.tokenOut, router: message.router,
    signature, orderHash: zeroHash, amountIn: String(message.amountIn), minAmountOut: String(message.minAmountOut),
    tokenOutDecimals: 18, orderType: 'dca', priceCondition: 'above', targetPrice: '0', priceFeed: zeroAddress,
    expiry: Number(message.expiry), nonce: Number(message.nonce), routerDataHash: zeroHash, dcaInterval: 3600, dcaTotal: 3,
    maxSlippageBps: 300,
  }
}

type Mode = 'empty' | 'hang' | '503' | 'retry-after-5'
const seen = { lookups: [] as { url: URL; signal: AbortSignal | null | undefined }[], inserts: 0 }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A PostgREST that answers the rate-limit RPC, the lookup as `mode` says, and the insert. Anything else throws. */
function stubPostgrest(mode: Mode) {
  return vi.fn((input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    if (url.origin !== 'https://fake.supabase.co') throw new Error(`network access in a unit test: ${url.origin}`)
    if (url.pathname === '/rest/v1/rpc/check_order_rate_limit') return Promise.resolve(json(true))
    if (url.pathname === '/rest/v1/orders' && method === 'GET') {
      const signal = init?.signal
      seen.lookups.push({ url, signal })
      if (mode === 'empty') return Promise.resolve(json([]))
      if (mode === '503') return Promise.resolve(json({ message: 'unavailable' }, 503))
      if (mode === 'retry-after-5') return Promise.resolve(json({ message: 'schema cache' }, 503, { 'Retry-After': '5' }))
      // 'hang': never answers; like fetch, rejects with the signal's reason once it fires.
      return new Promise<Response>((_, reject) => {
        if (!signal) return
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    }
    if (url.pathname === '/rest/v1/orders' && method === 'POST') {
      seen.inserts += 1
      return Promise.resolve(json({ id: 'row-1', ...JSON.parse(String(init?.body)) }, 201))
    }
    throw new Error(`unexpected request ${method} ${url}`)
  })
}

async function post(body: unknown) {
  const res = await POST(new NextRequest('http://localhost/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: (await res.json()) as { error?: string; order?: Record<string, unknown> } }
}

beforeEach(() => {
  seen.lookups.length = 0
  seen.inserts = 0
  vi.stubEnv('SUPABASE_URL', 'https://fake.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role-key')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('R2-3: the signature lookup answers within its deadline, fail closed', () => {
  it('the route exports maxDuration = 30 (owner decision 2026-11-18)', () => {
    expect(maxDuration).toBe(30)
  })

  it.each(['hang', '503', 'retry-after-5'] as const)('lookup %s: 503 within 4 s, nothing inserted', async (mode) => {
    vi.stubGlobal('fetch', stubPostgrest(mode))
    const body = await signedBody(`deadline ${mode}`)
    const t0 = performance.now()
    const res = await post(body)
    const elapsed = performance.now() - t0
    expect(res.status).toBe(503)
    expect(res.json.error).toBe('Could not check for an existing order. Try again shortly.')
    expect(elapsed).toBeLessThan(4_000)
    expect(seen.inserts).toBe(0)
    expect(seen.lookups.length).toBeGreaterThan(0)
    expect(seen.lookups.every((l) => l.signal instanceof AbortSignal)).toBe(true)
  }, 15_000)
})

describe('R2-4: the query the real client sends', () => {
  it('select=id, wallet=eq.<lower-cased wallet>, or=(the 4 signature texts, ilike), limit=1, with a signal; then the insert', async () => {
    vi.stubGlobal('fetch', stubPostgrest('empty'))
    const body = await signedBody('query shape')
    const res = await post(body)
    expect(res.status).toBe(201)
    expect(seen.inserts).toBe(1)
    expect(seen.lookups).toHaveLength(1)
    const q = seen.lookups[0].url.searchParams
    expect(q.get('select')).toBe('id')
    expect(q.get('wallet')).toBe(`eq.${account.address.toLowerCase()}`)
    expect(q.get('limit')).toBe('1')
    const or = q.get('or') ?? ''
    expect(or).toMatch(/^\(signature\.ilike\.0x[0-9a-f]{130}(,signature\.ilike\.0x[0-9a-f]{130}){3}\)$/)
    expect(or).toContain(body.signature.toLowerCase())
    expect(seen.lookups[0].signal).toBeInstanceOf(AbortSignal)
  })
})
