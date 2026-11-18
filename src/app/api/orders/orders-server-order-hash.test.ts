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
  return {
    rows: [] as Record<string, unknown>[],
    /** [A86 S-3] Every `or` filter the route sent, and how many rows each lookup found. */
    lookups: [] as { filter: string; wallet: string; found: number }[],
    /** When set, each lookup waits until `needed` lookups have arrived: requests racing past the lookup together. */
    barrier: null as null | { needed: number; arrived: number; release: () => void; open: Promise<void> },
    lookupError: null as null | { message: string },
  }
})

/** PostgREST `ilike`: case-insensitive, whole value; `%` and `*` match any run, `_` one character. */
function ilike(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${re}$`, 'is').test(value)
}

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
        // [A86 S-3] The route's lookup: .select('id').eq('wallet', <lower>).or('signature.ilike.<t>,…').limit(1)
        // .abortSignal(<3 s>) [A89 R2-3/R2-4]. Both filters apply (PostgREST ANDs them).
        select: (cols: string) => ({
          eq: (column: string, wallet: string) => ({
            or: (filter: string) => ({
              limit: (n: number) => ({
                abortSignal: async (signal: AbortSignal) => {
                  if (cols !== 'id') throw new Error(`unexpected select ${cols}`)
                  if (column !== 'wallet') throw new Error(`unexpected eq column ${column}`)
                  if (!(signal instanceof AbortSignal)) throw new Error('the lookup must carry an AbortSignal')
                  const terms = filter.split(',').map((term) => {
                    const m = /^signature\.ilike\.(.*)$/s.exec(term)
                    if (!m) throw new Error(`unexpected filter term ${term}`)
                    return m[1]
                  })
                  const barrier = fake.barrier
                  if (barrier) {
                    barrier.arrived += 1
                    if (barrier.arrived >= barrier.needed) barrier.release()
                    await barrier.open
                  }
                  if (fake.lookupError) return { data: null, error: fake.lookupError }
                  const hits = fake.rows.filter((r) => r.wallet === wallet && terms.some((t) => ilike(r.signature, t)))
                  fake.lookups.push({ filter, wallet, found: hits.length })
                  return { data: hits.slice(0, n).map((r) => ({ id: r.id })), error: null }
                },
              }),
            }),
          }),
        }),
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
  fake.lookups.length = 0
  fake.barrier = null
  fake.lookupError = null
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
    expect(b.json.error).toBe('Order already exists')
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].order_hash).toBe(hash)
  })

  it.each([
    ['another order\'s hash', WRONG_A, WRONG_A],
    ['not a hash at all', 'not-a-hash', '<string len 10>'],
  ])('wrong hash text (%s) is stored as the server hash and logged once, without the signature', async (_label, text, callerHash) => {
    const { body, hash } = await signedDca(3)
    const res = await post({ ...body, orderHash: text })
    expect(res.status).toBe(201)
    expect(res.json.order?.order_hash).toBe(hash)
    expect(fake.rows.map((r) => r.order_hash)).toEqual([hash])
    expect(mismatchLines()).toEqual([{
      event: 'orders_order_hash_mismatch', mode: 'observe', outcome: 'stored', chainId: 8453, version: 3, orderType: 'dca',
      serverHash: hash, callerHash,
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
    expect(mismatchLines()).toMatchObject([{ outcome: 'stored', version: 2, chainId: 1, serverHash: hash, callerHash: WRONG_B }])
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
      // [A86 S-4] CHANGED: the stored order_data is the SIGNED order (signedDca's orderData is exactly the signed fields
      // in the client's shapes), never the caller's bent copy firstData. The first post's differs line names the bent keys.
      expect(fake.rows[0]).toMatchObject({ order_hash: hash })
      expect(fake.rows[0].order_data).toEqual(orderData)
      expect(fake.rows[0].order_data).not.toEqual(firstData)
      const differs = warn.mock.calls
        .map((c: unknown[]) => { try { return JSON.parse(String(c[0])) } catch { return null } })
        .filter((x: Record<string, unknown> | null) => x?.event === 'orders_order_data_differs')
      expect(differs[0]).toMatchObject({ outcome: 'stored', serverHash: hash, otherKeys: 0 })
      expect(new Set(differs[0].fields)).toEqual(new Set(Object.keys(first)))
    },
  )
})

// [A86 S-3] Rows written before PR #708 carry the caller's order_hash text, which unique_order_hash cannot match to
// the server hash. The signature column can: the route looks it up before the insert.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** Other texts of one signature that recover the same signer, computed here without the server helper. */
function signatureVariants(sig: string): Record<string, string> {
  const r = sig.slice(2, 66)
  const s = BigInt(`0x${sig.slice(66, 130)}`)
  const v = parseInt(sig.slice(130), 16)
  if (v !== 27 && v !== 28) throw new Error('fixture: viem signs with v 27/28')
  const word = (x: bigint) => x.toString(16).padStart(64, '0')
  const byte = (x: number) => x.toString(16).padStart(2, '0')
  const other = v === 27 ? 28 : 27
  return {
    'upper-case hex': `0x${sig.slice(2).toUpperCase()}`,
    'v − 27': `0x${r}${word(s)}${byte(v - 27)}`,
    'the high-s twin': `0x${r}${word(SECP256K1_N - s)}${byte(other)}`,
    'the high-s twin, v − 27': `0x${r}${word(SECP256K1_N - s)}${byte(other - 27)}`,
  }
}

/** A row as the pre-#708 route wrote it: the caller's order_hash text, the signature as sent. */
function legacyRow(body: Record<string, unknown>, orderHash: string, signature = String(body.signature)) {
  return {
    id: 'legacy-1', wallet: account.address.toLowerCase(), order_type: 'dca', token_in: TOKEN_IN, token_out: TOKEN_OUT,
    signature, order_hash: orderHash, order_data: body.orderData, chain_id: body.chainId, status: 'active',
  }
}

const LEGACY_TEXTS: [string, (h: string) => string][] = [
  ['a UUID', () => '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f8a9b0c'],
  ['upper-case hex', (h) => `0x${h.slice(2).toUpperCase()}`],
  ['a 0X prefix, upper case', (h) => h.toUpperCase()],
  ['a 0X prefix, lower case', (h) => `0X${h.slice(2)}`],
  ['no 0x prefix', (h) => h.slice(2)],
  ['another order\'s hash', () => WRONG_A],
  ['the exact server hash (control: refused before the fix too)', (h) => h],
]

describe('one signed order is stored once, rows written before the fix included [A86 S-3]', () => {
  it.each(([3, 2] as const).flatMap((v) => LEGACY_TEXTS.map(([label, spell]) => [v, label, spell] as const)))(
    'v%s, a pre-existing row whose order_hash is %s + a re-post of its signed order: 409, one row, the old row untouched',
    async (version, _label, spell) => {
      const { body, hash } = await signedDca(version)
      const old = legacyRow(body, spell(hash))
      fake.rows.push({ ...old })
      const res = await post(body)
      expect(res.status).toBe(409)
      expect(res.json.error).toBe('Order already exists')
      expect(fake.rows).toEqual([old])
    },
  )

  it.each(['upper-case hex', 'v − 27', 'the high-s twin', 'the high-s twin, v − 27'])(
    'the same signature as %s: a re-post refused against a pre-existing row, and the other way round',
    async (variant) => {
      const { body } = await signedDca(3)
      const other = signatureVariants(String(body.signature))[variant]
      const uuid = '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f8a9b0c'

      fake.rows.push(legacyRow(body, uuid))
      const a = await post({ ...body, signature: other })
      expect(a.status).toBe(409)
      expect(fake.rows).toHaveLength(1)

      fake.rows.length = 0
      fake.rows.push(legacyRow(body, uuid, other))
      const b = await post(body)
      expect(b.status).toBe(409)
      expect(b.json.error).toBe('Order already exists')
      expect(fake.rows).toHaveLength(1)
      expect(fake.rows[0].signature).toBe(other)
    },
  )

  it('the lookup sends the 4 texts of the signature, lower case, each 0x + 130 hex (no pattern character)', async () => {
    const { body } = await signedDca(3)
    const v = signatureVariants(String(body.signature))
    expect((await post(body)).status).toBe(201)
    expect(fake.lookups).toHaveLength(1)
    const terms = fake.lookups[0].filter.split(',')
    expect(terms.every((t) => /^signature\.ilike\.0x[0-9a-f]{130}$/.test(t))).toBe(true)
    expect(new Set(terms.map((t) => t.slice('signature.ilike.'.length)))).toEqual(new Set([
      String(body.signature).toLowerCase(), v['v − 27'], v['the high-s twin'], v['the high-s twin, v − 27'],
    ]))
  })

  it.each([
    ['the same text', (sig: string) => sig],
    ['two encodings (v and v − 27)', (sig: string) => signatureVariants(sig)['v − 27']],
  ])('two concurrent first posts of one order (%s), both past the lookup: one 201, one 409, one row', async (_label, second) => {
    const { body, hash } = await signedDca(3)
    let release!: () => void
    const open = new Promise<void>((resolve) => { release = resolve })
    fake.barrier = { needed: 2, arrived: 0, release, open }
    const [a, b] = await Promise.all([post(body), post({ ...body, signature: second(String(body.signature)) })])
    // Both requests were at the lookup before either inserted, and neither found a row: the race, not the lookup.
    expect(fake.lookups.map((l) => l.found)).toEqual([0, 0])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect([a, b].find((x) => x.status === 409)!.json.error).toBe('Order already exists (duplicate hash)')
    expect(fake.rows.map((r) => r.order_hash)).toEqual([hash])
  })

  it('a lookup that cannot answer fails closed: 503, nothing written', async () => {
    const { body } = await signedDca(3)
    fake.lookupError = { message: 'connection reset' }
    const res = await post(body)
    expect(res.status).toBe(503)
    expect(res.json.error).toBe('Could not check for an existing order. Try again shortly.')
    expect(fake.rows).toHaveLength(0)
  })
})

// [A86 S-7] The observe line is written once the outcome is known, says what that outcome was, and carries the caller's
// text only when it has the shape of a hash.
describe('the orders_order_hash_mismatch line [A86 S-7]', () => {
  const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

  it.each([
    ['as signed (0x, lower case)', (sig: string) => sig, 132],
    ['in upper case', (sig: string) => `0x${sig.slice(2).toUpperCase()}`, 132],
    ['without 0x', (sig: string) => sig.slice(2), 130],
  ])('a caller that puts its signature %s in orderHash leaves no fragment of it in console output', async (_label, spell, len) => {
    const { body, hash } = await signedDca(3)
    const others = METHODS.filter((m) => m !== 'warn').map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    try {
      const res = await post({ ...body, orderHash: spell(String(body.signature)) })
      expect(res.status).toBe(201)
      expect(mismatchLines()).toEqual([{
        event: 'orders_order_hash_mismatch', mode: 'observe', outcome: 'stored', chainId: 8453, version: 3, orderType: 'dca',
        serverHash: hash, callerHash: `<string len ${len}>`,
      }])
      const printed = [warn, ...others]
        .flatMap((spy) => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')))
        .join('\n')
        .toLowerCase()
      const sigHex = String(body.signature).slice(2).toLowerCase()
      const fragments = Array.from({ length: sigHex.length - 9 }, (_, i) => sigHex.slice(i, i + 10))
      expect(fragments.filter((f) => printed.includes(f))).toEqual([])
    } finally {
      for (const spy of others) spy.mockRestore()
    }
  })

  it('stored: the line is written after the insert (the row exists when it is logged), outcome "stored"', async () => {
    const { body, hash } = await signedDca(3)
    const rowsWhenLogged: number[] = []
    warn.mockImplementation(() => { rowsWhenLogged.push(fake.rows.length) })
    expect((await post({ ...body, orderHash: WRONG_A })).status).toBe(201)
    expect(rowsWhenLogged).toEqual([1])
    expect(mismatchLines()).toMatchObject([{ outcome: 'stored', serverHash: hash, callerHash: WRONG_A }])
  })

  it('a re-post refused with 409 logs outcome "exists" and names no row as stored by it', async () => {
    const { body, hash } = await signedDca(3)
    expect((await post(body)).status).toBe(201)
    expect(mismatchLines()).toEqual([])
    expect((await post({ ...body, orderHash: WRONG_B })).status).toBe(409)
    const [line] = mismatchLines()
    expect(line).toMatchObject({ outcome: 'exists', serverHash: hash, callerHash: WRONG_B })
    expect(line).not.toHaveProperty('storedHash')
    expect(fake.rows).toHaveLength(1)
  })

  it('a refused request (lookup cannot answer, 503) logs outcome "error"', async () => {
    const { body } = await signedDca(3)
    fake.lookupError = { message: 'connection reset' }
    expect((await post({ ...body, orderHash: 'x'.repeat(200) })).status).toBe(503)
    expect(mismatchLines()).toMatchObject([{ outcome: 'error', callerHash: '<string len 200>' }])
  })
})
