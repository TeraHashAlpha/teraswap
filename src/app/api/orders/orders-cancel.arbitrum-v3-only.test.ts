// @vitest-environment node
/**
 * [feat/arbitrum-dca-gates — third gate] PATCH /api/orders/[id] on a v3-ONLY chain, real config.
 *
 * The route used to recover the CancelOrder ownership proof under `getOrderExecutorDomain` — the
 * v2 domain by name — which throws on Arbitrum One (ORDER_EXECUTOR_BY_CHAIN has no 42161) and so
 * turned every Arbitrum cancel into 400 "Invalid cancel signature" AFTER the client's on-chain
 * cancelOrder() had already landed: chain says cancelled, DB says active. It now recovers under
 * getCancelOrderDomain — the ONE rule the client signs under (useOrderEngine confirmCancel): v2's
 * domain where v2 exists, else v3's, else throw. This file is the server half of the proof the
 * hook-level suite (useOrderEngine.v3-only-chain.test.ts) gives for the client half.
 *
 * Same boundaries as orders-cancel.test.ts (viem recover + supabase mocked); nothing in
 * `@/lib/order-engine/config` is mocked. Env slots are set BEFORE any import to the addresses
 * EXTRACTED from docs/DEPLOYMENTS.md's "OrderExecutor V3" rows (sentinel 42 on a failed extraction).
 *
 *   42161 → recovers under {TeraSwapOrderExecutor, "3", 42161, <Arbitrum V3>}  (was: 400, never recovered)
 *   8453  → recovers under getOrderExecutorDomain(8453) = {"2", 8453, 0x135B…2598} (unchanged, literal)
 *   1     → recovers under getOrderExecutorDomain(1)    = {"2", 1, 0xeFC3…f130}    (unchanged, literal)
 *   10    → no executor of either version ⇒ 400 "Invalid cancel signature", recover never called
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

const { ARBITRUM_V3, BASE_V3, ENV_BEFORE } = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const rows = readFileSync(resolve(process.cwd(), 'docs/DEPLOYMENTS.md'), 'utf8').split('\n')
  const extract = (chainLabel: RegExp) => {
    const row = rows.find(l => /\*\*OrderExecutor V3\*\*/.test(l) && chainLabel.test(l)) ?? ''
    return (row.match(/0x[0-9a-fA-F]{40}/) ?? [])[0]
  }
  const arbitrum = extract(/Arbitrum One \(42161\)/)
  const base = extract(/Base \(8453\)/)
  if (!arbitrum || !base || arbitrum.toLowerCase() === base.toLowerCase()) {
    console.error('SENTINEL 42: could not extract distinct Base + Arbitrum OrderExecutor V3 rows from docs/DEPLOYMENTS.md')
    process.exit(42)
  }
  const ENV_BEFORE = {
    arbitrum: process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM,
    base: process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE,
  }
  process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM = arbitrum
  process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = base
  return { ARBITRUM_V3: arbitrum as `0x${string}`, BASE_V3: base as `0x${string}`, ENV_BEFORE }
})

// ── viem boundary ────────────────────────────────────────
const mockRecover = vi.fn()
vi.mock('viem', () => ({
  recoverTypedDataAddress: (...args: unknown[]) => mockRecover(...args),
}))

// ── supabase boundary (the UPDATE chain resolves to a matched row) ──
const calls = { update: vi.fn() }
function makeBuilder() {
  const builder: Record<string, unknown> = {}
  let updateMode = false
  builder.from = () => { updateMode = false; return builder }
  builder.update = (...a: unknown[]) => { calls.update(...a); updateMode = true; return builder }
  builder.eq = () => builder
  builder.single = () => Promise.resolve({ data: null, error: null })
  builder.select = () => (updateMode ? Promise.resolve({ data: [{ id: ORDER_ID }], error: null }) : builder)
  return builder
}
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => makeBuilder(),
}))

import { PATCH } from './[id]/route'
import {
  CANCEL_ORDER_TYPES, getCancelOrderDomain, getOrderExecutorDomain, getOrderExecutorV3Domain,
  getOrderExecutor, getOrderExecutorV3,
} from '@/lib/order-engine/config'

