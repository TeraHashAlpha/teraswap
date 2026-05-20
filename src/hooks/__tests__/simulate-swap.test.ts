/**
 * [P140] Regression coverage for src/lib/simulation.ts.
 *
 * Two surfaces under test:
 *   1. parseSimulationError — the substring + selector matcher that
 *      converts raw RPC revert errors into user-facing hints. The four
 *      FeeCollector custom errors added in P139 are the priority cases.
 *   2. buildFeeCollectorSwapArgs — the from/recipient switch that P139
 *      added to the swap-flow. The bug was the user wallet being passed
 *      as `from` when the FeeCollector contract is the actual msg.sender
 *      hitting the DEX router.
 */
import { describe, it, expect } from 'vitest'
import {
  parseSimulationError,
  buildFeeCollectorSwapArgs,
  FEE_COLLECTOR_ERROR_SELECTORS,
} from '@/lib/simulation'

// ── FeeCollector custom errors ───────────────────────────

describe('parseSimulationError — FeeCollector custom errors', () => {
  it('matches RouterNotWhitelisted by decoded name', () => {
    const err = new Error('execution reverted with reason RouterNotWhitelisted()')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Router not whitelisted')
  })

  it('matches RouterNotWhitelisted by raw 4-byte selector', () => {
    const err = new Error(`The contract function reverted. Data: ${FEE_COLLECTOR_ERROR_SELECTORS.RouterNotWhitelisted}`)
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Router not whitelisted')
  })

  it('matches InsufficientOutput → slippage message', () => {
    const err = new Error('reverted: InsufficientOutput(1000,2000)')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('below minimum')
    expect(result.error).toContain('slippage')
  })

  it('matches InsufficientOutput by raw selector', () => {
    const err = new Error(`revert data ${FEE_COLLECTOR_ERROR_SELECTORS.InsufficientOutput}00000000`)
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('below minimum')
  })

  it('matches SwapFailed → router-failed message', () => {
    const err = new Error('execution reverted: SwapFailed()')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('DEX router call failed')
  })

  it('matches SwapFailed by raw selector', () => {
    const err = new Error(`Reverted ${FEE_COLLECTOR_ERROR_SELECTORS.SwapFailed}`)
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('DEX router call failed')
  })

  it('matches ZeroAmount → zero-amount message', () => {
    const err = new Error('reverted with ZeroAmount()')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('zero')
  })

  it('matches ZeroAmount by raw selector', () => {
    const err = new Error(`Revert: ${FEE_COLLECTOR_ERROR_SELECTORS.ZeroAmount}`)
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('zero')
  })
})

// ── Generic reverts ──────────────────────────────────────

describe('parseSimulationError — generic reverts', () => {
  it('matches "insufficient funds" → ETH balance message', () => {
    const err = new Error('insufficient funds for transfer')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Insufficient ETH balance')
  })

  it('matches TRANSFER_FROM_FAILED → approval/balance hint', () => {
    const err = new Error('revert: TRANSFER_FROM_FAILED')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Token transfer would fail')
  })

  it('matches "STF" shorthand → approval/balance hint', () => {
    const err = new Error('execution reverted: STF')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    // STF appears first in scan, but message also contains "execution reverted";
    // the STF branch is more specific so it must win.
    expect(result.error).toContain('Token transfer would fail')
  })

  it('matches "Too little received" → slippage moved hint', () => {
    const err = new Error('Uniswap: Too little received')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('slippage')
  })

  it('falls back to generic "execution reverted" message when nothing else matches', () => {
    const err = new Error('execution reverted at 0xabc')
    const result = parseSimulationError(err)
    expect(result.success).toBe(false)
    expect(result.error).toContain('would fail on-chain')
  })
})

// ── Non-blocking unknown errors ──────────────────────────

describe('parseSimulationError — unknown errors are non-blocking', () => {
  it('returns success=true for an unrecognised message (RPC timeout etc.)', () => {
    const err = new Error('Network request timed out after 10s')
    const result = parseSimulationError(err)
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('returns success=true for a string thrown value', () => {
    const result = parseSimulationError('something unrecognised happened')
    expect(result.success).toBe(true)
  })

  it('returns success=true for a non-Error object', () => {
    const result = parseSimulationError({ code: -32603 })
    expect(result.success).toBe(true)
  })

  it('returns success=true for null/undefined', () => {
    expect(parseSimulationError(null).success).toBe(true)
    expect(parseSimulationError(undefined).success).toBe(true)
  })
})

// ── FeeCollector sender/recipient switch ─────────────────

describe('buildFeeCollectorSwapArgs', () => {
  const USER = '0x1111111111111111111111111111111111111111'
  const FEE_COLLECTOR = '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459'

  it('routeViaFeeCollector=true → from=FeeCollector, recipient=userWallet', () => {
    const args = buildFeeCollectorSwapArgs(true, USER, FEE_COLLECTOR)
    expect(args.from).toBe(FEE_COLLECTOR)
    expect(args.recipient).toBe(USER)
  })

  it('routeViaFeeCollector=false → from=userWallet, recipient=undefined', () => {
    const args = buildFeeCollectorSwapArgs(false, USER, FEE_COLLECTOR)
    expect(args.from).toBe(USER)
    expect(args.recipient).toBeUndefined()
  })

  it('never returns the user wallet as from when routing via FeeCollector (regression for P139)', () => {
    // The exact bug: previously `from` was always the user wallet, so the
    // aggregator built router calldata with transferFrom(user, ...) — but
    // the FeeCollector contract is the actual msg.sender, so the router
    // tried to pull tokens from a wallet that never approved it.
    const args = buildFeeCollectorSwapArgs(true, USER, FEE_COLLECTOR)
    expect(args.from).not.toBe(USER)
  })
})
