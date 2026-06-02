/**
 * [SPRINT-9H] KNOWN_SWAP_SELECTORS allowlist — coverage for the Velora/ParaSwap
 * Augustus V6.2 single-DEX Curve methods that Base (and mainnet) swaps emit.
 *
 * The selector whitelist is a SECURITY control (blocks unknown calldata before
 * a wallet prompt + at /api/swap). These selectors were verified three ways
 * against the live Augustus V6.2 contract (0x6a00…1068, identical address on
 * Ethereum + Base):
 *   - codeslaw verified ABI,
 *   - openchain.xyz signature database,
 *   - local viem toFunctionSelector() over the canonical signature.
 * All three agree; the known-good swapExactAmountIn (0xe3ead59e) reproduced
 * exactly, confirming the method.
 */
import { describe, it, expect } from 'vitest'
import { KNOWN_SWAP_SELECTORS, isKnownSwapSelector } from './swap-selectors'

const CALLDATA = (selector: string) => `${selector}${'0'.repeat(128)}`

describe('KNOWN_SWAP_SELECTORS — Augustus V6.2 Curve methods [SPRINT-9H]', () => {
  it('allows swapExactAmountInOnCurveV1 (0x1a01c532) — the CurveV1StableNg route that failed on Base', () => {
    expect(KNOWN_SWAP_SELECTORS.has('0x1a01c532')).toBe(true)
    expect(isKnownSwapSelector(CALLDATA('0x1a01c532'))).toBe(true)
  })

  it('allows swapExactAmountInOnCurveV2 (0xe37ed256) — Curve crypto-pool routes', () => {
    expect(KNOWN_SWAP_SELECTORS.has('0xe37ed256')).toBe(true)
    expect(isKnownSwapSelector(CALLDATA('0xe37ed256'))).toBe(true)
  })

  it('still allows the existing Augustus V6 swapExactAmountIn (0xe3ead59e) — unchanged', () => {
    expect(KNOWN_SWAP_SELECTORS.has('0xe3ead59e')).toBe(true)
  })

  it('still blocks an unknown selector (gate not blindly widened)', () => {
    expect(isKnownSwapSelector(CALLDATA('0xdeadbeef'))).toBe(false)
  })
})

describe('KNOWN_SWAP_SELECTORS — mainnet selector set preserved [SPRINT-9H]', () => {
  // Every selector that was allowed before SPRINT-9H must remain allowed, so no
  // previously-working mainnet swap regresses (the allowlist is global, shared
  // by all chains — we only ADD, never remove).
  const PRE_9H = [
    '0x12aa3caf', '0xe449022e', '0x0502b1c5', '0x2e95b6c8', // 1inch
    '0xd9627aa4', '0x415565b0',                               // 0x
    '0x3598d8ab', '0xa94e78ef', '0x46c67b6d',                 // Paraswap V5
    '0xe3ead59e',                                             // Augustus V6 swapExactAmountIn
    '0x83800a8e',                                             // Odos
    '0xe21fd0e9',                                             // KyberSwap
    '0xac9650d8', '0x5ae401dc', '0x04e45aaf', '0xb858183f',   // Uniswap V3
    '0x472b43f3', '0x38ed1739', '0x7ff36ab5', '0x18cbafe5',   // Uniswap V2 / Sushi
  ]

  it('retains all 20 pre-9H selectors', () => {
    for (const sel of PRE_9H) expect(KNOWN_SWAP_SELECTORS.has(sel)).toBe(true)
  })

  it('adds exactly the two verified Curve selectors (22 total, no accidental widening)', () => {
    expect(KNOWN_SWAP_SELECTORS.size).toBe(PRE_9H.length + 2)
  })
})
