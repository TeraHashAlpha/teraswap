/**
 * Unit tests for POST /api/log-swap — focused on [P104 / 13A-L-02]:
 * server-side derivation of gas_savings_usd with a $500 cap.
 *
 * The route has heavy side effects (Chainlink USD lookup, wallet-activity
 * tracker, security-event tracker). We stub each at the import boundary
 * so the test only exercises the gasless-tracking branch we care about.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Supabase mock — capture the row inserted into `swaps` ───

const insertedRows: Array<Record<string, unknown>> = []

const supabaseChain = {
  from: vi.fn().mockReturnThis(),
  insert: vi.fn(async (row: Record<string, unknown>) => {
    insertedRows.push(row)
    return { error: null }
  }),
}

// [P114/M-03] The POST handler reads via getSupabaseLogger now;
// PATCH still uses getSupabase. Both resolve to the same chain in
// tests because the mock can't distinguish — and we don't need it
// to: the test exercises insert-shape clamping, not which role key
// did the writing.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => supabaseChain,
  getSupabaseLogger: () => supabaseChain,
}))

// ── Stub side-effect deps ──────────────────────────────────

vi.mock('@/lib/chainlink', () => ({
  // Returning null makes finalInUsd fall back to the client value (or null),
  // which is fine — these tests don't assert on the USD column.
  computeTokenAmountUsd: vi.fn(async () => null),
}))

vi.mock('@/lib/wallet-activity-server', () => ({
  trackWalletAction: vi.fn(),
}))

vi.mock('@/lib/security-tracker', () => ({
  trackLargeTrade: vi.fn(),
  trackSwapFailed: vi.fn(),
  trackOracleDeviation: vi.fn(),
  trackOracleUnavailable: vi.fn(),
}))

// ── Import route after mocks ───────────────────────────────

import { POST } from './route'

// ── Fixtures ───────────────────────────────────────────────

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/log-swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function cowBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wallet: WALLET,
    source: 'cowswap',
    tokenIn: WETH,
    tokenInSymbol: 'WETH',
    tokenOut: USDC,
    tokenOutSymbol: 'USDC',
    amountIn: '1000000000000000000',
    amountOut: '2950000000',
    slippage: 0.5,
    mevProtected: true,
    feeCollected: false,
    ...overrides,
  }
}

function lastRow(): Record<string, unknown> {
  return insertedRows[insertedRows.length - 1]
}

describe('POST /api/log-swap — gas_savings_usd clamp [P104]', () => {
  beforeEach(() => {
    insertedRows.length = 0
    vi.clearAllMocks()
  })

  it('clamps bestNonCowGasUsd=9999 to 500', async () => {
    const res = await POST(makeRequest(cowBody({ bestNonCowGasUsd: 9999 })))
    expect(res.status).toBe(200)
    expect(lastRow().gas_savings_usd).toBe(500)
    expect(lastRow().is_gasless).toBe(true)
  })

  it('clamps negative bestNonCowGasUsd to 0', async () => {
    await POST(makeRequest(cowBody({ bestNonCowGasUsd: -5 })))
    expect(lastRow().gas_savings_usd).toBe(0)
  })

  it('passes through a normal value (4.2)', async () => {
    await POST(makeRequest(cowBody({ bestNonCowGasUsd: 4.2 })))
    expect(lastRow().gas_savings_usd).toBe(4.2)
  })

  it('caps at the boundary: 500 stays 500, 500.01 stays 500', async () => {
    await POST(makeRequest(cowBody({ bestNonCowGasUsd: 500 })))
    expect(lastRow().gas_savings_usd).toBe(500)
    await POST(makeRequest(cowBody({ bestNonCowGasUsd: 500.01 })))
    expect(lastRow().gas_savings_usd).toBe(500)
  })

  it('coerces NaN / non-numeric to 0', async () => {
    await POST(makeRequest(cowBody({ bestNonCowGasUsd: 'not a number' })))
    expect(lastRow().gas_savings_usd).toBe(0)
  })

  it('non-CoW source persists gas_savings_usd=0 regardless of caller value', async () => {
    await POST(makeRequest(cowBody({ source: '1inch', bestNonCowGasUsd: 100 })))
    expect(lastRow().is_gasless).toBe(false)
    expect(lastRow().gas_savings_usd).toBe(0)
  })

  it('legacy `gasSavingsUsd` field is ignored (backwards compat — no inflation path)', async () => {
    // Old clients pre-P104 sent `gasSavingsUsd` directly. The route accepts
    // the payload (no 400) but never uses the value — gas_savings_usd is 0
    // because no bestNonCowGasUsd was provided.
    const res = await POST(makeRequest(cowBody({ gasSavingsUsd: 9999 })))
    expect(res.status).toBe(200)
    expect(lastRow().is_gasless).toBe(true)
    expect(lastRow().gas_savings_usd).toBe(0)
  })
})

describe('POST /api/log-swap — expected_output column [P118]', () => {
  beforeEach(() => {
    insertedRows.length = 0
    vi.clearAllMocks()
  })

  it('persists expectedOutput as a numeric string and drops invalid shapes to null', async () => {
    // Valid numeric string → stored verbatim
    await POST(makeRequest(cowBody({ expectedOutput: '2950000000' })))
    expect(lastRow().expected_output).toBe('2950000000')

    // Missing → null (column is nullable)
    await POST(makeRequest(cowBody()))
    expect(lastRow().expected_output).toBeNull()

    // Non-numeric string → coerced to null rather than crashing the insert
    await POST(makeRequest(cowBody({ expectedOutput: 'not a number' })))
    expect(lastRow().expected_output).toBeNull()

    // Numeric type (not string) → coerced to null; we require string-of-digits
    await POST(makeRequest(cowBody({ expectedOutput: 42 })))
    expect(lastRow().expected_output).toBeNull()
  })
})
