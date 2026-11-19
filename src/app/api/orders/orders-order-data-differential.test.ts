// @vitest-environment node
/**
 * [fix/server-builds-order-data, A86 S-4/S-5] Differential: for 300 seeded VALID orders (Limit, Take-Profit and DCA; v3 on
 * Base and Arbitrum, v2 on Base and Mainnet), each signed by its own key and POSTed to the REAL route, the struct the
 * KEEPER builds from the stored order_data (its routing call and struct literal sliced from the shipped executor.js,
 * resolveExecutorRouting and resolvePinnedRouterData imported) hashes to the stored order_hash, and the stored signature
 * recovers the owner under the executor the keeper routes it to. The bodies vary the way callers do: the official client
 * shape, no orderData, extra keys, a copy bent in a field M-07 does not compare, other address spellings, a wrong
 * orderHash text. What the keeper built is rendered into contracts/order-engine/test/OrderDataVectors.sol, where
 * OrderDataDifferential.t.sol checks the executors' own getOrderHash on byte-identical structs (scripts/orders/order-data-vectors.ts).
 */
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { encodeAbiParameters, getAddress, keccak256, recoverTypedDataAddress, toBytes, zeroHash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

vi.hoisted(() => {
  vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', '0x686b4f812291F4De238E59ED00BA6dD6129e60a0')
  vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459')
  vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS', '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130')
})
vi.mock('@supabase/supabase-js', () => import('@/test-utils/orders-memory-db'))
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
import { db } from '@/test-utils/orders-memory-db'
import { asStored, keeperOrderStruct, keeperRoute } from '@/test-utils/keeper-order-struct'
import { resolvePinnedRouterData } from '../../../../contracts/order-engine/executor/pinned-route.js'
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES, ORDER_V3_TYPE_STRING } from '@/lib/order-engine/types'
import { computeOrderHash } from '@/lib/order-engine/order-hash'
import { getWhitelistedRouters } from '@/lib/order-engine/config'
import {
  DIFFERENTIAL_SETS, chainStep, orderFields, renderOrderDataVectors, type OrderFields, type SetResult,
} from '../../../../scripts/orders/order-data-vectors'

const ROOT = resolve(__dirname, '../../../..')
const NOW_MS = Date.UTC(2026, 10, 18, 12, 0, 0)
const NOW_S = BigInt(Math.floor(NOW_MS / 1000))
const V2_TYPE_STRING =
  'Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 orderType,' +
  'uint8 condition,uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,' +
  'bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)'
const LABEL = ['limit', 'stop_loss', 'dca'] as const
/** Signed fields M-07 does not compare: a copy bent in one of them is accepted (and logged), never stored. */
const BENDABLE: [string, (v: unknown) => unknown][] = [
  ['orderType', (v) => (Number(v) === 2 ? 0 : 2)], ['condition', (v) => 1 - Number(v)], ['targetPrice', () => '123456789'],
  ['priceFeed', () => '0x00000000000000000000000000000000000000f1'], ['expiry', (v) => String(BigInt(String(v)) + 7n)],
  ['nonce', () => '424242'], ['dcaInterval', () => '61'], ['dcaTotal', () => '364'],
]

