// @vitest-environment node
/**
 * [fix/server-builds-order-data] POST /api/orders BUILDS the stored order_data (A86 S-4/S-5), and A89 R2-1 / R2-4.
 *
 * REAL EIP-712 signatures, the REAL route, recoverTypedDataAddress and order-engine config; only the network edges are
 * stubbed (an in-memory `orders` table, KV, freeze flag, token presence, price/decimals reads). What the keeper does with
 * a stored row is run from the keeper's own code (src/test-utils/keeper-order-struct.ts: the routing call and the struct
 * literal sliced from the shipped executor.js, resolveExecutorRouting imported).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import {
  encodeAbiParameters, keccak256, recoverTypedDataAddress, toBytes, zeroAddress, zeroHash, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

vi.hoisted(() => {
  // config.ts reads these at module load: the production addresses (docs/DEPLOYMENTS.md), stubbed, never read from env.
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
import { asStored, keeperOrderStruct, keeperRoute, KEEPER_EXECUTORS } from '@/test-utils/keeper-order-struct'
import { ORDER_EIP712_TYPES, ORDER_V3_EIP712_TYPES, ORDER_V3_TYPE_STRING } from '@/lib/order-engine/types'
import { computeOrderHash } from '@/lib/order-engine/order-hash'
import { getWhitelistedRouters } from '@/lib/order-engine/config'

// Derived at run time: no key material in the source.
const account = privateKeyToAccount(keccak256(toBytes('fix/server-builds-order-data route test')))
const NOW_MS = Date.UTC(2026, 10, 18, 12, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const V2_TYPE_STRING =
  'Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 orderType,' +
  'uint8 condition,uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,' +
  'bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)'

type Kind = 'dca' | 'limit'
interface SignedOrder {
  version: 2 | 3
  chainId: number
  /** The signed message, typed as the contract takes it. */
  message: Record<string, bigint | number | string>
  /** The order_data the official client sends for it (useOrderEngine.ts createOrder): the signed fields. */
  orderData: Record<string, string | number>
  body: Record<string, unknown>
  hash: Hex
  signature: Hex
}

const word = (label: string) => BigInt(keccak256(toBytes(label)))
const addr = (label: string) => `0x${(word(label) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`

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

function domainOf(version: 2 | 3, chainId: number, verifyingContract: string) {
  return { name: 'TeraSwapOrderExecutor', version: String(version), chainId, verifyingContract: verifyingContract as Hex }
}

