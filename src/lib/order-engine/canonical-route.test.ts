// @vitest-environment node
/**
 * [SPRINT-P1B / ADR-014 option (a)] Canonical pinned-route builder — determinism proof.
 *
 * The whole execution model rests on one property: the calldata signed at CREATION must still be
 * valid, byte-for-byte, at TRIGGER (arbitrarily later). That holds iff the calldata embeds no
 * quote-derived and no clock-derived bytes. These tests pin exactly that:
 *   - same inputs ⇒ same bytes (repeated, and across a simulated time jump)
 *   - every field is a pure function of the SIGNED order struct + static chain config
 *   - the fee math mirrors TeraSwapOrderExecutorV3.sol:518-519 exactly (FEE_BPS/BPS_DENOMINATOR
 *     are `constant` at :131-132, and non-DCA sets executeAmount = order.amountIn at :500)
 *   - recipient is the EXECUTOR, not the owner (the contract measures its own balance delta at
 *     :567/:579 and only then forwards to order.owner at :592)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { decodeAbiParameters, keccak256 } from 'viem'
import {
  buildCanonicalRoute,
  computeNetAmountIn,
  CANONICAL_FEE_TIERS,
  SWAPROUTER02_EXACT_INPUT_SINGLE_SELECTOR,
  EXACT_INPUT_SINGLE_PARAMS,
  ORDER_FEE_BPS,
  ORDER_BPS_DENOMINATOR,
} from './canonical-route'

// Base (8453) — the only chain P1b enables.
const WETH_BASE = '0x4200000000000000000000000000000000000006' as `0x${string}`
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`
const SWAPROUTER02_BASE = '0x2626664c2603336E57B271c5C0b26F421741e481' as `0x${string}`
const EXECUTOR_V3 = '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598' as `0x${string}`

function params(over: Partial<Parameters<typeof buildCanonicalRoute>[0]> = {}) {
  return {
    tokenIn: WETH_BASE,
    tokenOut: USDC_BASE,
    amountIn: 1_000000000000000000n, // 1 WETH
    minAmountOut: 2_900_000000n, // 2900 USDC (6dp)
    feeTier: 500 as const,
    router: SWAPROUTER02_BASE,
    recipient: EXECUTOR_V3,
    ...over,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('canonical-route [SPRINT-P1B] — determinism (the load-bearing property)', () => {
  it('same inputs ⇒ byte-identical calldata and hash, across repeated calls', () => {
    const a = buildCanonicalRoute(params())
    const b = buildCanonicalRoute(params())
    const c = buildCanonicalRoute(params())
    expect(a.routerData).toBe(b.routerData)
    expect(b.routerData).toBe(c.routerData)
    expect(a.routerDataHash).toBe(b.routerDataHash)
    expect(a.routerDataHash).toBe(keccak256(a.routerData))
  })

  it('is invariant across a large wall-clock jump (no deadline / no clock in the calldata)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'))
    const atSigning = buildCanonicalRoute(params())

    // Simulate the order sitting unfilled for 89 days and then triggering.
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
    const atTrigger = buildCanonicalRoute(params())

    expect(atTrigger.routerData).toBe(atSigning.routerData)
    expect(atTrigger.routerDataHash).toBe(atSigning.routerDataHash)
  })

  it('the encoded calldata contains no timestamp-like field at all (SwapRouter02 has no deadline)', () => {
    const { routerData } = buildCanonicalRoute(params())
    expect(routerData.slice(0, 10)).toBe(SWAPROUTER02_EXACT_INPUT_SINGLE_SELECTOR)
    // 7 fields × 32 bytes = 224 bytes of ABI body. The original SwapRouter's exactInputSingle
    // (selector 0x414bf389) carries 8 (it has `deadline`) — asserting the width pins that we
    // encoded the SwapRouter02 shape and therefore committed no clock.
    const body = routerData.slice(10)
    expect(body.length).toBe(224 * 2)
    expect(EXACT_INPUT_SINGLE_PARAMS[0].components).toHaveLength(7)
    expect(EXACT_INPUT_SINGLE_PARAMS[0].components.map(c => c.name)).not.toContain('deadline')
  })
})

describe('canonical-route [SPRINT-P1B] — field-by-field contract mirror', () => {
  it('decodes to exactly the signed values, with recipient = executor and amountIn = netAmount', () => {
    const p = params()
    const { routerData, netAmountIn } = buildCanonicalRoute(p)
    const [decoded] = decodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, `0x${routerData.slice(10)}`)
    const d = decoded as unknown as {
      tokenIn: string; tokenOut: string; fee: number; recipient: string
      amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint
    }

    expect(d.tokenIn.toLowerCase()).toBe(p.tokenIn.toLowerCase())
    expect(d.tokenOut.toLowerCase()).toBe(p.tokenOut.toLowerCase())
    expect(d.fee).toBe(p.feeTier)
    // [:563] the contract approves the router for netAmount ONLY — a gross amountIn here would
    // make the router pull more than approved and revert.
    expect(d.amountIn).toBe(netAmountIn)
    expect(d.amountIn).toBeLessThan(p.amountIn)
    // [:567/:579/:592] the executor measures ITS OWN balance delta, then forwards to order.owner.
    // A recipient of the owner would leave the delta at 0 and fail the floor.
    expect(d.recipient.toLowerCase()).toBe(EXECUTOR_V3.toLowerCase())
    expect(d.amountOutMinimum).toBe(p.minAmountOut)
    expect(d.sqrtPriceLimitX96).toBe(0n)
  })

  it('netAmount mirrors the contract fee math exactly, including floor division', () => {
    // fee = executeAmount * FEE_BPS / BPS_DENOMINATOR  [:518], netAmount = executeAmount - fee [:519]
    expect(ORDER_FEE_BPS).toBe(10n)
    expect(ORDER_BPS_DENOMINATOR).toBe(10_000n)
    expect(computeNetAmountIn(1_000000000000000000n)).toBe(999_000000000000000n)
    // Floor division: 9999 * 10 / 10000 = 9 (not 9.999) ⇒ net = 9990
    expect(computeNetAmountIn(9999n)).toBe(9999n - 9n)
    // A tiny amount whose fee floors to 0 keeps the full amount (matches Solidity integer math).
    expect(computeNetAmountIn(999n)).toBe(999n)
  })

  it('a different fee tier produces different bytes (the tier is committed in the hash)', () => {
    const t500 = buildCanonicalRoute(params({ feeTier: 500 }))
    const t3000 = buildCanonicalRoute(params({ feeTier: 3000 }))
    expect(t500.routerData).not.toBe(t3000.routerData)
    expect(t500.routerDataHash).not.toBe(t3000.routerDataHash)
  })
})

describe('canonical-route [SPRINT-P1B] — fail-closed validation', () => {
  it('rejects a non-canonical fee tier', () => {
    // @ts-expect-error deliberately invalid tier
    expect(() => buildCanonicalRoute(params({ feeTier: 1234 }))).toThrow(/fee tier/i)
  })

  it('rejects zero/negative amounts (contract reverts InvalidMinOutput / OrderTooSmall)', () => {
    expect(() => buildCanonicalRoute(params({ amountIn: 0n }))).toThrow(/amountIn/i)
    expect(() => buildCanonicalRoute(params({ minAmountOut: 0n }))).toThrow(/minAmountOut/i)
  })

  it('rejects tokenIn === tokenOut', () => {
    expect(() => buildCanonicalRoute(params({ tokenOut: WETH_BASE }))).toThrow(/same token/i)
  })

  it('rejects a missing recipient/router (fail-closed when v3 is not configured)', () => {
    expect(() => buildCanonicalRoute(params({ recipient: undefined as unknown as `0x${string}` }))).toThrow(/recipient/i)
    expect(() => buildCanonicalRoute(params({ router: undefined as unknown as `0x${string}` }))).toThrow(/router/i)
  })

  it('exposes exactly the four canonical Uniswap V3 fee tiers', () => {
    expect([...CANONICAL_FEE_TIERS]).toEqual([100, 500, 3000, 10000])
  })
})
