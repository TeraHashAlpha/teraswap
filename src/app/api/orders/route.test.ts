// @vitest-environment node
/**
 * [CHORE-ORDER-EXEC-PREP A] POST /api/orders chain-aware fail-closed.
 *
 * The order's chain (server CHAIN_ID) must resolve to a real OrderExecutor before any signature
 * verification. A chain with none (e.g. Base — 0xeFC3…f130 is the FeeCollector there) is rejected
 * with 400 up front, never verified against the wrong contract. Mainnet (1) is unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const ENV0 = { ...process.env }
beforeEach(() => {
  // getSupabase() must return non-null so the request reaches the executor guard (which returns
  // before any DB I/O). These are fake — createClient never connects in this test.
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
})
afterEach(() => { process.env = { ...ENV0 } })

import { POST } from './route'

function validBody(overrides: Record<string, unknown> = {}) {
  const expiry = Math.floor(Date.now() / 1000) + 3600 // 1h in the future
  return {
    wallet: '0x1111111111111111111111111111111111111111',
    tokenIn: '0x2222222222222222222222222222222222222222',
    tokenOut: '0x3333333333333333333333333333333333333333',
    router: '0x4444444444444444444444444444444444444444',
    signature: '0x' + 'cc'.repeat(65),
    orderHash: '0x' + 'ab'.repeat(32),
    amountIn: '1000000000000000000',
    minAmountOut: '0',
    orderType: 'limit',
    priceCondition: 'above',
    targetPrice: '1000',
    priceFeed: '0x5555555555555555555555555555555555555555',
    expiry,
    nonce: 0,
    routerDataHash: '0x' + '00'.repeat(32),
    ...overrides,
  }
}
function req(body: unknown) {
  return new NextRequest('http://localhost/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/orders — chain-aware fail-closed [CHORE-ORDER-EXEC-PREP A]', () => {
  it('an UNWIRED chain (no OrderExecutor) → 400 fail-closed BEFORE signature verification', async () => {
    process.env.CHAIN_ID = '42161' // Arbitrum — not in ORDER_EXECUTOR_BY_CHAIN (Base 8453 is now wired)
    const res = await POST(req(validBody()))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not yet available on chain 42161/i)
  })

  it('mainnet (chainId 1) passes the executor guard (rejected only later, never with the chain-unavailable 400)', async () => {
    process.env.CHAIN_ID = '1'
    const res = await POST(req(validBody()))
    const json = await res.json()
    expect(json.error ?? '').not.toMatch(/not yet available on chain/i)
  })
})