/** An order signed the way the client signs it, and the POST body the client sends (createOrderInSupabase). */
async function signOrder(o: { version: 2 | 3; chainId: number; kind: Kind; salt: string }): Promise<SignedOrder> {
  const { version, chainId, kind, salt } = o
  const v3 = version === 3
  const dca = kind === 'dca'
  const executor = v3 ? KEEPER_EXECUTORS[chainId].v3 : KEEPER_EXECUTORS[chainId].v2
  const router = dca ? addr(`router ${salt}`) : Object.values(getWhitelistedRouters(chainId))[0].address
  const routerData = dca ? undefined : (`0x12345678${keccak256(toBytes(`calldata ${salt}`)).slice(2)}` as Hex)
  const message: Record<string, bigint | number | string> = {
    owner: account.address, tokenIn: addr(`in ${salt}`), tokenOut: addr(`out ${salt}`),
    amountIn: 10n ** 18n + (word(`amount ${salt}`) % 10n ** 18n), minAmountOut: 100n * 10n ** 18n,
    ...(v3 ? { maxSlippageBps: 300 } : {}),
    orderType: dca ? 2 : 0, condition: dca ? 0 : 1,
    targetPrice: dca ? 0n : 2_500n * 10n ** 8n, priceFeed: dca ? zeroAddress : addr(`feed ${salt}`),
    expiry: BigInt(NOW_S + 7 * 86400), nonce: word(`nonce ${salt}`) % 2n ** 31n, router,
    routerDataHash: routerData ? keccak256(routerData) : zeroHash,
    dcaInterval: dca ? 3600n : 0n, dcaTotal: dca ? 3n : 1n,
  }
  const types = v3 ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES
  const signature = await account.signTypedData({
    domain: domainOf(version, chainId, executor) as never, types, primaryType: 'Order', message: message as never,
  })
  const hash = contractStyleHash(v3, message)
  const orderData: Record<string, string | number> = {
    owner: account.address, tokenIn: String(message.tokenIn), tokenOut: String(message.tokenOut),
    amountIn: String(message.amountIn), minAmountOut: String(message.minAmountOut),
    ...(v3 ? { maxSlippageBps: 300 } : {}),
    orderType: Number(message.orderType), condition: Number(message.condition),
    targetPrice: String(message.targetPrice), priceFeed: String(message.priceFeed), expiry: String(message.expiry),
    nonce: String(message.nonce), router, routerDataHash: String(message.routerDataHash),
    dcaInterval: String(message.dcaInterval), dcaTotal: String(message.dcaTotal),
  }
  const body: Record<string, unknown> = {
    wallet: account.address, chainId, tokenIn: message.tokenIn, tokenOut: message.tokenOut, router, signature, orderHash: hash,
    amountIn: String(message.amountIn), minAmountOut: String(message.minAmountOut), tokenOutDecimals: 18,
    tokenInSymbol: 'TIN', tokenOutSymbol: 'TOUT', tokenInDecimals: 18,
    orderType: dca ? 'dca' : 'limit', priceCondition: dca ? 'above' : 'below',
    targetPrice: String(message.targetPrice), priceFeed: message.priceFeed, expiry: Number(message.expiry),
    nonce: Number(message.nonce), routerDataHash: message.routerDataHash,
    dcaInterval: Number(message.dcaInterval), dcaTotal: Number(message.dcaTotal),
    ...(v3 ? { maxSlippageBps: 300 } : {}),
    orderData: { ...orderData, ...(routerData ? { routerData } : {}) },
  }
  return { version, chainId, message, orderData, body, hash, signature }
}

