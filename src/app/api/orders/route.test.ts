// @vitest-environment node
/**
 * [CHORE-ORDER-API-CHAIN-AWARE] POST /api/orders chain-aware fail-closed + real-signature parity.
 *
 * The verification chain is now derived from the SIGNED order (body.chainId), NOT process.env.CHAIN_ID
 * — the SAME chainId the frontend put in the EIP-712 domain when it signed (getOrderExecutorDomain).
 * A chain with no real OrderExecutor (e.g. Arbitrum 42161 — unwired) is rejected with 400 up front,
 * before any signature verification, and never verified against the wrong contract.
 *
 * This file does NOT mock viem: the fail-closed cases short-circuit before recoverTypedDataAddress, and
 * the positive cases produce a REAL EIP-712 signature with privateKeyToAccount so we prove a Base order
 * (8453) verifies against the Base domain and a mainnet order (1) still verifies against the mainnet
 * domain (byte-identical regression). Supabase is given fake creds so getSupabase() is non-null; the
 * insert never actually connects in these tests because every assertion returns at/before verification
 * — except the real-signature cases, which we drive only to the point where 'Signature mismatch' would
 * fire, asserting it does NOT.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import { zeroHash } from 'viem'
import { getOrderExecutorDomain } from '@/lib/order-engine/config'

const ENV0 = { ...process.env }
beforeEach(() => {
  // getSupabase() must return non-null so the request reaches the chain guard / verification (which
  // both return before any DB I/O). These are fake — createClient never connects in this test.
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
})
afterEach(() => { process.env = { ...ENV0 } })

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

// Same Order EIP-712 types the route verifies with.
const ORDER_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'orderType', type: 'uint8' },
    { name: 'condition', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'priceFeed', type: 'address' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'routerDataHash', type: 'bytes32' },
    { name: 'dcaInterval', type: 'uint256' },
    { name: 'dcaTotal', type: 'uint256' },
  ],
} as const

// A deterministic test signer (anvil account #0).
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const ACCOUNT = privateKeyToAccount(PK)

const TOKEN_IN = '0x2222222222222222222222222222222222222222'
const TOKEN_OUT = '0x3333333333333333333333333333333333333333'
const ROUTER = '0x4444444444444444444444444444444444444444'
const PRICE_FEED = '0x5555555555555555555555555555555555555555'

function validBody(overrides: Record<string, unknown> = {}) {
  const expiry = Math.floor(Date.now() / 1000) + 3600 // 1h in the future
  return {
    wallet: '0x1111111111111111111111111111111111111111',
    chainId: 1,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    router: ROUTER,
    signature: '0x' + 'cc'.repeat(65),
    orderHash: '0x' + 'ab'.repeat(32),
    amountIn: '1000000000000000000',
    minAmountOut: '0',
    orderType: 'limit',
    priceCondition: 'above',
    targetPrice: '1000',
    priceFeed: PRICE_FEED,
    expiry,
    nonce: 0,
    routerDataHash: '0x' + '00'.repeat(32),
    ...overrides,
  }
}

/**
 * Build a body whose `signature` is a REAL EIP-712 signature over the route's Order message, signed
 * under `getOrderExecutorDomain(chainId)` by ACCOUNT. `wallet` is set to the signer so the route's
 * `recovered === wallet` check passes. Crucially, the message is the EXACT shape route.ts rebuilds.
 */
async function signedBody(chainId: number, overrides: Record<string, unknown> = {}) {
  const base = validBody({ chainId, wallet: ACCOUNT.address, ...overrides })
  const message = {
    owner: base.wallet,
    tokenIn: base.tokenIn,
    tokenOut: base.tokenOut,
    amountIn: base.amountIn,
    minAmountOut: base.minAmountOut,
    orderType: base.orderType === 'limit' ? 0 : base.orderType === 'stop_loss' ? 1 : 2,
    condition: base.priceCondition === 'above' ? 0 : 1,
    targetPrice: base.targetPrice,
    priceFeed: base.priceFeed,
    expiry: base.expiry,
    nonce: base.nonce,
    router: base.router,
    routerDataHash: base.routerDataHash ?? zeroHash,
    dcaInterval: 0,
    dcaTotal: 1,
  }
  const signature = await ACCOUNT.signTypedData({
    domain: getOrderExecutorDomain(chainId),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: message as never,
  })
  return { ...base, signature }
}