/** keccak256(abi.encode(TYPEHASH, fields...)) — the contracts' getOrderHash, written out independently. */
function contractStyleHash(v3: boolean, m: Record<string, unknown>): Hex {
  const head = [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] as const
  const tail = [
    { type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' },
  ] as const
  const n = (k: string) => BigInt(m[k] as bigint)
  const a = (k: string) => String(m[k]).toLowerCase()
  const hv = [keccak256(toBytes(v3 ? ORDER_V3_TYPE_STRING : V2_TYPE_STRING)), a('owner'), a('tokenIn'), a('tokenOut'), n('amountIn'), n('minAmountOut')]
  const tv = [Number(m.orderType), Number(m.condition), n('targetPrice'), a('priceFeed'), n('expiry'), n('nonce'), a('router'), m.routerDataHash, n('dcaInterval'), n('dcaTotal')]
  return v3
    ? keccak256(encodeAbiParameters([...head, { type: 'uint16' }, ...tail] as never, [...hv, Number(m.maxSlippageBps), ...tv] as never))
    : keccak256(encodeAbiParameters([...head, ...tail] as never, [...hv, ...tv] as never))
}

const spell = (a: string, checksum: boolean) => (checksum ? getAddress(a) : a.toLowerCase())

/** The POST body for order `i` (variant by i): the client's createOrderInSupabase shape, then the variant applied. */
function bodyFor(i: number, f: OrderFields, owner: string, signature: Hex, hash: Hex, chainId: number, v3: boolean) {
  const cs = i % 2 === 1
  const message = {
    owner: spell(owner, cs), tokenIn: spell(f.tokenIn, cs), tokenOut: spell(f.tokenOut, cs), router: spell(f.router, cs),
    priceFeed: spell(f.priceFeed, cs),
  }
  const official: Record<string, unknown> = {
    owner: message.owner, tokenIn: message.tokenIn, tokenOut: message.tokenOut,
    amountIn: f.amountIn.toString(), minAmountOut: f.minAmountOut.toString(),
    ...(v3 ? { maxSlippageBps: f.maxSlippageBps } : {}),
    orderType: f.orderType, condition: f.condition, targetPrice: f.targetPrice.toString(), priceFeed: message.priceFeed,
    expiry: f.expiry.toString(), nonce: f.nonce.toString(), router: message.router, routerDataHash: f.routerDataHash,
    ...(f.routerData ? { routerData: f.routerData } : {}),
    dcaInterval: f.dcaInterval.toString(), dcaTotal: f.dcaTotal.toString(),
  }
  const variant = i % 10
  let orderData: Record<string, unknown> | undefined = official
  let kind = 'official'
  if (variant === 3 && !(v3 && f.kind !== 2)) { orderData = undefined; kind = 'absent' }
  if (variant === 5) { orderData = { ...official, tokenInSymbol: 'X', tokenOutDecimals: 6, note: 'n' }; kind = 'extra keys' }
  if (variant === 7) {
    const [key, bend] = BENDABLE[Math.floor(i / 10) % BENDABLE.length]
    orderData = { ...official, [key]: bend(official[key]) }
    kind = 'bent'
  }
  if (variant === 9) {
    orderData = { ...official, owner: spell(owner, !cs), tokenIn: spell(f.tokenIn, !cs), router: spell(f.router, !cs) }
    kind = 'other spelling'
  }
  const body: Record<string, unknown> = {
    wallet: message.owner, chainId, tokenIn: message.tokenIn, tokenOut: message.tokenOut, router: message.router, signature,
    orderHash: i % 4 === 0 ? `0x${'ab'.repeat(32)}` : hash,
    amountIn: f.amountIn.toString(), minAmountOut: f.minAmountOut.toString(), tokenOutDecimals: 18,
    tokenInSymbol: 'TIN', tokenOutSymbol: 'TOUT', tokenInDecimals: 18,
    orderType: LABEL[f.orderType], priceCondition: f.condition === 0 ? 'above' : 'below',
    targetPrice: f.targetPrice.toString(), priceFeed: message.priceFeed, expiry: Number(f.expiry), nonce: Number(f.nonce),
    routerDataHash: f.routerDataHash, dcaInterval: Number(f.dcaInterval), dcaTotal: Number(f.dcaTotal),
    ...(v3 ? { maxSlippageBps: f.maxSlippageBps } : {}),
    ...(orderData ? { orderData } : {}),
  }
  return { body, message, kind }
}

async function post(body: unknown) {
  const res = await POST(new NextRequest('http://localhost/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: (await res.json()) as { order?: Record<string, unknown>; error?: string } }
}

const network = vi.fn(async (input: unknown) => { throw new Error(`network access in a unit test: ${String(input)}`) })
beforeEach(() => {
  db.reset()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubEnv('SUPABASE_URL', 'https://fake.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role-key')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  network.mockClear()
  vi.stubGlobal('fetch', network)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  expect(network).not.toHaveBeenCalled()
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('order_data differential: 300 seeded valid orders, the keeper\'s own builder, the contracts\' getOrderHash [A86 S-4/S-5]', () => {
  it('every stored row executes as the signed order: keeper struct hash = order_hash, signature recovers the owner; vectors for Foundry', async () => {
    const results: SetResult[] = []
    const seen = { total: 0, byKey: {} as Record<string, number>, byVariant: {} as Record<string, number>, pinnedReplays: 0 }
    for (const set of DIFFERENTIAL_SETS) {
      const v3 = set.version === 3
      const routers = Object.values(getWhitelistedRouters(set.chainId)).map((r) => r.address as `0x${string}`)
      const types = v3 ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES
      const domain = { name: 'TeraSwapOrderExecutor', version: String(set.version), chainId: set.chainId, verifyingContract: set.executor }
      const stored: Hex[] = []
      let digest: Hex = zeroHash
      for (let i = 0; i < set.count; i++) {
        const f = orderFields(set, i, routers, NOW_S)
        const account = privateKeyToAccount(f.privateKey)
        const signedMessage = {
          owner: account.address, tokenIn: f.tokenIn, tokenOut: f.tokenOut, amountIn: f.amountIn, minAmountOut: f.minAmountOut,
          ...(v3 ? { maxSlippageBps: f.maxSlippageBps } : {}),
          orderType: f.orderType, condition: f.condition, targetPrice: f.targetPrice, priceFeed: f.priceFeed, expiry: f.expiry,
          nonce: f.nonce, router: f.router, routerDataHash: f.routerDataHash, dcaInterval: f.dcaInterval, dcaTotal: f.dcaTotal,
        }
        const signature = await account.signTypedData({ domain, types, primaryType: 'Order', message: signedMessage as never })
        const hash = contractStyleHash(v3, signedMessage)
        const { body, kind } = bodyFor(i, f, account.address, signature, hash, set.chainId, v3)
        const where = `${set.key}[${i}] (${LABEL[f.orderType]}, ${kind})`

        db.reset()
        const res = await post(body)
        expect(res.status, `${where}: ${res.json.error}`).toBe(201)
        const row = db.rows[0]
        expect(row.order_hash, where).toBe(hash)
        expect(Object.hasOwn(row.order_data as object, 'maxSlippageBps'), where).toBe(v3)

        // The keeper, on this chain, with this row.
        const od = asStored(row.order_data)
        const routing = keeperRoute(od, set.chainId)
        expect([routing.ok, routing.isV3, routing.execAddress], where).toEqual([true, v3, set.executor])
        const struct = keeperOrderStruct(od, routing.isV3)
        expect(computeOrderHash({ types, message: struct }), where).toBe(hash)
        expect(contractStyleHash(v3, struct), where).toBe(hash)
        const recovered = await recoverTypedDataAddress({ domain, types, primaryType: 'Order', message: struct as never, signature: row.signature as Hex })
        expect(recovered, where).toBe(account.address)
        const pinned = resolvePinnedRouterData({
          orderType: String(row.order_type), orderData: od as object, signedRouterDataHash: String(struct.routerDataHash),
        })
        if (f.routerData && kind !== 'absent') {
          // The pinned calldata the caller sent hashes to the signed hash: stored, and the keeper replays it.
          expect([pinned.ok, pinned.routerData], where).toEqual([true, f.routerData])
          seen.pinnedReplays += 1
        } else if (f.routerData) {
          // No orderData, so no calldata to replay: the keeper refuses the pinned route (never rebuilds one), as before.
          expect([pinned.pinned, pinned.ok], where).toEqual([true, false])
        }

        stored.push(row.order_hash as Hex)
        digest = chainStep(digest, types.Order, struct)
        seen.total += 1
        const k = `${set.key}:${LABEL[f.orderType]}`
        seen.byKey[k] = (seen.byKey[k] ?? 0) + 1
        seen.byVariant[kind] = (seen.byVariant[kind] ?? 0) + 1
      }
      results.push({ set, routers, stored, keeperDigest: digest })
    }

    expect(seen.total).toBe(300)
    // Every type on every set that takes it: v3 Limit/TP/DCA on Base, v3 DCA on Arbitrum, v2 Limit/TP/DCA on Base and Mainnet.
    for (const set of DIFFERENTIAL_SETS) for (const k of set.kinds) expect(seen.byKey[`${set.key}:${LABEL[k]}`], `${set.key} ${LABEL[k]}`).toBeGreaterThan(0)
    for (const v of ['official', 'absent', 'extra keys', 'bent', 'other spelling']) expect(seen.byVariant[v], v).toBeGreaterThan(0)
    expect(seen.pinnedReplays).toBeGreaterThan(0)

    await expect(renderOrderDataVectors(results, NOW_S)).toMatchFileSnapshot(resolve(ROOT, 'contracts/order-engine/test/OrderDataVectors.sol'))
  }, 120_000)
})