async function post(body: unknown) {
  const res = await POST(new NextRequest('http://localhost/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: (await res.json()) as { order?: Record<string, unknown>; error?: string } }
}

let warn: ReturnType<typeof vi.spyOn>
const network = vi.fn(async (input: unknown) => { throw new Error(`network access in a unit test: ${String(input)}`) })

function logged(event: string): Record<string, unknown>[] {
  return warn.mock.calls
    .map((c: unknown[]) => { try { return JSON.parse(String(c[0])) } catch { return null } })
    .filter((x: Record<string, unknown> | null): x is Record<string, unknown> => x?.event === event)
}

/** What the keeper does with a stored row on its chain: route it, build the struct, and what that struct is. */
async function keeperView(row: Record<string, unknown>, chainId: number) {
  const od = asStored(row.order_data)
  const routing = keeperRoute(od, chainId)
  const struct = keeperOrderStruct(od, routing.isV3)
  const types = routing.isV3 ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES
  const recovered = routing.ok
    ? await recoverTypedDataAddress({
      domain: domainOf(routing.isV3 ? 3 : 2, chainId, String(routing.execAddress)) as never,
      types, primaryType: 'Order', message: struct as never, signature: row.signature as Hex,
    })
    : null
  return {
    version: routing.isV3 ? 3 : 2,
    execAddress: routing.execAddress,
    structHash: computeOrderHash({ types, message: struct }),
    contractHash: contractStyleHash(routing.isV3, struct),
    recovered,
  }
}

beforeEach(() => {
  db.reset()
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

// ── [A86 S-4/S-5] The auditor's 11 bent orderData cases (A86 probe "checks 2+9", DCA orders, sets as the auditor ran them) ──
const BENT: [string, 'V3_BASE' | 'V2_MAINNET' | 'V2_BASE', (od: Record<string, unknown>) => Record<string, unknown>, string][] = [
  ['orderType', 'V3_BASE', (od) => ({ ...od, orderType: od.orderType === 2 ? 0 : 2 }), 'orderType'],
  ['condition', 'V2_MAINNET', (od) => ({ ...od, condition: od.condition === 0 ? 1 : 0 }), 'condition'],
  ['targetPrice', 'V3_BASE', (od) => ({ ...od, targetPrice: '123456789' }), 'targetPrice'],
  ['priceFeed', 'V2_MAINNET', (od) => ({ ...od, priceFeed: '0x00000000000000000000000000000000000000f1' }), 'priceFeed'],
  ['expiry', 'V3_BASE', (od) => ({ ...od, expiry: String(NOW_S + 7) }), 'expiry'],
  ['nonce', 'V2_MAINNET', (od) => ({ ...od, nonce: '424242' }), 'nonce'],
  ['dcaInterval', 'V3_BASE', (od) => ({ ...od, dcaInterval: '61' }), 'dcaInterval'],
  ['dcaTotal', 'V2_MAINNET', (od) => ({ ...od, dcaTotal: '364' }), 'dcaTotal'],
  ['routerDataHash (body ZeroHash)', 'V3_BASE', (od) => ({ ...od, routerDataHash: `0x${'77'.repeat(32)}` }), 'routerDataHash'],
  ['maxSlippageBps on a v2 order (keeper routed v3)', 'V2_BASE', (od) => ({ ...od, maxSlippageBps: 300 }), 'maxSlippageBps'],
  ['maxSlippageBps as string "300" top-level + v2 sig', 'V2_BASE', (od) => ({ ...od, maxSlippageBps: '300' }), 'maxSlippageBps'],
]
const SET = { V3_BASE: [3, 8453], V2_MAINNET: [2, 1], V2_BASE: [2, 8453] } as const

describe('bent orderData: the stored order_data is the SIGNED order and the keeper executes the signed order [A86 S-4/S-5]', () => {
  it.each(BENT)('%s (%s): 201 as before; order_data = signed fields; keeper routes the signed version; struct hash = order_hash; signature recovers the owner', async (name, set, bend, key) => {
    const [version, chainId] = SET[set]
    const s = await signOrder({ version, chainId, kind: 'dca', salt: `bent ${name}` })
    const body: Record<string, unknown> = { ...s.body, orderData: bend(s.body.orderData as Record<string, unknown>) }
    if (name.includes('as string')) body.maxSlippageBps = '300'
    if (name.startsWith('routerDataHash')) delete body.routerDataHash

    const res = await post(body)
    expect(res.status).toBe(201)
    expect(db.rows).toHaveLength(1)
    const row = db.rows[0]
    expect(row.order_hash).toBe(s.hash)
    expect(row.order_data).toEqual(s.orderData)
    expect(Object.hasOwn(row.order_data as object, 'maxSlippageBps')).toBe(version === 3)

    const k = await keeperView(row, chainId)
    expect(k.version).toBe(version)
    expect(k.execAddress).toBe(version === 3 ? KEEPER_EXECUTORS[chainId].v3 : KEEPER_EXECUTORS[chainId].v2)
    expect(k.structHash).toBe(s.hash)
    expect(k.contractHash).toBe(s.hash)
    expect(k.recovered).toBe(account.address)

    expect(logged('orders_order_data_differs')).toEqual([{
      event: 'orders_order_data_differs', outcome: 'stored', chainId, version, orderType: 'dca', serverHash: s.hash,
      fields: [key], otherKeys: 0,
    }])
  })
})

describe('what the server builds, key by key [A86 S-4, Step 0]', () => {
  it('the official client shape is stored unchanged and nothing is logged (v3 DCA, v3 Limit with routerData, v2 DCA)', async () => {
    for (const [version, chainId, kind] of [[3, 8453, 'dca'], [3, 8453, 'limit'], [2, 1, 'dca'], [3, 42161, 'dca']] as const) {
      db.reset()
      const s = await signOrder({ version, chainId, kind, salt: `official ${version} ${chainId} ${kind}` })
      expect((await post(s.body)).status).toBe(201)
      expect(db.rows[0].order_data).toEqual(s.body.orderData)
    }
    expect(logged('orders_order_data_differs')).toEqual([])
  })

  it('no orderData: built from the signed message (owner decision), every key named as differing', async () => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'absent' })
    const { orderData: _omit, ...body } = s.body
    expect((await post(body)).status).toBe(201)
    expect(db.rows[0].order_data).toEqual(s.orderData)
    const [line] = logged('orders_order_data_differs')
    expect(line.fields).toEqual(ORDER_V3_EIP712_TYPES.Order.map((f) => f.name))
    const k = await keeperView(db.rows[0], 8453)
    expect([k.version, k.structHash, k.recovered]).toEqual([3, s.hash, account.address])
  })

  it('the token symbols / decimals some callers add are dropped (owner decision); unknown keys are counted, never named', async () => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'extras' })
    const extras = { tokenInSymbol: 'X', tokenOutSymbol: 'Y', tokenInDecimals: 6, tokenOutDecimals: 8 }
    const secretKey = `0x${'ab'.repeat(65)}`
    const res = await post({ ...s.body, orderData: { ...(s.body.orderData as object), ...extras, [secretKey]: 1, note: 'n' } })
    expect(res.status).toBe(201)
    expect(db.rows[0].order_data).toEqual(s.orderData)
    expect(logged('orders_order_data_differs')).toMatchObject([{ fields: Object.keys(extras), otherKeys: 2 }])
    expect(warn.mock.calls.flat().join('\n')).not.toContain('abab')
  })

  it('values the keeper reads the same way are stored canonically: numbers as decimal strings, hex/extra text normalised by BigInt', async () => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'shapes' })
    // The body's uint fields in other spellings viem accepts (BigInt), the copy spelled like the body (M-07 compares
    // amountIn as text): the signature still recovers, and the stored copy is the decimal the keeper reads back.
    const hexAmount = `0x${BigInt(String(s.body.amountIn)).toString(16)}`
    const body = {
      ...s.body, amountIn: hexAmount, nonce: String(s.body.nonce), dcaTotal: '3',
      orderData: { ...(s.body.orderData as object), amountIn: hexAmount },
    }
    const res = await post(body)
    expect(res.status).toBe(201)
    expect(db.rows[0].order_data).toEqual(s.orderData)
    expect(logged('orders_order_data_differs')).toMatchObject([{ fields: ['amountIn'] }])
  })

  it('routerData is kept only when it hashes to the SIGNED routerDataHash: kept on a v2 Limit, dropped on a DCA and on a bad copy', async () => {
    const v2 = await signOrder({ version: 2, chainId: 8453, kind: 'limit', salt: 'v2 limit' })
    expect((await post(v2.body)).status).toBe(201)
    expect((db.rows[0].order_data as Record<string, unknown>).routerData).toBe((v2.body.orderData as Record<string, unknown>).routerData)

    db.reset()
    const bad = await signOrder({ version: 2, chainId: 8453, kind: 'limit', salt: 'v2 limit bad' })
    const badBody = { ...bad.body, orderData: { ...(bad.body.orderData as object), routerData: '0x1234567800' } }
    expect((await post(badBody)).status).toBe(201)
    expect(db.rows[0].order_data).toEqual(bad.orderData)
    expect(logged('orders_order_data_differs').at(-1)).toMatchObject({ fields: ['routerData'] })

    db.reset()
    const dca = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'dca with calldata' })
    expect((await post({ ...dca.body, orderData: { ...(dca.body.orderData as object), routerData: '0x12345678aa' } })).status).toBe(201)
    expect(db.rows[0].order_data).toEqual(dca.orderData)
  })
})

