// @vitest-environment node
/**
 * [P227] fetchApproveSpender — per-chain spender resolution (P226).
 */
import { describe, it, expect } from 'vitest'
import { fetchApproveSpender, classifyAdapterResult } from './api'
import type { NormalizedQuote } from './api'
import { FEE_COLLECTOR_ADDRESS, PERMIT2_ADDRESS } from './constants'

const quote = (toAmount: string): NormalizedQuote =>
  ({ source: 'bebop', toAmount, estimatedGas: 0, gasUsd: 0, routes: [] } as NormalizedQuote)

describe('api — fetchApproveSpender per-chain [P226]', () => {
  it('returns the mainnet spender for chainId=1 (unchanged)', async () => {
    // 0x is FeeCollector-incompatible → its mainnet spender is Permit2.
    expect((await fetchApproveSpender('0x', 1)).toLowerCase()).toBe(PERMIT2_ADDRESS.toLowerCase())
    // 1inch routes through the FeeCollector → spender is the (mainnet) FeeCollector.
    expect((await fetchApproveSpender('1inch', 1)).toLowerCase()).toBe(FEE_COLLECTOR_ADDRESS.toLowerCase())
  })

  it('returns the Base spender for chainId=8453', async () => {
    // Base FeeCollector is null → fall through to the per-chain router whitelist.
    expect((await fetchApproveSpender('1inch', 8453)).toLowerCase()).toBe('0x111111125421ca6dc452d289314280a0f8842a65')
    // 0x on Base → the v2 AllowanceHolder (differs from the mainnet Permit2 spender).
    expect((await fetchApproveSpender('0x', 8453)).toLowerCase()).toBe('0x0000000000001ff3684f28c67538d4d072c22734')
  })
})

// [SPRINT-9F backlog] How fetchMetaQuote classifies each settled adapter result
// for source-monitoring. Three outcomes — crucially a resolved `null` is a
// no-route (not a failure), and a present-but-unusable amount stays a 'Zero
// output' failure, so the two are no longer conflated under one label.
describe('api — classifyAdapterResult [SPRINT-9F backlog]', () => {
  it('a rejected result is a failure carrying the reason', () => {
    const r = classifyAdapterResult({ status: 'rejected', reason: new Error('Bebop 502') })
    expect(r.kind).toBe('failure')
    expect(r.kind === 'failure' && r.error).toContain('502')
  })

  it('a resolved null is a NO-ROUTE (not a failure)', () => {
    expect(classifyAdapterResult({ status: 'fulfilled', value: null }).kind).toBe('no_route')
  })

  it('a resolved quote with a positive amount is a success', () => {
    expect(classifyAdapterResult({ status: 'fulfilled', value: quote('2000000000') }).kind).toBe('success')
  })

  it("a present-but-zero amount is a 'Zero output' failure (NOT a no-route)", () => {
    const r = classifyAdapterResult({ status: 'fulfilled', value: quote('0') })
    expect(r.kind).toBe('failure')
    expect(r.kind === 'failure' && r.error).toBe('Zero output')
  })

  it('a non-numeric amount is a Zero-output failure and never throws', () => {
    const r = classifyAdapterResult({ status: 'fulfilled', value: quote('not-a-number') })
    expect(r.kind).toBe('failure')
    expect(r.kind === 'failure' && r.error).toBe('Zero output')
  })
})
