// @vitest-environment node
/**
 * [fix/orders-server-side-order-hash, audit 2026-11-16 S-5] POST /api/orders stores the SERVER's
 * order hash, never the caller's text.
 *
 * End to end against the local test setup: REAL EIP-712 signatures (viem account), the REAL
 * recoverTypedDataAddress and the REAL order-engine config (executor addresses stubbed into the
 * NEXT_PUBLIC_* slots before config loads), and an in-memory `orders` table that enforces
 * unique_order_hash exactly as contracts/order-engine/schema.sql:114 does (UNIQUE on the TEXT column).
 * Only the network edges are stubbed: rate-limit KV, freeze flag, token presence, price/decimals reads.
 *
 * The expected hash is computed here WITHOUT the server function, the way the contracts write
 * getOrderHash: keccak256(abi.encode(keccak256(type string), fields...)).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { encodeAbiParameters, keccak256, toBytes, zeroAddress, zeroHash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const BASE_V3 = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0' // docs/DEPLOYMENTS.md, OrderExecutor V3 · Base
const MAINNET_V2 = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130' // docs/DEPLOYMENTS.md, OrderExecutor · Mainnet

const fake = vi.hoisted(() => {
  // config.ts reads these at module load: stub (never read) the production addresses first.
  vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', '0x686b4f812291F4De238E59ED00BA6dD6129e60a0')
  vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS', '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130')
  return { rows: [] as Record<string, unknown>[] }
})

// In-memory `orders` with the one constraint that matters here: UNIQUE (order_hash).
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async (fn: string) => {
      if (fn !== 'check_order_rate_limit') throw new Error(`unexpected rpc ${fn}`)
      return { data: true, error: null }
    },
    from: (table: string) => {
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      return {
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (fake.rows.some((r) => r.order_hash === row.order_hash)) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "unique_order_hash"' } }
              }
              const stored = { id: `row-${fake.rows.length + 1}`, ...row }
              fake.rows.push(stored)
              return { data: stored, error: null }
            },
          }),
        }),
      }
    },
  }),
}))
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

import { POST } from './route'
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES, ORDER_V3_TYPE_STRING } from '@/lib/order-engine/types'

// Derived at run time: no key material in the source.
const account = privateKeyToAccount(keccak256(toBytes('fix/orders-server-side-order-hash route test')))
const TOKEN_IN = '0x2222222222222222222222222222222222222222'
const TOKEN_OUT = '0x3333333333333333333333333333333333333333'
const ROUTER = '0x4444444444444444444444444444444444444444'
const NOW_MS = Date.UTC(2026, 10, 17, 12, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)
const V2_TYPE_STRING =
  'Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 orderType,' +
  'uint8 condition,uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,' +
  'bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)'

type Signed = { body: Record<string, unknown>; hash: Hex }

/** keccak256(abi.encode(TYPEHASH, fields...)) — the contracts' getOrderHash, written out independently. */
function contractStyleHash(v3: boolean, m: Record<string, bigint | number | string>): Hex {
  const head = [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] as const
  const tail = [
    { type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' },
  ] as const
  const hv = [keccak256(toBytes(v3 ? ORDER_V3_TYPE_STRING : V2_TYPE_STRING)), m.owner, m.tokenIn, m.tokenOut, m.amountIn, m.minAmountOut] as const
  const tv = [m.orderType, m.condition, m.targetPrice, m.priceFeed, m.expiry, m.nonce, m.router, m.routerDataHash, m.dcaInterval, m.dcaTotal] as const
  return v3
    ? keccak256(encodeAbiParameters([...head, { type: 'uint16' }, ...tail] as never, [...hv, m.maxSlippageBps, ...tv] as never))
    : keccak256(encodeAbiParameters([...head, ...tail] as never, [...hv, ...tv] as never))
}

/** A DCA order signed the way the client signs it (useOrderEngine confirmOrder), and its POST body. */
async function signedDca(version: 2 | 3): Promise<Signed> {
  const v3 = version === 3
  const message = {
    owner: account.address, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
    amountIn: 10n ** 18n, minAmountOut: 100n * 10n ** 18n,
    ...(v3 ? { maxSlippageBps: 300 } : {}),
    orderType: 2, condition: 0, targetPrice: 0n, priceFeed: zeroAddress,
    expiry: BigInt(NOW_S + 3600), nonce: 7n, router: ROUTER, routerDataHash: zeroHash,
    dcaInterval: 3600n, dcaTotal: 3n,
  }
  const domain = {
    name: 'TeraSwapOrderExecutor', version: v3 ? '3' : '2',
    chainId: v3 ? 8453 : 1, verifyingContract: v3 ? BASE_V3 : MAINNET_V2,
  } as const
  const signature = await account.signTypedData({
    domain, types: v3 ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES, primaryType: 'Order', message: message as never,
  })
  const hash = contractStyleHash(v3, message)
  const body: Record<string, unknown> = {
    wallet: account.address, chainId: domain.chainId,
    tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, router: ROUTER, signature, orderHash: hash,
    amountIn: message.amountIn.toString(), minAmountOut: message.minAmountOut.toString(), tokenOutDecimals: 18,
    orderType: 'dca', priceCondition: 'above', targetPrice: '0', priceFeed: zeroAddress,
    expiry: NOW_S + 3600, nonce: 7, routerDataHash: zeroHash, dcaInterval: 3600, dcaTotal: 3,
    ...(v3 ? { maxSlippageBps: 300 } : {}),
    orderData: {
      owner: account.address, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
      amountIn: message.amountIn.toString(), minAmountOut: message.minAmountOut.toString(),
      ...(v3 ? { maxSlippageBps: 300 } : {}),
      orderType: 2, condition: 0, targetPrice: '0', priceFeed: zeroAddress,
      expiry: String(NOW_S + 3600), nonce: '7', router: ROUTER, routerDataHash: zeroHash,
      dcaInterval: '3600', dcaTotal: '3',
    },
  }
  return { body, hash }
}

async function post(body: unknown) {
  const res = await POST(new NextRequest('http://localhost/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: (await res.json()) as { order?: Record<string, unknown>; error?: string } }
}

const WRONG_A = `0x${'ab'.repeat(32)}`
const WRONG_B = `0x${'cd'.repeat(32)}`
let warn: ReturnType<typeof vi.spyOn>
// "No test calls a public RPC": any fetch from the route under test fails the test (afterEach).
const network = vi.fn(async (input: unknown) => { throw new Error(`network access in a unit test: ${String(input)}`) })

/** The mismatch lines the route logged, parsed. */
function mismatchLines(): Record<string, unknown>[] {
  return warn.mock.calls
    .map((c: unknown[]) => { try { return JSON.parse(String(c[0])) } catch { return null } })
    .filter((x: Record<string, unknown> | null): x is Record<string, unknown> => x?.event === 'orders_order_hash_mismatch')
}

beforeEach(() => {
  fake.rows.length = 0
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubEnv('SUPABASE_URL', 'https://fake.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role-key')
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  network.mockClear()
  vi.stubGlobal('fetch', network)
})
afterEach(() => {
  vi.useRealTimers()
  warn.mockRestore()
  vi.unstubAllGlobals()
  expect(network).not.toHaveBeenCalled()
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/orders stores the server hash [S-5]', () => {
  it.each([
    ['two wrong texts', WRONG_A, WRONG_B],
    ['the right hash, then a wrong text', null, WRONG_A],
    ['a wrong text, then the right hash', WRONG_A, null],
  ])('same signed order posted twice (%s): one row, then 409', async (_label, first, second) => {
    const { body, hash } = await signedDca(3)
    const a = await post({ ...body, orderHash: first ?? hash })
    const b = await post({ ...body, orderHash: second ?? hash })
    expect(a.status).toBe(201)
    expect(b.status).toBe(409)
    expect(b.json.error).toBe('Order already exists (duplicate hash)')
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].order_hash).toBe(hash)
  })

  it.each([
    ['another order\'s hash', WRONG_A],
    ['not a hash at all', 'not-a-hash'],
  ])('wrong hash text (%s) is stored as the server hash and logged once, without the signature', async (_label, text) => {
    const { body, hash } = await signedDca(3)
    const res = await post({ ...body, orderHash: text })
    expect(res.status).toBe(201)
    expect(res.json.order?.order_hash).toBe(hash)
    expect(fake.rows.map((r) => r.order_hash)).toEqual([hash])
    expect(mismatchLines()).toEqual([{
      event: 'orders_order_hash_mismatch', mode: 'observe', chainId: 8453, version: 3, orderType: 'dca',
      storedHash: hash, callerHash: text,
    }])
    const logged = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(logged).not.toContain(String(body.signature).slice(2, 42))
  })

  it('correct hash: unchanged behaviour (201, the row stores that exact text, the response returns it, nothing logged)', async () => {
    const { body, hash } = await signedDca(3)
    const res = await post(body)
    expect(res.status).toBe(201)
    expect(res.json.order?.order_hash).toBe(body.orderHash)
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]).toMatchObject({
      wallet: account.address.toLowerCase(), order_type: 'dca', token_in: TOKEN_IN, token_out: TOKEN_OUT,
      amount_in: body.amountIn, min_amount_out: body.minAmountOut, signature: body.signature, order_hash: hash,
      dca_interval: 3600, dca_total: 3, chain_id: 8453, status: 'active', order_data: body.orderData,
    })
    expect(mismatchLines()).toEqual([])
  })

  it.each([
    ['upper-case hex', (h: string) => `0x${h.slice(2).toUpperCase()}`],
    ['0X prefix, upper case', (h: string) => h.toUpperCase()],
    ['no 0x prefix', (h: string) => h.slice(2)],
  ])('mixed case accepted (%s): 201, stored as the lower-case server hash, nothing logged', async (_label, spell) => {
    const { body, hash } = await signedDca(3)
    const res = await post({ ...body, orderHash: spell(hash) })
    expect(res.status).toBe(201)
    expect(fake.rows.map((r) => r.order_hash)).toEqual([hash])
    expect(mismatchLines()).toEqual([])
  })

  it('a v2-signed order (Mainnet) stores the v2 hash; a wrong text is logged with version 2', async () => {
    const { body, hash } = await signedDca(2)
    const res = await post({ ...body, orderHash: WRONG_B })
    expect(res.status).toBe(201)
    expect(fake.rows.map((r) => r.order_hash)).toEqual([hash])
    expect(mismatchLines()).toMatchObject([{ version: 2, chainId: 1, storedHash: hash, callerHash: WRONG_B }])
    expect((await post(body)).status).toBe(409)
  })

  it('a top-level body field that differs from the signed one fails recovery: 400 Signature mismatch, nothing stored', async () => {
    const { body } = await signedDca(3)
    const res = await post({ ...body, nonce: 8 })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('Signature mismatch')
    expect(fake.rows).toHaveLength(0)
  })
})