// ── [A89 R2-1, superseded by A95 S-1] A caller orderHash cut from the request's own signature leaves no fragment in the log ──
// R2-1 replaced an exact 64-hex window by `<signature fragment len N>`; A95 S-1 found a text MIXING signature hex with other
// hex still passed. The line now carries no caller text at all: the same six windows are `<hash-shaped>` + a digest.
describe('R2-1 (as of A95 S-1): a caller orderHash cut from the request\'s signature leaves no fragment in the log', () => {
  const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const
  const windows = (sig: Hex) => {
    const hex = sig.slice(2)
    const twinS = (SECP256K1_N - BigInt(`0x${hex.slice(64, 128)}`)).toString(16).padStart(64, '0')
    return [
      ['r', `0x${hex.slice(0, 64)}`],
      ['s', `0x${hex.slice(64, 128)}`],
      ['a middle window', `0x${hex.slice(33, 97)}`],
      ['the last 64 hex (end of s + v)', `0x${hex.slice(66)}`],
      ['r in upper case, no 0x', hex.slice(0, 64).toUpperCase()],
      ['s of the high-s twin', `0x${twinS}`],
    ] as const
  }

  it.each([0, 1, 2, 3, 4, 5])('window %i: callerHash is <hash-shaped> + digest; no 10-hex window of the signature (any of its 4 texts) is printed', async (i) => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: `r21 ${i}` })
    const [label, text] = windows(s.signature)[i]
    const others = METHODS.filter((m) => m !== 'warn').map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    try {
      const res = await post({ ...s.body, orderHash: text })
      expect(res.status, label).toBe(201)
      expect(logged('orders_order_hash_mismatch')).toEqual([{
        event: 'orders_order_hash_mismatch', mode: 'observe', outcome: 'stored', chainId: 8453, version: 3, orderType: 'dca',
        serverHash: s.hash, callerHash: '<hash-shaped>', callerHashDigest: keccak256(toBytes(text)).slice(2, 18),
      }])
      const printed = [warn, ...others].flatMap((spy) => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '))).join('\n').toLowerCase()
      const hex = s.signature.slice(2)
      const twin = `${hex.slice(0, 64)}${(SECP256K1_N - BigInt(`0x${hex.slice(64, 128)}`)).toString(16).padStart(64, '0')}`
      const leaked = [hex, twin].flatMap((h) => Array.from({ length: h.length - 9 }, (_, j) => h.slice(j, j + 10)).filter((w) => printed.includes(w)))
      expect(leaked).toEqual([])
    } finally {
      for (const spy of others) spy.mockRestore()
    }
  })

  it('a hash-shaped text that is NOT part of the signature is logged as a shape too, never as sent', async () => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'r21 control' })
    const other = `0x${'cd'.repeat(32)}`
    expect((await post({ ...s.body, orderHash: other })).status).toBe(201)
    expect(logged('orders_order_hash_mismatch')).toMatchObject([{ callerHash: '<hash-shaped>', callerHashDigest: keccak256(toBytes(other)).slice(2, 18) }])
    expect(JSON.stringify(logged('orders_order_hash_mismatch'))).not.toContain(other.slice(2))
  })
})

