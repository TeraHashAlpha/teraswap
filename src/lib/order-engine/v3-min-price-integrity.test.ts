/**
 * [FIX-SIGNING-MIN-PRICE-INTEGRITY / INC-2026-08-07-001] Regression proof for the DCA signing
 * floor that a stale hardcoded price table poisoned.
 *
 * Order ef85438b (Base 8453, cbETH -> WETH, both 18dp) signed a `minAmountOut` derived from
 * `APPROX_PRICES.CBETH = 3600` on the tokenIn leg while the tokenOut leg priced live from
 * Chainlink. The resulting floor sat ~1.59x above market after the contract's per-chunk scaling
 * and was unfillable: 516 reverts, all in simulation, no gas spent.
 *
 * This file is the forensic anchor. The FIRST describe reproduces the historical number EXACTLY
 * from the pure arithmetic — that arithmetic is correct and stays unchanged, so this block must
 * keep passing forever. The remaining blocks pin the POLICY that stops a table price from ever
 * reaching a signed on-chain minimum again.
 */

import { describe, it, expect } from 'vitest'
import { deriveAbsoluteMinAmountOut, deriveSigningMinAmountOut } from './v3-min-derivation'

// ── The measured facts of order ef85438b ─────────────────────────────────────────────────────
/** TOTAL signed amountIn (dcaTotal = 3) — the amount the panel actually signs against. */
const AMOUNT_IN_TOTAL = 3186645813843290n
const DCA_TOTAL = 3n
const MAX_SLIPPAGE_BPS = 300
/** `APPROX_PRICES.CBETH` (src/lib/order-engine/usd.ts) — a hardcoded constant, not a feed. */
const CBETH_TABLE_PRICE = 3600
/**
 * The live Base Chainlink WETH/USD reading at signing, as its raw 8-decimal integer 194246585493.
 * Inverting the derivation pins this to a UNIQUE value: no other 8dp price reproduces the signed
 * number, so this is the feed answer itself, not a reconstruction.
 */
const WETH_CHAINLINK_PRICE = 1942.46585493
/** The `minAmountOut` actually signed and stored on order ef85438b. */
const SIGNED_MIN_AMOUNT_OUT = 5728680972022426n

describe('INC-2026-08-07-001 — historical reproduction (arithmetic is correct; the INPUT was not)', () => {
  it('reproduces the exact signed minAmountOut from the poisoned price pair', () => {
    const min = deriveAbsoluteMinAmountOut({
      amountIn: AMOUNT_IN_TOTAL,
      srcDecimals: 18,
      dstDecimals: 18,
      priceInUsd: CBETH_TABLE_PRICE,
      priceOutUsd: WETH_CHAINLINK_PRICE,
      maxSlippageBps: MAX_SLIPPAGE_BPS,
    })
    expect(min).toBe(SIGNED_MIN_AMOUNT_OUT)
  })

  it('the price ratio the signed number implies is the table/feed mismatch, not market', () => {
    // 3600 / 1942.46585493 = 1.853314 — cbETH was ~$2204 that day, i.e. a ratio of ~1.135.
    const impliedRatio = CBETH_TABLE_PRICE / WETH_CHAINLINK_PRICE
    expect(impliedRatio).toBeCloseTo(1.853314, 6)
    const trueRatio = 2204 / WETH_CHAINLINK_PRICE
    // The signed floor was overstated by ~63% purely because of the stale table entry.
    expect(impliedRatio / trueRatio).toBeCloseTo(1.6334, 3)
  })

  it('after the contract per-chunk scaling the floor is unfillable against a ~1.202e15 quote', () => {
    // Mirrors TeraSwapOrderExecutorV3.sol:526 for the FIRST chunk (execCount = 0):
    //   executeAmount = amountIn*(n+1)/dcaTotal - amountIn*n/dcaTotal
    //   scaledMin     = minAmountOut * executeAmount / amountIn
    const executeAmount =
      (AMOUNT_IN_TOTAL * 1n) / DCA_TOTAL - (AMOUNT_IN_TOTAL * 0n) / DCA_TOTAL
    const scaledMin = (SIGNED_MIN_AMOUNT_OUT * executeAmount) / AMOUNT_IN_TOTAL

    expect(executeAmount).toBe(1062215271281096n)
    expect(scaledMin).toBe(1909560324007474n)

    // The keeper's re-quotes came back ~1.202e15. The enforced floor was ~1.59x that.
    const marketQuote = 1202000000000000n
    expect(scaledMin > marketQuote).toBe(true)
    expect(Number(scaledMin) / Number(marketQuote)).toBeCloseTo(1.5887, 3)
  })
})

