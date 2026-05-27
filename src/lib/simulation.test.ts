/**
 * [P176] Unit tests for src/lib/simulation.ts.
 *
 * parseSimulationError sits on the swap critical path — every quote that
 * fails on-chain simulation is funneled through it before the user sees
 * an error. A regression here either swallows real reverts (user clicks
 * Swap on a broken route) or surfaces noise on legitimate quotes. This
 * suite pins every branch.
 */

import { describe, it, expect } from 'vitest'
import {
  parseSimulationError,
  buildFeeCollectorSwapArgs,
  FEE_COLLECTOR_ERROR_SELECTORS,
} from './simulation'

describe('parseSimulationError — FeeCollector custom errors', () => {
  describe('RouterNotWhitelisted', () => {
    it('matches the decoded human-readable name', () => {
      const result = parseSimulationError(new Error('reverted: RouterNotWhitelisted()'))
      expect(result.success).toBe(false)
      expect(result.error).toContain('not whitelisted')
    })

    it('matches the raw 4-byte selector', () => {
      const sel = FEE_COLLECTOR_ERROR_SELECTORS.RouterNotWhitelisted
      const result = parseSimulationError(new Error(`execution reverted: ${sel}`))
      expect(result.success).toBe(false)
      expect(result.error).toContain('not whitelisted')
    })
  })

  describe('InsufficientOutput', () => {
    it('matches the decoded human-readable name', () => {
      const result = parseSimulationError(new Error('reverted: InsufficientOutput(1,2)'))
      expect(result.success).toBe(false)
      expect(result.error).toContain('below minimum')
    })

    it('matches the raw 4-byte selector', () => {
      const sel = FEE_COLLECTOR_ERROR_SELECTORS.InsufficientOutput
      const result = parseSimulationError(new Error(`execution reverted: ${sel}`))
      expect(result.success).toBe(false)
      expect(result.error).toContain('below minimum')
    })
  })

  describe('SwapFailed', () => {
    it('matches the decoded human-readable name', () => {
      const result = parseSimulationError(new Error('reverted: SwapFailed(0x)'))
      expect(result.success).toBe(false)
      expect(result.error).toContain('DEX router call failed')
    })

    it('matches the raw 4-byte selector', () => {
      const sel = FEE_COLLECTOR_ERROR_SELECTORS.SwapFailed
      const result = parseSimulationError(new Error(`execution reverted: ${sel}`))
      expect(result.success).toBe(false)
      expect(result.error).toContain('DEX router call failed')
    })
  })

  describe('ZeroAmount', () => {
    it('matches the decoded human-readable name', () => {
      const result = parseSimulationError(new Error('reverted: ZeroAmount()'))
      expect(result.success).toBe(false)
      expect(result.error).toContain('zero')
    })

    it('matches the raw 4-byte selector', () => {
      const sel = FEE_COLLECTOR_ERROR_SELECTORS.ZeroAmount
      const result = parseSimulationError(new Error(`execution reverted: ${sel}`))
      expect(result.success).toBe(false)
      expect(result.error).toContain('zero')
    })
  })
})

describe('parseSimulationError — Generic reverts', () => {
  it("'insufficient funds' → ETH balance message", () => {
    const result = parseSimulationError(new Error('insufficient funds for gas * price + value'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Insufficient ETH balance')
  })

  it("'STF' → token transfer message", () => {
    const result = parseSimulationError(new Error('reverted: STF'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Token transfer')
  })

  it("'TRANSFER_FROM_FAILED' → token transfer message", () => {
    const result = parseSimulationError(new Error('TRANSFER_FROM_FAILED'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Token transfer')
  })

  it("'Too little received' → slippage message", () => {
    const result = parseSimulationError(new Error('Too little received'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('slippage')
  })

  it("'INSUFFICIENT_OUTPUT' → slippage message", () => {
    const result = parseSimulationError(new Error('INSUFFICIENT_OUTPUT_AMOUNT'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('slippage')
  })

  it("'execution reverted' fallback → generic revert message", () => {
    const result = parseSimulationError(new Error('execution reverted'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('reverted')
    expect(result.error).toContain('different route')
  })
})

describe('parseSimulationError — Unrecognised input', () => {
  it('returns { success: true } for an unrecognised Error message', () => {
    const result = parseSimulationError(new Error('something random went wrong'))
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('handles non-Error input via String() fallback', () => {
    const result = parseSimulationError('plain string error')
    expect(result.success).toBe(true)
  })

  it('handles null input', () => {
    const result = parseSimulationError(null)
    expect(result.success).toBe(true)
  })

  it('handles undefined input', () => {
    const result = parseSimulationError(undefined)
    expect(result.success).toBe(true)
  })
})

describe('parseSimulationError — Priority ordering', () => {
  it('FeeCollector custom error wins over a co-occurring generic "execution reverted"', () => {
    // Both substrings present — the parser must surface the more specific
    // FeeCollector message first.
    const result = parseSimulationError(
      new Error('SwapFailed: execution reverted with no reason'),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('DEX router call failed')
    expect(result.error).not.toContain('Simulation reverted')
  })

  it("'Too little received' wins over a co-occurring 'execution reverted'", () => {
    const result = parseSimulationError(
      new Error('execution reverted: Too little received'),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('slippage')
  })
})

describe('buildFeeCollectorSwapArgs', () => {
  const USER = '0x1111111111111111111111111111111111111111'
  const FC = '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459'

  it('returns FeeCollector as `from` and user as `recipient` when routing via FC', () => {
    const args = buildFeeCollectorSwapArgs(true, USER, FC)
    expect(args.from).toBe(FC)
    expect(args.recipient).toBe(USER)
  })

  it('returns user as `from` and `recipient` undefined when routing direct', () => {
    const args = buildFeeCollectorSwapArgs(false, USER, FC)
    expect(args.from).toBe(USER)
    expect(args.recipient).toBeUndefined()
  })
})

describe('FEE_COLLECTOR_ERROR_SELECTORS', () => {
  it('exports exactly the 4 known custom errors', () => {
    expect(Object.keys(FEE_COLLECTOR_ERROR_SELECTORS).sort()).toEqual([
      'InsufficientOutput',
      'RouterNotWhitelisted',
      'SwapFailed',
      'ZeroAmount',
    ])
  })

  it('every selector matches the 4-byte format (0x + 8 hex chars)', () => {
    const SELECTOR_RE = /^0x[0-9a-f]{8}$/
    for (const [name, sel] of Object.entries(FEE_COLLECTOR_ERROR_SELECTORS)) {
      expect(sel, `${name} selector format`).toMatch(SELECTOR_RE)
    }
  })

  it('all four selectors are distinct', () => {
    const values = Object.values(FEE_COLLECTOR_ERROR_SELECTORS)
    expect(new Set(values).size).toBe(values.length)
  })
})