// ── [A89 R2-4] The lookup is scoped to the wallet; the A86b auditor's 240 re-posts are still refused ───────────────────
function encodings(sig: string): Record<string, string> {
  const r = sig.slice(2, 66)
  const s = BigInt(`0x${sig.slice(66, 130)}`)
  const v = parseInt(sig.slice(130), 16)
  const p = v === 27 || v === 0 ? 0 : 1
  const w = (x: bigint) => x.toString(16).padStart(64, '0')
  const b = (x: number) => x.toString(16).padStart(2, '0')
  const orig = sig.toLowerCase()
  let k = 0
  const mixed = `0x${orig.slice(2).split('').map((c) => (/[a-f]/.test(c) && k++ % 2 === 0 ? c.toUpperCase() : c)).join('')}`
  return {
    original: orig,
    'v-27': `0x${r}${w(s)}${b(p)}`,
    'high-s twin': `0x${r}${w(SECP256K1_N - s)}${b(27 + (1 - p))}`,
    'twin v-27': `0x${r}${w(SECP256K1_N - s)}${b(1 - p)}`,
    'upper-case hex': `0x${orig.slice(2).toUpperCase()}`,
    'mixed case': mixed,
  }
}
const LEGACY_TEXTS: [string, (h: string) => string][] = [
  ['UUID', () => '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f8a9b0c'],
  ['0x+UPPER', (h) => `0x${h.slice(2).toUpperCase()}`],
  ['0X+UPPER', (h) => h.toUpperCase()],
  ['0X+lower', (h) => `0X${h.slice(2)}`],
  ['no prefix', (h) => h.slice(2)],
  ['another hash', () => `0x${'ab'.repeat(32)}`],
  ['exact server hash (control)', (h) => h],
]
/** A row as the pre-#708 route wrote it (the A86b rig's legacyRow): wallet lower case (schema trigger), caller's hash text. */
function legacyRow(s: SignedOrder, orderHash: string, signature: string) {
  const b = s.body
  return {
    id: `legacy-${orderHash.slice(-6)}-${signature.slice(-8)}`, wallet: String(b.wallet).toLowerCase(),
    order_type: b.orderType, token_in: String(b.tokenIn).toLowerCase(), token_out: String(b.tokenOut).toLowerCase(),
    signature, order_hash: orderHash, order_data: b.orderData, chain_id: b.chainId, status: 'active',
  }
}

