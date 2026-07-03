/**
 * [CHORE-QUOTE-QUORUM / W7-L-02] Low-quorum display sanity.
 *
 * With fewer than 3 responders the 3×-median outlier filter in fetchMetaQuote
 * is mathematically inert (n=2 ⇒ threshold = 1.5×max ⇒ nothing is ever
 * dropped), so a 10^n-mis-scaled quote (the OpenOcean case) or a manipulated
 * quote wins the DISPLAYED best price. applyLowQuorumSanity bounds the winner
 * to the runner-up: a winner beyond the deviation band is demoted from the
 * display (execution gates are untouched — this is display selection only).
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  applyLowQuorumSanity,
  getLowQuorumMaxDeviationBps,
  LOW_QUORUM_MAX_DEVIATION_BPS,
} from './quote-quorum'
import type { NormalizedQuote } from './adapters/types'

function q(source: string, toAmount: string): NormalizedQuote {
  return {
    source: source as NormalizedQuote['source'],
    toAmount,
    estimatedGas: 0,
    gasUsd: 0,
    routes: [source],
  }
}

afterEach(() => {
  delete process.env.LOW_QUORUM_MAX_DEVIATION_BPS
})

describe('applyLowQuorumSanity — 2 responders (the inert-filter quorum)', () => {
  it('demotes a 10^n mis-scaled winner (OpenOcean garbage case) — it CANNOT win the display', () => {
    // Real shape of the OpenOcean units bug: raw-units amount 10^12× the sane one.
    const garbage = q('openocean', '1715868544000000000000')
    const sane = q('kyberswap', '1715868544')
    const out = applyLowQuorumSanity([garbage, sane]) // sorted best-first, garbage "wins"

    expect(out.quotes[0]?.source).toBe('kyberswap') // sane runner-up becomes the displayed best
    expect(out.quotes.map(x => x.source)).not.toContain('openocean')
    expect(out.demoted.map(x => x.source)).toContain('openocean')
    expect(out.lowConfidence).toBe(true) // remaining single quote is unvalidated
  })

  it('does NOT drop either quote when both are sane (0.2% apart)', () => {
    const a = q('kyberswap', '1003000000')
    const b = q('velora', '1001000000')
    const out = applyLowQuorumSanity([a, b])

    expect(out.quotes).toHaveLength(2)
    expect(out.quotes[0]?.source).toBe('kyberswap') // winner unchanged
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })

  it('keeps a winner exactly AT the deviation band (boundary is inclusive)', () => {
    // runner-up 10_000; band 500 bps ⇒ max allowed winner = 10_500.
    const winner = q('kyberswap', '10500')
    const runner = q('velora', '10000')
    const out = applyLowQuorumSanity([winner, runner])
    expect(out.quotes[0]?.source).toBe('kyberswap')
    expect(out.demoted).toHaveLength(0)
  })

  it('demotes a winner just OVER the deviation band', () => {
    const winner = q('kyberswap', '10501')
    const runner = q('velora', '10000')
    const out = applyLowQuorumSanity([winner, runner])
    expect(out.quotes[0]?.source).toBe('velora')
    expect(out.demoted.map(x => x.source)).toEqual(['kyberswap'])
    expect(out.lowConfidence).toBe(true)
  })

  it('keeps the winner but flags low confidence when the runner-up amount is unparseable', () => {
    const winner = q('kyberswap', '1000000')
    const runner = q('velora', 'not-a-number')
    const out = applyLowQuorumSanity([winner, runner])
    expect(out.quotes[0]?.source).toBe('kyberswap') // no band available — never false-drop
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(true)
  })
})

describe('applyLowQuorumSanity — other quorums', () => {
  it('1 responder: kept as best (no false drop), flagged low-confidence (zero cross-check)', () => {
    const only = q('uniswapv3', '123456')
    const out = applyLowQuorumSanity([only])
    expect(out.quotes).toEqual([only])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(true)
  })

  it('3+ responders: passthrough untouched (the median outlier filter owns that quorum)', () => {
    const quotes = [q('kyberswap', '300'), q('velora', '200'), q('cowswap', '100')]
    const out = applyLowQuorumSanity(quotes)
    expect(out.quotes).toEqual(quotes)
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })

  it('0 responders: passthrough (caller already handles the empty case)', () => {
    const out = applyLowQuorumSanity([])
    expect(out.quotes).toEqual([])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })
})

describe('deviation band configuration', () => {
  it('defaults to 500 bps (5%)', () => {
    expect(LOW_QUORUM_MAX_DEVIATION_BPS).toBe(500)
    expect(getLowQuorumMaxDeviationBps()).toBe(500)
  })

  it('honours LOW_QUORUM_MAX_DEVIATION_BPS env override', () => {
    process.env.LOW_QUORUM_MAX_DEVIATION_BPS = '100'
    expect(getLowQuorumMaxDeviationBps()).toBe(100)
    // 2% apart with a 1% band ⇒ demoted under the override.
    const out = applyLowQuorumSanity([q('kyberswap', '10200'), q('velora', '10000')])
    expect(out.quotes[0]?.source).toBe('velora')
  })

  it('falls back to the default on a non-numeric / non-positive override', () => {
    process.env.LOW_QUORUM_MAX_DEVIATION_BPS = 'banana'
    expect(getLowQuorumMaxDeviationBps()).toBe(500)
    process.env.LOW_QUORUM_MAX_DEVIATION_BPS = '-5'
    expect(getLowQuorumMaxDeviationBps()).toBe(500)
  })
})
