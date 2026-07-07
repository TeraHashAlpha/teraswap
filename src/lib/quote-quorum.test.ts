/**
 * [CHORE-QUOTE-QUORUM / W7-L-02] Low-quorum display sanity.
 *
 * With fewer than 3 responders the 3×-median outlier filter in fetchMetaQuote
 * is mathematically inert (n=2 ⇒ threshold = 1.5×max ⇒ nothing is ever
 * dropped), so a 10^n-mis-scaled quote (the OpenOcean case) or a manipulated
 * quote wins the DISPLAYED best price. applyLowQuorumSanity bounds the winner
 * to the runner-up: a winner beyond the deviation band is demoted, so the
 * runner-up becomes the PRESENTED best — the quote the user is then steered
 * to sign and execute [CHORE-QUORUM-LOWCONFIDENCE-FIX: this is execution-
 * selection-adjacent, not "display selection only"]. The execution gates
 * themselves (SC-04 / R1 / on-chain minimumOutput) are untouched.
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

// ─────────────────────────────────────────────────────────────────────────
// [CHORE-QUORUM-LOWCONFIDENCE-FIX] Adversarial 2-responder window.
//
// Threat model: ONE of the two responding sources returns an attacker-
// controlled or defective amount; the other is honest at fair market M. The
// band sees a single pairwise spread, so it cannot know which side is lying —
// these tests pin exactly what each manipulation shape can and cannot achieve
// in the PRESENTED best (i.e. the quote the user is steered to execute).
//
// Reconciliation with the #248 DCA deviation guard (contracts/order-engine/
// executor/deviation-guard.js): that gate runs KEEPER-side at DCA fill time,
// compares the order's already-PINNED router against a fresh cross-aggregator
// best (1% threshold, fail-open), and can only DEFER a fill within a bounded
// window — it never re-routes and never sees this interactive display path.
// Different layer, different time, different question → no conflict, and
// neither module relies on the other.
// ─────────────────────────────────────────────────────────────────────────
describe('adversarial 2-responder window — manipulated source vs the demotion [CHORE-QUORUM-LOWCONFIDENCE-FIX]', () => {
  const M = 1_000_000_000_000n // honest fair-market output (1e12 raw units)

  it('(b) an inflated attacker winner beyond the band is demoted — never presented as best', () => {
    // +6% premium and a 100× mis-scale both land beyond the 500 bps band.
    for (const bad of ['1060000000000', '100000000000000']) {
      const out = applyLowQuorumSanity([q('openocean', bad), q('kyberswap', M.toString())])
      expect(out.quotes[0]?.source).toBe('kyberswap')
      expect(out.quotes.map(x => x.source)).not.toContain('openocean')
      expect(out.demoted.map(x => x.source)).toEqual(['openocean'])
      expect(out.lowConfidence).toBe(true)
    }
  })

  it('(b-residual) an attacker premium WITHIN the band is presented as best — designed limit of any pairwise band', () => {
    // +4.9% ≤ 500 bps: indistinguishable from a legitimately better route, so it
    // stays the presented best. ACCEPTED residual (not a gap): what the user can
    // actually receive is still bounded by that quote's own slippage/on-chain
    // minimumOutput, and a tighter band would false-drop real thin-market spreads.
    const out = applyLowQuorumSanity([q('openocean', '1049000000000'), q('kyberswap', M.toString())])
    expect(out.quotes[0]?.source).toBe('openocean')
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })

  it('(a) a low-ball attacker WITHIN the band cannot demote an honest winner', () => {
    // Attacker quotes 4% under market: the honest winner stays the presented best
    // and the result is not even flagged — mild low-balling achieves nothing.
    const out = applyLowQuorumSanity([q('kyberswap', M.toString()), q('openocean', '960000000000')])
    expect(out.quotes[0]?.source).toBe('kyberswap')
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })

  it('(a) FLAGGED GAP (Auditor): a low-ball attacker BEYOND the band demotes the honest winner — the attacker quote is presented as best', () => {
    // CHARACTERIZATION, NOT ENDORSEMENT. Because the band always demotes the
    // WINNER, a source quoting >500 bps UNDER an honest winner (here −6%) gets the
    // honest quote demoted and ITSELF presented as best — steering the user to the
    // worse quote. Fixing this is explicitly out of scope for this chore (no
    // algorithm/threshold change) — flagged for the Auditor pass in FEEDBACK.md.
    // The user is not steered SILENTLY: lowConfidence is guaranteed (asserted
    // below, rendered in QuoteBreakdown since this chore); on feeded pairs the
    // client Chainlink gate requires explicit informed consent from 2% deviation
    // and hard-blocks beyond the 25% ceiling (price-gate.ts); the server-side
    // DefiLlama guard (422) is non-overridable; and the executed fill is still
    // bounded by its own on-chain minimumOutput.
    const out = applyLowQuorumSanity([q('kyberswap', M.toString()), q('openocean', '940000000000')])
    expect(out.quotes[0]?.source).toBe('openocean') // ← the gap: attacker presented as best
    expect(out.demoted.map(x => x.source)).toEqual(['kyberswap']) // honest winner demoted
    expect(out.lowConfidence).toBe(true) // …but never silently: the flag always fires
  })

  it('demotion and lowConfidence are deterministic and side-effect-free (frozen input, repeated calls)', () => {
    const winner = q('kyberswap', '10600')
    const runner = q('velora', '10000')
    const input = [winner, runner]
    Object.freeze(input)
    const first = applyLowQuorumSanity(input)
    for (let i = 0; i < 50; i++) {
      expect(applyLowQuorumSanity(input)).toEqual(first)
    }
    expect(input[0]).toBe(winner) // input untouched (no mutation, no reorder)
    expect(input[1]).toBe(runner)
    expect(first.quotes.map(x => x.source)).toEqual(['velora'])
    expect(first.demoted.map(x => x.source)).toEqual(['kyberswap'])
    expect(first.lowConfidence).toBe(true)
  })

  it('an exact 2-source tie is kept, unflagged, and stable (no order-dependent demotion)', () => {
    const out = applyLowQuorumSanity([q('kyberswap', '10000'), q('velora', '10000')])
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'velora'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })
})