describe('D2 — a hardcoded table may NEVER price a signed on-chain minimum', () => {
  /** The exact ef85438b input shape: cbETH unpriced by both live sources, WETH on Chainlink. */
  const scenario = {
    amountIn: AMOUNT_IN_TOTAL,
    srcDecimals: 18,
    dstDecimals: 18,
    maxSlippageBps: MAX_SLIPPAGE_BPS,
    chainlinkPriceIn: null, // cbETH: no Chainlink feed reachable on Base
    chainlinkPriceOut: WETH_CHAINLINK_PRICE, // WETH: live Base Chainlink
    defiLlamaPriceIn: null, // cbETH: no DefiLlama price either
    defiLlamaPriceOut: null,
  }

  it('takes the ADR-013 no-feed path instead of signing a table-derived floor', () => {
    const r = deriveSigningMinAmountOut(scenario)

    // The whole point: the poisoned number must be unreachable.
    expect(r.minAmountOut).not.toBe(SIGNED_MIN_AMOUNT_OUT)
    // Fixed, non-price floor — ~0.0001 whole tokenOut at 18dp, never 1 wei.
    expect(r.minAmountOut).toBe(10n ** 14n)
    expect(r.minAmountOut).not.toBe(1n)
  })

  it('reports hasFeed=false and a non-chainlink source, so the decay warning fires', () => {
    const r = deriveSigningMinAmountOut(scenario)
    expect(r.hasFeed).toBe(false)
    expect(r.source).not.toBe('chainlink')
    expect(r.source).toBe('fallback')
  })

  it('the table cannot even be PASSED to the signing derivation (compiler-enforced)', () => {
    // The strongest form of this policy is one a future caller cannot opt out of. If
    // `approxPriceIn` is ever reintroduced to DeriveSigningMinParams, the @ts-expect-error below
    // becomes unused and `npm run typecheck` fails — so this pin cannot rot silently.
    const r = deriveSigningMinAmountOut({
      ...scenario,
      // @ts-expect-error — approxPriceIn was removed from DeriveSigningMinParams on purpose.
      approxPriceIn: 3600,
    })
    // And even smuggled in at runtime it changes nothing: the no-feed path still wins.
    expect(r.hasFeed).toBe(false)
    expect(r.minAmountOut).not.toBe(SIGNED_MIN_AMOUNT_OUT)
  })

  it('a leg priced ONLY by the table is treated as unpriced on either side', () => {
    // tokenOut unpriced live instead — same verdict, no asymmetry to exploit.
    const flipped = deriveSigningMinAmountOut({
      ...scenario,
      chainlinkPriceIn: WETH_CHAINLINK_PRICE,
      chainlinkPriceOut: null,
    })
    expect(flipped.hasFeed).toBe(false)
    expect(flipped.source).toBe('fallback')
  })
})

describe('D1 — the reported tier must be the WEAKEST of the two legs', () => {
  const base = {
    amountIn: 10n ** 18n,
    srcDecimals: 18,
    dstDecimals: 18,
    maxSlippageBps: 300,
  }

  it('in=defillama, out=chainlink reports "defillama" (was "chainlink": the amplifier)', () => {
    const r = deriveSigningMinAmountOut({
      ...base,
      chainlinkPriceIn: null,
      defiLlamaPriceIn: 2000,
      chainlinkPriceOut: 1,
      defiLlamaPriceOut: null,
    })
    expect(r.hasFeed).toBe(true)
    expect(r.source).toBe('defillama')
  })

  it('in=chainlink, out=defillama also reports "defillama" — the rule is symmetric', () => {
    const r = deriveSigningMinAmountOut({
      ...base,
      chainlinkPriceIn: 2000,
      defiLlamaPriceIn: null,
      chainlinkPriceOut: null,
      defiLlamaPriceOut: 1,
    })
    expect(r.hasFeed).toBe(true)
    expect(r.source).toBe('defillama')
  })

  it('only a both-Chainlink pair may report "chainlink"', () => {
    const r = deriveSigningMinAmountOut({
      ...base,
      chainlinkPriceIn: 2000,
      defiLlamaPriceIn: null,
      chainlinkPriceOut: 1,
      defiLlamaPriceOut: null,
    })
    expect(r.hasFeed).toBe(true)
    expect(r.source).toBe('chainlink')
  })
})