describe('R2-4: the signature lookup is scoped to the lower-cased wallet; the audit\'s 240 re-posts are all 409', () => {
  it('matrix A: 4 kinds × 7 legacy texts × 6 encodings of the re-post = 168, all 409, the old row untouched; every lookup scoped', async () => {
    let n = 0
    const statuses: Record<number, number> = {}
    for (const [version, chainId, kind] of [[2, 1, 'dca'], [3, 8453, 'dca'], [2, 8453, 'limit'], [3, 8453, 'limit']] as const) {
      const s = await signOrder({ version, chainId, kind, salt: `matrix A ${version} ${chainId} ${kind}` })
      for (const [, spell] of LEGACY_TEXTS) {
        for (const sig of Object.values(encodings(s.signature))) {
          db.reset()
          const old = legacyRow(s, spell(s.hash), s.signature)
          db.rows.push(structuredClone(old))
          const res = await post({ ...s.body, signature: sig })
          statuses[res.status] = (statuses[res.status] ?? 0) + 1
          expect(db.rows).toEqual([old])
          expect(db.lookups.map((l) => l.wallet)).toEqual([account.address.toLowerCase()])
          n += 1
        }
      }
    }
    expect(n).toBe(168)
    expect(statuses).toEqual({ 409: 168 })
  })

  it('matrix B: a row stored with encoding E1 (UUID hash), re-posted with E2: 2 kinds × 36 pairs = 72, all 409', async () => {
    let n = 0
    const statuses: Record<number, number> = {}
    for (const [version, chainId] of [[2, 8453], [3, 42161]] as const) {
      const s = await signOrder({ version, chainId, kind: 'dca', salt: `matrix B ${version} ${chainId}` })
      const enc = Object.values(encodings(s.signature))
      for (const e1 of enc) {
        for (const e2 of enc) {
          db.reset()
          db.rows.push(legacyRow(s, '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f8a9b0c', e1))
          const res = await post({ ...s.body, signature: e2 })
          statuses[res.status] = (statuses[res.status] ?? 0) + 1
          expect(db.rows).toHaveLength(1)
          n += 1
        }
      }
    }
    expect(n).toBe(72)
    expect(statuses).toEqual({ 409: 72 })
  })

  it('the wallet filter is the lower-cased body.wallet whatever its spelling', async () => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'wallet spelling' })
    expect((await post({ ...s.body, wallet: account.address.toLowerCase() })).status).toBe(201)
    expect((await post(s.body)).status).toBe(409)
    expect(db.lookups.map((l) => [l.wallet, l.found])).toEqual([
      [account.address.toLowerCase(), 0], [account.address.toLowerCase(), 1],
    ])
  })
})