function req(body: unknown) {
  return new NextRequest('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/orders — chain derived from body.chainId, fail-closed [CHORE-ORDER-API-CHAIN-AWARE]', () => {
  it('an UNWIRED chain (no OrderExecutor) → 400 fail-closed BEFORE signature verification', async () => {
    // chainId is taken from the SIGNED order body, NOT process.env. 42161 (Arbitrum) is not wired.
    const res = await POST(req(validBody({ chainId: 42161 })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not yet available on chain 42161/i)
  })

  it('a non-integer / missing chainId → 400 "Invalid chainId" before verification', async () => {
    for (const bad of [undefined, '8453', 1.5, null]) {
      const body = validBody()
      ;(body as Record<string, unknown>).chainId = bad as unknown
      const res = await POST(req(body))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Invalid chainId')
    }
  })

  it('mainnet (chainId 1) passes the executor guard (rejected only later, never with the chain-unavailable 400)', async () => {
    // process.env.CHAIN_ID is intentionally NOT set — the route no longer reads it.
    const res = await POST(req(validBody({ chainId: 1 })))
    const json = await res.json()
    expect(json.error ?? '').not.toMatch(/not yet available on chain/i)
    expect(json.error ?? '').not.toBe('Invalid chainId')
  })

  it('does NOT read process.env.CHAIN_ID — a stale env value cannot override body.chainId', async () => {
    // Even with CHAIN_ID pinned to an unwired chain, a body.chainId=1 order is gated on chain 1.
    process.env.CHAIN_ID = '42161'
    const res = await POST(req(validBody({ chainId: 1 })))
    const json = await res.json()
    // It reaches verification (chain 1 is wired) rather than the unwired-chain 400 for 42161.
    expect(json.error ?? '').not.toMatch(/not yet available on chain/i)
  })
})

describe('POST /api/orders — real EIP-712 signature verifies against the body.chainId domain', () => {
  // This test is RED if the verify domain is ever pinned to env/hardcoded-1 instead of body.chainId:
  // a Base (8453) signature would then be recovered under the mainnet (1) domain → 'Signature mismatch'.
  it('a Base order (8453) signed under the Base domain VERIFIES (no Signature mismatch)', async () => {
    const body = await signedBody(8453)
    const res = await POST(req(body))
    const json = await res.json()
    // It must get PAST signature recovery. Insert hits the fake Supabase and fails later (500/other),
    // but it must NOT be a signature error and NOT the chain-unavailable 400.
    expect(json.error ?? '').not.toBe('Signature mismatch')
    expect(json.error ?? '').not.toMatch(/Signature verification failed/i)
    expect(json.error ?? '').not.toMatch(/not yet available on chain/i)
    expect(res.status).not.toBe(400)
  })

  it('a mainnet order (1) signed under the mainnet domain VERIFIES (byte-identical regression)', async () => {
    const body = await signedBody(1)
    const res = await POST(req(body))
    const json = await res.json()
    expect(json.error ?? '').not.toBe('Signature mismatch')
    expect(json.error ?? '').not.toMatch(/Signature verification failed/i)
    expect(res.status).not.toBe(400)
  })

  it('body.chainId != the chainId the order was actually signed under → "Signature mismatch"', async () => {
    // Sign under the Base (8453) domain but CLAIM chainId 1: the route verifies under the mainnet
    // domain, so the recovered address ≠ wallet → recovery fails closed.
    const signed = await signedBody(8453)
    const res = await POST(req({ ...signed, chainId: 1 }))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toBe('Signature mismatch')
  })
})
