// @vitest-environment node
/**
 * GET /api/orders/stats — recentExecutions24h schema fix (CHORE-API-SMALL-FIXES).
 *
 * order_executions has no `wallet` or `executed_at` column (see
 * contracts/order-engine/schema.sql). The route previously queried both
 * directly against order_executions, which is a silent no-op filter against
 * Supabase (unknown columns are simply never satisfied / error), producing
 * wrong 24h counts. Fix: filter on `created_at`, join `orders!inner(wallet)`
 * for the wallet scope, same pattern as src/app/api/history/route.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockCount = vi.fn()
const chain = (): Record<string, unknown> => ({
  eq: mockEq,
  gte: mockGte,
  then: (cb: (r: unknown) => unknown) => cb(mockCount()),
})
const mockGte = vi.fn(() => chain())
const mockEq = vi.fn(() => chain())
const capturedSelects: string[] = []
const mockSelect = vi.fn((...args: unknown[]) => {
  capturedSelects.push(String(args[0]))
  return chain()
})
const mockFrom = vi.fn((_table: string) => ({
  select: mockSelect,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => mockFrom(table) }),
}))

import { GET } from './route'

describe('GET /api/orders/stats — recentExecutions24h', () => {
  it('filters order_executions on created_at (not the non-existent executed_at)', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    mockCount.mockReturnValue({ count: 3 })

    const req = new NextRequest('https://x.test/api/orders/stats')
    const res = await GET(req)
    const json = await res.json()

    expect(json.recentExecutions24h).toBe(3)
    expect(mockGte).toHaveBeenCalledWith('created_at', expect.any(String))
    expect(mockGte).not.toHaveBeenCalledWith('executed_at', expect.anything())
  })

  it('scopes recentExecutions24h to the wallet via the orders join, not a wallet column on order_executions', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    mockCount.mockReturnValue({ count: 1 })
    mockGte.mockClear()
    mockEq.mockClear()
    capturedSelects.length = 0

    // [A97 S-3] The wallet's 24 h count is read only with its own read signature (stats-read-signature.test.ts), so this
    // request carries one (published Anvil/Hardhat account #0, value-allowlisted in .gitleaks.toml, NOT a secret).
    const { privateKeyToAccount } = await import('viem/accounts')
    const { buildOrdersReadTypedData, ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE } = await import('@/lib/order-engine/read-auth')
    const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    const wallet = account.address.toLowerCase()
    const issuedAt = Math.floor(Date.now() / 1000)
    const req = new NextRequest(`https://x.test/api/orders/stats?wallet=${wallet}`, {
      headers: {
        [ORDERS_READ_HEADER_ISSUED]: String(issuedAt),
        [ORDERS_READ_HEADER_SIGNATURE]: await account.signTypedData(buildOrdersReadTypedData(wallet, issuedAt)),
      },
    })
    await GET(req)

    const execSelect = capturedSelects.find((s) => s.includes('orders!inner'))
    expect(execSelect).toBeDefined()
    expect(mockEq).toHaveBeenCalledWith('orders.wallet', wallet.toLowerCase())
  })
})