// ── [A95 S-1] The mismatch line never contains caller-supplied text ────────────────────────────────────────────────────
// A89 R2-1 dropped a caller orderHash only when it was an exact 64-hex window of the request's own signature: a text that
// MIXES signature hex with other hex was logged as sent (callerHash). The line now carries the caller's value as a shape
// (<hash-shaped> / <string len N> / <type T>) and the first 16 hex of keccak256(text), never the text.
describe('A95 S-1: no caller text in the order-hash mismatch line', () => {
  const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const
  const digest16 = (text: string) => keccak256(toBytes(text)).slice(2, 18)
  /** The 4 texts of a signature that recover the same signer: given, v 0/1, and the high-s twin in both v spellings. */
  const fourTexts = (sig: string) => {
    const hex = sig.slice(2).toLowerCase()
    const twin = (SECP256K1_N - BigInt(`0x${hex.slice(64, 128)}`)).toString(16).padStart(64, '0')
    const p = parseInt(hex.slice(128), 16) % 2 // 27 → 0, 28 → 1 (and 0/1)
    const b = (x: number) => x.toString(16).padStart(2, '0')
    return [hex, `${hex.slice(0, 128)}${b(p)}`, `${hex.slice(0, 64)}${twin}${b(27 + 1 - p)}`, `${hex.slice(0, 64)}${twin}${b(1 - p)}`]
  }
  /** Every 8-hex window of any of the 4 texts that appears in `printed`. */
  const leakedRuns = (sig: string, printed: string) => {
    const lower = printed.toLowerCase()
    return fourTexts(sig).flatMap((h) => Array.from({ length: h.length - 7 }, (_, j) => h.slice(j, j + 8)).filter((w) => lower.includes(w)))
  }
  /** Everything the route printed through any console method. */
  function spyAll() {
    const spies = METHODS.map((m) => (m === 'warn' ? warn : vi.spyOn(console, m).mockImplementation(() => {})))
    return {
      printed: () => spies.flatMap((spy) => spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '))).join('\n'),
      clear: () => { for (const spy of spies) spy.mockClear() },
      restore: () => { for (const spy of spies) if (spy !== warn) spy.mockRestore() },
    }
  }
  const OTHER_HEX = 'f0e1d2c3b4a5968778695a4b3c2d1e0f'

  it.each([
    ['0x + 60 hex of the signature + ffff', (hex: string) => `0x${hex.slice(10, 70)}ffff`],
    ['32 hex of r + 32 other hex', (hex: string) => `0x${hex.slice(0, 32)}${OTHER_HEX}`],
    ['32 other hex + 32 hex of s', (hex: string) => `0x${OTHER_HEX}${hex.slice(64, 96)}`],
  ])('the audit\'s shape "%s": stored 201, line = shape + digest, no 8-hex run of the signature in any console line', async (_label, build) => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: `a95 s1 ${_label}` })
    const text = build(s.signature.slice(2))
    const all = spyAll()
    try {
      expect((await post({ ...s.body, orderHash: text })).status).toBe(201)
      expect(logged('orders_order_hash_mismatch')).toEqual([{
        event: 'orders_order_hash_mismatch', mode: 'observe', outcome: 'stored', chainId: 8453, version: 3, orderType: 'dca',
        serverHash: s.hash, callerHash: '<hash-shaped>', callerHashDigest: digest16(text),
      }])
      expect(leakedRuns(s.signature, all.printed())).toEqual([])
      expect(all.printed()).not.toContain(text.slice(2, 22))
    } finally {
      all.restore()
    }
  })

  it('every kind of caller value: a shape and a digest, the text itself nowhere', async () => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'a95 s1 kinds' })
    const CASES: [string, unknown, string, string | null][] = [
      ['another hash', `0x${'cd'.repeat(32)}`, '<hash-shaped>', digest16(`0x${'cd'.repeat(32)}`)],
      ['0X + upper case', `0X${'AB'.repeat(32)}`, '<hash-shaped>', digest16(`0X${'AB'.repeat(32)}`)],
      ['no prefix', 'ab'.repeat(32), '<hash-shaped>', digest16('ab'.repeat(32))],
      ['a UUID', '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f8a9b0c', '<string len 36>', digest16('3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f8a9b0c')],
      ['the whole signature', s.signature, '<string len 132>', digest16(s.signature)],
      ['a number', 42, '<type number>', null],
      ['an object', { a: 1 }, '<type object>', null],
      ['a boolean', true, '<type boolean>', null],
    ]
    for (const [label, value, shape, digest] of CASES) {
      db.reset()
      warn.mockClear()
      const res = await post({ ...s.body, orderHash: value })
      // orderHash: true / 42 / {} are truthy, so they pass the presence check as before; whatever status, the line is the same shape.
      expect([201, 400], label).toContain(res.status)
      if (res.status === 201) {
        expect(logged('orders_order_hash_mismatch'), label).toMatchObject([{ callerHash: shape, callerHashDigest: digest }])
      }
      const line = JSON.stringify(logged('orders_order_hash_mismatch'))
      if (typeof value === 'string' && value.length >= 20) expect(line, label).not.toContain(value.slice(0, 20).toLowerCase())
    }
  })

  it('a matching hash (any spelling) logs nothing; the exists and error outcomes carry the same shape + digest', async () => {
    const s = await signOrder({ version: 3, chainId: 8453, kind: 'dca', salt: 'a95 s1 outcomes' })
    const text = `0x${s.signature.slice(12, 76)}`
    expect((await post(s.body)).status).toBe(201)
    expect(logged('orders_order_hash_mismatch')).toEqual([])
    expect((await post({ ...s.body, orderHash: text })).status).toBe(409)
    expect(logged('orders_order_hash_mismatch')).toMatchObject([{ outcome: 'exists', callerHash: '<hash-shaped>', callerHashDigest: digest16(text) }])
  })

  it('property, seeded: 1,000 requests whose orderHash is cut from the request\'s own signature leave no 8-hex run of it in any console line', async () => {
    const SEED = 95_001
    let state = SEED
    const rand = () => { // mulberry32
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
    const hexOf = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('')
    const SIGNED = 25
    const REQUESTS = 40
    const signed = await Promise.all(Array.from({ length: SIGNED }, (_, i) =>
      signOrder({ version: i % 2 ? 3 : 2, chainId: i % 2 ? 8453 : 1, kind: 'dca', salt: `a95 property ${i}` })))
    const all = spyAll()
    const seen = { requests: 0, hashShaped: 0, otherShape: 0, fullWindow: 0, upper: 0, prefix0x: 0, prefix0X: 0, noPrefix: 0 }
    try {
      for (const s of signed) {
        db.reset()
        const texts = fourTexts(s.signature)
        for (let k = 0; k < REQUESTS; k++) {
          const len = int(8, 64)
          const src = texts[int(0, 3)]
          const at = int(0, src.length - len)
          let text = src.slice(at, at + len)
          const pad = 64 - len
          const mode = int(0, 3)
          if (pad > 0) {
            const left = mode === 0 ? pad : mode === 1 ? 0 : int(0, pad)
            text = hexOf(left) + text + hexOf(pad - left)
          }
          if (rand() < 0.5) text = text.toUpperCase()
          const prefixKind = int(0, 2)
          if (prefixKind === 0) text = `0x${text}`
          else if (prefixKind === 1) text = `0X${text}`
          // Some requests are not hash-shaped at all: a signature slice with a run of non-hex text around it.
          if (rand() < 0.15) text = `${text.slice(0, 20)}-${text.slice(20)}`
          const res = await post({ ...s.body, orderHash: text })
          expect([201, 409]).toContain(res.status)
          seen.requests += 1
          if (/^(?:0[xX])?[0-9a-fA-F]{64}$/.test(text)) seen.hashShaped += 1
          else seen.otherShape += 1
          if (len === 64) seen.fullWindow += 1
          if (text !== text.toLowerCase()) seen.upper += 1
          if (text.startsWith('0x')) seen.prefix0x += 1
          else if (text.startsWith('0X')) seen.prefix0X += 1
          else seen.noPrefix += 1
          expect(leakedRuns(s.signature, all.printed()), `request ${seen.requests}: ${text.length} chars`).toEqual([])
          all.clear()
        }
      }
    } finally {
      all.restore()
    }
    expect(seen.requests).toBe(SIGNED * REQUESTS)
    expect(seen.requests).toBe(1000)
    // The property is not vacuous: every spelling and both shapes occurred.
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0)
  }, 120_000)
})