// [A86 S-1] The M-07 order_data cross-check (route.ts) compares owner, tokens, amounts, router, maxSlippageBps and a
// non-zero routerDataHash only. These are the signed fields it does NOT compare, each bent in orderData to two values
// that differ from the signed one. The stored hash must still be the signed order's (the verified message, never the
// orderData copy), and the same signature re-posted with another orderData must not add a row.
const FEED_A = '0x5555555555555555555555555555555555555555'
const FEED_B = '0x6666666666666666666666666666666666666666'
const SKIPPED: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['orderType', { orderType: 0 }, { orderType: 1 }],
  ['condition', { condition: 1 }, { condition: 2 }],
  ['targetPrice', { targetPrice: '1' }, { targetPrice: '250000000000' }],
  ['priceFeed', { priceFeed: FEED_A }, { priceFeed: FEED_B }],
  ['expiry', { expiry: String(NOW_S + 7200) }, { expiry: String(NOW_S + 10_800) }],
  ['nonce', { nonce: '8' }, { nonce: '9' }],
  ['dcaInterval', { dcaInterval: '7200' }, { dcaInterval: '60' }],
  ['dcaTotal', { dcaTotal: '4' }, { dcaTotal: '2' }],
  ['routerDataHash (the body\'s is zero)', { routerDataHash: `0x${'12'.repeat(32)}` }, { routerDataHash: `0x${'34'.repeat(32)}` }],
]
const ALL_NINE: [string, Record<string, unknown>, Record<string, unknown>] = [
  'all nine at once',
  Object.assign({}, ...SKIPPED.map(([, first]) => first)),
  Object.assign({}, ...SKIPPED.map(([, , second]) => second)),
]

describe('orderData that differs from the signed order where M-07 does not compare [A86 S-1]', () => {
  it.each(([3, 2] as const).flatMap((v) => [...SKIPPED, ALL_NINE].map(([field, first, second]) => [v, field, first, second] as const)))(
    'v%s, orderData differs in %s: stored order_hash = the signed order\'s contract hash; a re-post with other orderData is 409, one row',
    async (version, _field, first, second) => {
      const { body, hash } = await signedDca(version)
      const orderData = body.orderData as Record<string, unknown>
      const firstData = { ...orderData, ...first }

      const a = await post({ ...body, orderData: firstData })
      expect(a.status).toBe(201)
      expect(a.json.order?.order_hash).toBe(hash)
      expect(fake.rows.map((r) => r.order_hash)).toEqual([hash])

      const b = await post({ ...body, orderData: { ...orderData, ...second } })
      expect(b.status).toBe(409)
      expect(b.json.error).toMatch(/^Order already exists/)
      expect(fake.rows).toHaveLength(1)
      expect(fake.rows[0]).toMatchObject({ order_hash: hash, order_data: firstData })
    },
  )
})