const ENV0 = { ...process.env }
const WALLET = '0x1111111111111111111111111111111111111111'
const SIG = '0x' + 'ab'.repeat(65)
const ORDER_ID = 'ord-uuid-arbitrum'
const BASE_V2 = '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598'
const MAINNET_V2 = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'
  mockRecover.mockResolvedValue(WALLET)
})
afterEach(() => { process.env = { ...ENV0 } })
afterAll(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', ENV_BEFORE.arbitrum)
  restore('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', ENV_BEFORE.base)
})

function patchReq(chainId: number) {
  return new NextRequest('http://localhost/api/orders/' + ORDER_ID, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: WALLET, signature: SIG, chainId }),
  })
}
const ctx = { params: Promise.resolve({ id: ORDER_ID }) }
const recoveredDomain = () => (mockRecover.mock.calls[0][0] as { domain: unknown }).domain

describe('PATCH /api/orders/[id] — [third gate] the ownership proof recovers under getCancelOrderDomain', () => {
  it('sanity: the fixture is real config with the DEPLOYMENTS.md slots (42161 v3-only, 8453 v2+v3)', () => {
    expect(getOrderExecutor(42161)).toBeNull()
    expect(getOrderExecutorV3(42161)).toBe(ARBITRUM_V3)
    expect(getOrderExecutor(8453)).toBe(BASE_V2)
    expect(getOrderExecutorV3(8453)).toBe(BASE_V3)
  })

  it('42161 (v3-only): recovers under the V3 domain {name, "3", 42161, <DEPLOYMENTS.md Arbitrum V3>} and cancels — was 400 before this commit', async () => {
    const res = await PATCH(patchReq(42161), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockRecover).toHaveBeenCalledTimes(1)
    const arg = mockRecover.mock.calls[0][0] as Record<string, unknown>
    expect(arg.domain).toEqual({ name: 'TeraSwapOrderExecutor', version: '3', chainId: 42161, verifyingContract: ARBITRUM_V3 })
    expect(arg.domain).toEqual(getOrderExecutorV3Domain(42161))
    expect(arg.domain).toEqual(getCancelOrderDomain(42161)) // the client's rule, same object
    expect(arg.types).toBe(CANCEL_ORDER_TYPES)
    expect(arg.primaryType).toBe('CancelOrder')
    expect(arg.message).toEqual({ id: ORDER_ID, action: 'cancel' })
    expect(arg.signature).toBe(SIG)
    expect(calls.update).toHaveBeenCalledWith({ status: 'cancelled' })
  })

  it('42161: a non-owner signature is still refused under that domain (400 "Signature verification failed")', async () => {
    mockRecover.mockResolvedValue('0x2222222222222222222222222222222222222222')
    const res = await PATCH(patchReq(42161), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Signature verification failed')
    expect(calls.update).not.toHaveBeenCalled()
  })

  it('8453 (v2 + v3): UNCHANGED — recovers under the v2 domain of 0x135B…2598, never the Base V3', async () => {
    const res = await PATCH(patchReq(8453), ctx)
    expect(res.status).toBe(200)
    expect(recoveredDomain()).toEqual({ name: 'TeraSwapOrderExecutor', version: '2', chainId: 8453, verifyingContract: BASE_V2 })
    expect(recoveredDomain()).toEqual(getOrderExecutorDomain(8453))
    expect((recoveredDomain() as { verifyingContract: string }).verifyingContract).not.toBe(BASE_V3)
  })

  it('1 (mainnet): UNCHANGED — recovers under the v2 domain of 0xeFC3…f130', async () => {
    const res = await PATCH(patchReq(1), ctx)
    expect(res.status).toBe(200)
    expect(recoveredDomain()).toEqual({ name: 'TeraSwapOrderExecutor', version: '2', chainId: 1, verifyingContract: MAINNET_V2 })
    expect(recoveredDomain()).toEqual(getOrderExecutorDomain(1))
  })

  it('10 (no executor of either version): getCancelOrderDomain throws → 400 "Invalid cancel signature", recover never called', async () => {
    const res = await PATCH(patchReq(10), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid cancel signature')
    expect(mockRecover).not.toHaveBeenCalled()
    expect(calls.update).not.toHaveBeenCalled()
  })
})
