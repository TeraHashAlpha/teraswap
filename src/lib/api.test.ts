// @vitest-environment node
/**
 * [P227] fetchApproveSpender — per-chain spender resolution (P226).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchApproveSpender, classifyAdapterResult } from './api'
import type { NormalizedQuote } from './api'
import { FEE_COLLECTOR_ADDRESS, PERMIT2_ADDRESS, ZEROX_ALLOWANCE_HOLDER } from './constants'

const quote = (toAmount: string): NormalizedQuote =>
  ({ source: 'bebop', toAmount, estimatedGas: 0, gasUsd: 0, routes: [] } as NormalizedQuote)

describe('api — fetchApproveSpender per-chain [P226]', () => {
  it('returns the mainnet spender for chainId=1', async () => {
    // 0x is FeeCollector-incompatible → it approves a 0x contract directly.
    // [ADR-021] Was Permit2, for the permit2 endpoint family. Mainnet now uses the
    // allowance-holder family, which pulls the taker's ERC-20 via
    // AllowanceHolder.transferFrom — so the AllowanceHolder is the spender, the same
    // address chains 8453/42161 already resolve (see the Base case below).
    expect((await fetchApproveSpender('0x', 1)).toLowerCase())
      .toBe(ZEROX_ALLOWANCE_HOLDER.toLowerCase())
    expect((await fetchApproveSpender('0x', 1)).toLowerCase())
      .not.toBe(PERMIT2_ADDRESS.toLowerCase())
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

// ── [E-2 / REVIEW-QUALITY-2026-06-11] L2 sequencer gate on the QUOTE path ────
//
// The sequencer-uptime gate (P218) protected the Chainlink price READ but not
// quote sourcing: with the Base sequencer down/recovering, Base quotes were
// still served. fetchMetaQuote now refuses to quote a non-mainnet chain whose
// sequencer is not confirmed up (isSequencerUp already encodes down + the
// recovery grace window + RPC-fail-safe — all unit-tested in
// chains/sequencer-check.test.ts). Mainnet must be byte-identical: the gate
// must never even be CONSULTED for chainId 1 / omitted chainId.
import { fetchMetaQuote } from './api'
import { SequencerDownError } from './chains/sequencer-check'

const isSequencerUpMock = vi.fn()
vi.mock('./chains/sequencer-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chains/sequencer-check')>()
  return { ...actual, isSequencerUp: (...a: unknown[]) => isSequencerUpMock(...a) }
})
vi.mock('./chains/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chains/clients')>()
  return {
    ...actual,
    // On-chain adapters get a client whose reads fail fast — no live RPC in tests.
    getPublicClientForChain: () => ({ readContract: () => Promise.reject(new Error('test: no rpc')) }),
  }
})

describe('api — fetchMetaQuote L2 sequencer gate [E-2]', () => {
  beforeEach(() => {
    isSequencerUpMock.mockReset()
    // No adapter may reach the network in these tests.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('test: no network'))))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('REFUSES a Base quote when the sequencer is down or in the recovery grace window', async () => {
    isSequencerUpMock.mockResolvedValue(false) // down OR within grace — same verdict
    await expect(
      fetchMetaQuote('0x4200000000000000000000000000000000000006', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '1000000000000000000', 18, 6, undefined, 8453),
    ).rejects.toBeInstanceOf(SequencerDownError)
    expect(isSequencerUpMock).toHaveBeenCalledWith(8453, expect.anything())
  })

  it('proceeds past the gate to quote sourcing when the sequencer is up', async () => {
    isSequencerUpMock.mockResolvedValue(true)
    let caught: unknown
    try {
      await fetchMetaQuote('0x4200000000000000000000000000000000000006', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '2000000000000000000', 18, 6, undefined, 8453)
    } catch (e) {
      caught = e
    }
    // Adapters were reached (and failed on the stubbed network) — the failure is
    // a sourcing error, NOT the sequencer gate.
    expect(isSequencerUpMock).toHaveBeenCalledTimes(1)
    expect(caught).not.toBeInstanceOf(SequencerDownError)
  })

  it('NEVER consults the sequencer gate on mainnet (byte-identical: explicit 1 and omitted)', async () => {
    for (const chainId of [1, undefined]) {
      isSequencerUpMock.mockReset()
      try {
        await fetchMetaQuote('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', `${3000000000000000000n + BigInt(chainId ?? 0)}`, 18, 6, undefined, chainId)
      } catch { /* sourcing fails on the stubbed network — irrelevant here */ }
      expect(isSequencerUpMock).not.toHaveBeenCalled()
    }
  })
})
