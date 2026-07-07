/**
 * [CHORE-QUOTE-QUORUM / W7-L-02] Low-quorum display sanity.
 *
 * With fewer than 3 responders the 3×-median outlier filter in fetchMetaQuote
 * is mathematically inert (n=2 ⇒ threshold = 1.5×max ⇒ nothing is ever
 * dropped), so a 10^n-mis-scaled quote (the OpenOcean case) or a manipulated
 * quote wins the DISPLAYED best price. applyLowQuorumSanity bounds the winner
 * to the runner-up — and, since CHORE-QUORUM-REFERENCE-CONFIRMED-DEMOTION
 * (NEW2-M-01), a pairwise band trip alone no longer demotes anything: the
 * demotion must be CONFIRMED by an external reference (the #18 Chainlink
 * consent-gate feed / #248 DefiLlama plumbing, reused — never rebuilt). The
 * reference says which side of the spread lies: a confirmed winner survives a
 * low-balling runner-up; a winner the reference marks as the outlier (the
 * mis-scale case) is still demoted. With NO reference the module falls back
 * to flag-without-reorder: lowConfidence fires, nothing is demoted. The
 * execution gates (SC-04 / R1 / on-chain minimumOutput) are untouched and
 * remain the terminal backstop for whatever quote is presented.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  applyLowQuorumSanity,
  applyLowQuorumSanityWithReference,
  computeReferenceToAmount,
  getLowQuorumMaxDeviationBps,
  lowQuorumBandTripped,
  resolveQuorumReference,
  LOW_QUORUM_MAX_DEVIATION_BPS,
} from './quote-quorum'
import { fetchChainlinkPriceRaw } from './chainlink'
import { fetchDefiLlamaPrice } from './defillama'
import { DEFAULT_CHAIN_ID } from './chains/registry'
import type { NormalizedQuote } from './adapters/types'

// resolveQuorumReference is exercised against mocked I/O fetchers — the mocks
// sit exactly at the module's network boundary; everything above them (leg
// pairing, fallback order, slug threading, never-throw) runs for real. The
// fetchers' own validation (Chainlink round integrity / staleness, DefiLlama
// confidence ≥ 0.5) is covered by chainlink/defillama's own suites.
vi.mock('./chainlink', () => ({
  fetchChainlinkPriceRaw: vi.fn(),
}))
vi.mock('./defillama', () => ({
  fetchDefiLlamaPrice: vi.fn(),
}))

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
  it('demotes a 10^n mis-scaled winner (OpenOcean garbage case) when the reference confirms the runner-up', () => {
    // Real shape of the OpenOcean units bug: raw-units amount 10^12× the sane
    // one. The reference (≈ the sane quote) marks the winner as the outlier,
    // so the #260 mis-scale defence is preserved under reference-confirmation.
    const garbage = q('openocean', '1715868544000000000000')
    const sane = q('kyberswap', '1715868544')
    const out = applyLowQuorumSanity([garbage, sane], 1715868544n)

    expect(out.quotes[0]?.source).toBe('kyberswap') // sane runner-up becomes the displayed best
    expect(out.quotes.map(x => x.source)).not.toContain('openocean')
    expect(out.demoted.map(x => x.source)).toContain('openocean')
    expect(out.lowConfidence).toBe(true) // remaining single quote is unvalidated
  })

  it('keeps a 10^n mis-scaled winner but flags it when NO reference exists (flag-without-reorder)', () => {
    // Oracle-less AND DefiLlama-less pair: the band cannot tell which side
    // lies, so it must not reorder — demotion here is exactly the lever the
    // NEW2-M-01 low-ball attacker pulled. Residual mis-scale risk is bounded
    // by on-chain minimumOutput (a garbage-high fill reverts), the tiered USD
    // limits (oracle-less >$10k blocked) and the rendered lowConfidence cue.
    const garbage = q('openocean', '1715868544000000000000')
    const sane = q('kyberswap', '1715868544')
    const out = applyLowQuorumSanity([garbage, sane])

    expect(out.quotes.map(x => x.source)).toEqual(['openocean', 'kyberswap']) // order untouched
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(true) // …but never silently
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

  it('keeps a winner exactly AT the deviation band (boundary is inclusive) — with or without a reference', () => {
    // runner-up 10_000; band 500 bps ⇒ max allowed winner = 10_500. The band
    // never trips, so the reference is irrelevant (it gates demotion only —
    // it never CREATES one).
    const winner = q('kyberswap', '10500')
    const runner = q('velora', '10000')
    for (const ref of [undefined, 10000n]) {
      const out = applyLowQuorumSanity([winner, runner], ref)
      expect(out.quotes[0]?.source).toBe('kyberswap')
      expect(out.demoted).toHaveLength(0)
      expect(out.lowConfidence).toBe(false)
    }
  })

  it('demotes a winner just OVER the band when the reference confirms the runner-up', () => {
    const winner = q('kyberswap', '10501')
    const runner = q('velora', '10000')
    const out = applyLowQuorumSanity([winner, runner], 10000n)
    expect(out.quotes[0]?.source).toBe('velora')
    expect(out.demoted.map(x => x.source)).toEqual(['kyberswap'])
    expect(out.lowConfidence).toBe(true)
  })

  it('flags-without-reorder a winner just OVER the band when no reference exists', () => {
    const winner = q('kyberswap', '10501')
    const runner = q('velora', '10000')
    const out = applyLowQuorumSanity([winner, runner])
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'velora'])
    expect(out.demoted).toHaveLength(0)
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

  it('demotes an unparseable winner amount defensively — a data-integrity defect needs no price reference', () => {
    // Not a price judgment: a toAmount BigInt cannot parse is garbage by
    // construction (the caller pre-filters non-positive amounts), so the
    // reference-confirmation gate does not apply.
    const winner = q('openocean', 'not-a-number')
    const runner = q('kyberswap', '1000000')
    const out = applyLowQuorumSanity([winner, runner])
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap'])
    expect(out.demoted.map(x => x.source)).toEqual(['openocean'])
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
    // 2% apart with a 1% band ⇒ demoted under the override — the override
    // band also gates the reference check (winner +2% vs reference > 1%).
    const out = applyLowQuorumSanity([q('kyberswap', '10200'), q('velora', '10000')], 10000n)
    expect(out.quotes[0]?.source).toBe('velora')
  })

  it('falls back to the default on a non-numeric / non-positive override', () => {
    process.env.LOW_QUORUM_MAX_DEVIATION_BPS = 'banana'
    expect(getLowQuorumMaxDeviationBps()).toBe(500)
    process.env.LOW_QUORUM_MAX_DEVIATION_BPS = '-5'
    expect(getLowQuorumMaxDeviationBps()).toBe(500)
  })
})

describe('lowQuorumBandTripped — the lazy-reference predicate', () => {
  it('trips only for exactly-2 parseable responders spread beyond the band', () => {
    expect(lowQuorumBandTripped([q('kyberswap', '10600'), q('velora', '10000')])).toBe(true)
    expect(lowQuorumBandTripped([q('kyberswap', '10500'), q('velora', '10000')])).toBe(false) // at band: inclusive keep
    expect(lowQuorumBandTripped([q('kyberswap', '10000'), q('velora', '10000')])).toBe(false) // tie
  })

  it('never trips outside the 2-responder quorum', () => {
    expect(lowQuorumBandTripped([])).toBe(false)
    expect(lowQuorumBandTripped([q('uniswapv3', '123456')])).toBe(false)
    expect(lowQuorumBandTripped([q('kyberswap', '300'), q('velora', '200'), q('cowswap', '100')])).toBe(false)
  })

  it('never trips when either amount is unparseable (no band exists; no reference fetch needed)', () => {
    expect(lowQuorumBandTripped([q('kyberswap', 'nope'), q('velora', '10000')])).toBe(false)
    expect(lowQuorumBandTripped([q('kyberswap', '10600'), q('velora', 'nope')])).toBe(false)
  })

  it('honours the env band override', () => {
    process.env.LOW_QUORUM_MAX_DEVIATION_BPS = '100'
    expect(lowQuorumBandTripped([q('kyberswap', '10200'), q('velora', '10000')])).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// [CHORE-QUORUM-LOWCONFIDENCE-FIX → CHORE-QUORUM-REFERENCE-CONFIRMED-DEMOTION]
// Adversarial 2-responder window.
//
// Threat model: ONE of the two responding sources returns an attacker-
// controlled or defective amount; the other is honest at fair market M. The
// band sees a single pairwise spread and cannot know which side is lying —
// so demotion is gated behind an external reference that CAN (NEW2-M-01,
// Option 2). These tests pin exactly what each manipulation shape can and
// cannot achieve in the PRESENTED best (the quote the user is steered to
// execute), in BOTH regimes: reference available / no reference.
//
// Reconciliation with the #248 DCA deviation guard (contracts/order-engine/
// executor/deviation-guard.js): that gate runs KEEPER-side at DCA fill time,
// compares the order's already-PINNED router against a fresh cross-aggregator
// best (1% threshold, fail-open), and can only DEFER a fill within a bounded
// window — it never re-routes and never sees this interactive display path.
// Different layer, different time, different question → no conflict. This
// module reuses #248's PRICE plumbing (fetchDefiLlamaPrice), not that gate.
// ─────────────────────────────────────────────────────────────────────────
describe('adversarial 2-responder window — manipulated source vs reference-confirmed demotion [NEW2-M-01]', () => {
  const M = 1_000_000_000_000n // honest fair-market output (1e12 raw units)

  it('(b) an inflated attacker winner beyond the band is demoted when the reference confirms the honest runner-up', () => {
    // +6% premium and a 100× mis-scale both land beyond the 500 bps band AND
    // beyond the band vs the reference (≈ M) — the reference confirms the
    // WINNER is the outlier, so the demotion fires exactly as before #NEW2-M-01.
    for (const bad of ['1060000000000', '100000000000000']) {
      const out = applyLowQuorumSanity([q('openocean', bad), q('kyberswap', M.toString())], M)
      expect(out.quotes[0]?.source).toBe('kyberswap')
      expect(out.quotes.map(x => x.source)).not.toContain('openocean')
      expect(out.demoted.map(x => x.source)).toEqual(['openocean'])
      expect(out.lowConfidence).toBe(true)
    }
  })

  it('(b-fallback) an inflated winner beyond the band is flagged but NOT demoted when no reference exists', () => {
    // ACCEPTED residual of the no-reference regime (spec'd by the Architect):
    // without a reference the band cannot prove which side lies, so it only
    // flags. What the user can actually LOSE is still bounded on-chain: a
    // garbage-high quote produces a minimumOutput no pool will fill (revert,
    // not loss), and oracle-less pairs are already USD-capped (>$10k blocked).
    const out = applyLowQuorumSanity([q('openocean', '1060000000000'), q('kyberswap', M.toString())])
    expect(out.quotes.map(x => x.source)).toEqual(['openocean', 'kyberswap'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(true)
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

  it('(a) FIXED (NEW2-M-01): a low-ball attacker BEYOND the band can NO LONGER demote a reference-confirmed honest winner', () => {
    // The former FLAGGED GAP, closed. The attacker quotes −6% (beyond the
    // band) to inflate the pairwise spread; the reference (≈ M) confirms the
    // winner is NOT the outlier ⇒ no demotion, regardless of the spread. The
    // honest quote stays the presented best and — having been cross-validated
    // by an external reference — is not flagged either: the attacker achieves
    // nothing at all.
    const out = applyLowQuorumSanity([q('kyberswap', M.toString()), q('openocean', '940000000000')], M)
    expect(out.quotes[0]?.source).toBe('kyberswap') // honest winner survives
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'openocean']) // nothing reordered
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false) // reference-confirmed ⇒ cross-validated
  })

  it('(a-fallback) a low-ball attacker BEYOND the band on a NO-reference pair only triggers the flag — the honest winner is still presented', () => {
    // Even oracle-less + DefiLlama-less pairs no longer hand the attacker the
    // presented-best slot: flag-without-reorder keeps the honest winner first.
    const out = applyLowQuorumSanity([q('kyberswap', M.toString()), q('openocean', '940000000000')])
    expect(out.quotes[0]?.source).toBe('kyberswap') // ← the old gap is gone: winner keeps the slot
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'openocean'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(true) // unconfirmable ⇒ flagged
  })

  it('a reference-confirmed runner-up-is-better case still demotes (not only the 10^n shapes)', () => {
    // Winner +10% over the reference, runner-up ON the reference: the spread
    // trips the band and the reference marks the winner as the outlier — the
    // sane runner-up must take the presented-best slot.
    const out = applyLowQuorumSanity([q('openocean', '1100000000000'), q('kyberswap', M.toString())], M)
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap'])
    expect(out.demoted.map(x => x.source)).toEqual(['openocean'])
    expect(out.lowConfidence).toBe(true)
  })

  it('winner-vs-reference boundary is inclusive: a winner exactly AT the band vs the reference is kept', () => {
    // runner 9_900 → spread ~606 bps (band tripped); winner 10_500 is exactly
    // +500 bps vs reference 10_000 ⇒ confirmed (inclusive), not demoted.
    const out = applyLowQuorumSanity([q('kyberswap', '10500'), q('velora', '9900')], 10000n)
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'velora'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })

  it('a winner BELOW the reference beyond the band is kept but flagged — demotion would present something even lower', () => {
    // Stale-reference / moved-market shape: BOTH quotes sit under the
    // reference (winner −10%, runner −20%). The winner cannot be confirmed,
    // but demoting it would steer the user to the WORSE quote — exactly the
    // lever NEW2-M-01 removes. Keep order, flag it.
    const out = applyLowQuorumSanity([q('kyberswap', '900000000000'), q('openocean', '800000000000')], M)
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'openocean'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(true)
  })

  it('a non-positive reference is treated as no-reference (flag-without-reorder)', () => {
    for (const ref of [0n, -1n]) {
      const out = applyLowQuorumSanity([q('kyberswap', M.toString()), q('openocean', '940000000000')], ref)
      expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'openocean'])
      expect(out.demoted).toHaveLength(0)
      expect(out.lowConfidence).toBe(true)
    }
  })

  it('demotion and lowConfidence are deterministic and side-effect-free in BOTH regimes (frozen input, repeated calls)', () => {
    const winner = q('kyberswap', '10600')
    const runner = q('velora', '10000')
    const input = [winner, runner]
    Object.freeze(input)

    // Referenced regime: reference confirms the runner-up ⇒ stable demotion.
    const withRef = applyLowQuorumSanity(input, 10000n)
    for (let i = 0; i < 50; i++) {
      expect(applyLowQuorumSanity(input, 10000n)).toEqual(withRef)
    }
    expect(withRef.quotes.map(x => x.source)).toEqual(['velora'])
    expect(withRef.demoted.map(x => x.source)).toEqual(['kyberswap'])
    expect(withRef.lowConfidence).toBe(true)

    // No-reference regime: stable flag-without-reorder.
    const noRef = applyLowQuorumSanity(input)
    for (let i = 0; i < 50; i++) {
      expect(applyLowQuorumSanity(input)).toEqual(noRef)
    }
    expect(noRef.quotes.map(x => x.source)).toEqual(['kyberswap', 'velora'])
    expect(noRef.demoted).toHaveLength(0)
    expect(noRef.lowConfidence).toBe(true)

    expect(input[0]).toBe(winner) // input untouched (no mutation, no reorder)
    expect(input[1]).toBe(runner)
  })

  it('an exact 2-source tie is kept, unflagged, and stable (no order-dependent demotion)', () => {
    const out = applyLowQuorumSanity([q('kyberswap', '10000'), q('velora', '10000')])
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'velora'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
  })
})

describe('computeReferenceToAmount — fair expected output from two USD legs', () => {
  it('converts across decimals exactly like the #248 fair-value formula (USDC 6dp → WETH 18dp)', () => {
    // 3_000 USDC at $1 into WETH at $3_000 ⇒ 1 WETH = 10^18 raw.
    const ref = computeReferenceToAmount({
      amount: '3000000000', srcDecimals: 6, dstDecimals: 18, srcUsd: 1, dstUsd: 3000,
    })
    expect(ref).toBe(10n ** 18n)
  })

  it('converts back down in decimals (WETH 18dp → USDC 6dp)', () => {
    const ref = computeReferenceToAmount({
      amount: '1000000000000000000', srcDecimals: 18, dstDecimals: 6, srcUsd: 3000, dstUsd: 1,
    })
    expect(ref).toBe(3_000_000_000n)
  })

  it('is the identity for equal prices and equal decimals', () => {
    const ref = computeReferenceToAmount({
      amount: '1000000000000', srcDecimals: 12, dstDecimals: 12, srcUsd: 5, dstUsd: 5,
    })
    expect(ref).toBe(1_000_000_000_000n)
  })

  it('stays finite and proportionate on amounts beyond 2^53 (float precision is bounded by the 500 bps use)', () => {
    // 5M tokens of an 18dp asset = 5e24 raw — far beyond Number.MAX_SAFE_INTEGER.
    const ref = computeReferenceToAmount({
      amount: '5000000000000000000000000', srcDecimals: 18, dstDecimals: 18, srcUsd: 1, dstUsd: 2,
    })
    expect(ref).not.toBeNull()
    // Expected 2.5e24; assert within 1 ppm — float rounding is orders of
    // magnitude below the 500 bps decision threshold.
    const expected = 2_500_000_000_000_000_000_000_000n
    const diff = ref! > expected ? ref! - expected : expected - ref!
    expect(diff < expected / 1_000_000n).toBe(true)
  })

  it('returns null on unusable prices (zero / negative / NaN / Infinity)', () => {
    const base = { amount: '1000000', srcDecimals: 6, dstDecimals: 6 }
    expect(computeReferenceToAmount({ ...base, srcUsd: 0, dstUsd: 1 })).toBeNull()
    expect(computeReferenceToAmount({ ...base, srcUsd: -1, dstUsd: 1 })).toBeNull()
    expect(computeReferenceToAmount({ ...base, srcUsd: 1, dstUsd: 0 })).toBeNull()
    expect(computeReferenceToAmount({ ...base, srcUsd: NaN, dstUsd: 1 })).toBeNull()
    expect(computeReferenceToAmount({ ...base, srcUsd: 1, dstUsd: Infinity })).toBeNull()
  })

  it('returns null on an unusable amount or decimals', () => {
    expect(computeReferenceToAmount({ amount: 'nope', srcDecimals: 6, dstDecimals: 6, srcUsd: 1, dstUsd: 1 })).toBeNull()
    expect(computeReferenceToAmount({ amount: '0', srcDecimals: 6, dstDecimals: 6, srcUsd: 1, dstUsd: 1 })).toBeNull()
    expect(computeReferenceToAmount({ amount: '-5', srcDecimals: 6, dstDecimals: 6, srcUsd: 1, dstUsd: 1 })).toBeNull()
    expect(computeReferenceToAmount({ amount: '1000000', srcDecimals: NaN, dstDecimals: 6, srcUsd: 1, dstUsd: 1 })).toBeNull()
    expect(computeReferenceToAmount({ amount: '1000000', srcDecimals: 6, dstDecimals: 6.5, srcUsd: 1, dstUsd: 1 })).toBeNull()
  })
})

describe('resolveQuorumReference — reuses the #18 Chainlink / #248 DefiLlama plumbing (never builds its own)', () => {
  const params = {
    src: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC-shaped
    dst: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH-shaped
    amount: '3000000000',
    srcDecimals: 6,
    dstDecimals: 18,
  }

  beforeEach(() => {
    vi.mocked(fetchChainlinkPriceRaw).mockReset()
    vi.mocked(fetchDefiLlamaPrice).mockReset()
    vi.mocked(fetchChainlinkPriceRaw).mockResolvedValue(null)
    vi.mocked(fetchDefiLlamaPrice).mockResolvedValue(null)
  })

  it('prefers the Chainlink consent-gate feed when BOTH legs price — DefiLlama is not even consulted', async () => {
    vi.mocked(fetchChainlinkPriceRaw).mockImplementation(async (addr: string) =>
      addr === params.src
        ? { price: 1, updatedAt: 1_700_000_000, roundId: 1n }
        : { price: 3000, updatedAt: 1_700_000_000, roundId: 1n },
    )
    const ref = await resolveQuorumReference(params)
    expect(ref).toEqual({ toAmount: 10n ** 18n, source: 'chainlink' })
    expect(fetchDefiLlamaPrice).not.toHaveBeenCalled()
    // chainId omitted ⇒ mainnet default threaded into the feed read.
    expect(fetchChainlinkPriceRaw).toHaveBeenCalledWith(params.src, DEFAULT_CHAIN_ID)
    expect(fetchChainlinkPriceRaw).toHaveBeenCalledWith(params.dst, DEFAULT_CHAIN_ID)
  })

  it('falls back to the DefiLlama price when a Chainlink leg is missing (feed-less token)', async () => {
    vi.mocked(fetchChainlinkPriceRaw).mockImplementation(async (addr: string) =>
      addr === params.src ? { price: 1, updatedAt: 1_700_000_000, roundId: 1n } : null,
    )
    vi.mocked(fetchDefiLlamaPrice).mockImplementation(async (addr: string) =>
      addr === params.src
        ? { price: 1, symbol: 'USDC', timestamp: 1_700_000_000, confidence: 0.99 }
        : { price: 3000, symbol: 'WETH', timestamp: 1_700_000_000, confidence: 0.99 },
    )
    const ref = await resolveQuorumReference(params)
    expect(ref).toEqual({ toAmount: 10n ** 18n, source: 'defillama' })
    // Same chain-slug mapping as the swap-route DefiLlama guard (G2): mainnet → 'ethereum'.
    expect(fetchDefiLlamaPrice).toHaveBeenCalledWith(params.src, 'ethereum')
    expect(fetchDefiLlamaPrice).toHaveBeenCalledWith(params.dst, 'ethereum')
  })

  it('threads a non-mainnet chain into both plumbings (chainId 8453 → Base feeds, base slug)', async () => {
    vi.mocked(fetchDefiLlamaPrice).mockImplementation(async (addr: string) =>
      addr === params.src
        ? { price: 1, symbol: 'USDC', timestamp: 1_700_000_000, confidence: 0.99 }
        : { price: 3000, symbol: 'WETH', timestamp: 1_700_000_000, confidence: 0.99 },
    )
    const ref = await resolveQuorumReference({ ...params, chainId: 8453 })
    expect(ref).toEqual({ toAmount: 10n ** 18n, source: 'defillama' })
    expect(fetchChainlinkPriceRaw).toHaveBeenCalledWith(params.src, 8453)
    expect(fetchDefiLlamaPrice).toHaveBeenCalledWith(params.src, 'base')
  })

  it('maps an unknown chainId to the ethereum slug instead of throwing (same fallback as the swap route)', async () => {
    vi.mocked(fetchDefiLlamaPrice).mockResolvedValue({
      price: 1, symbol: 'X', timestamp: 1_700_000_000, confidence: 0.99,
    })
    const ref = await resolveQuorumReference({ ...params, chainId: 999_999, srcDecimals: 6, dstDecimals: 6 })
    expect(ref).toEqual({ toAmount: 3_000_000_000n, source: 'defillama' })
    expect(fetchDefiLlamaPrice).toHaveBeenCalledWith(params.src, 'ethereum')
  })

  it('returns null when neither plumbing can price BOTH legs (the flag-without-reorder regime)', async () => {
    const ref = await resolveQuorumReference(params)
    expect(ref).toBeNull()
  })

  it('never throws: rejecting fetchers are an unavailable reference, not an error', async () => {
    vi.mocked(fetchChainlinkPriceRaw).mockRejectedValue(new Error('rpc down'))
    vi.mocked(fetchDefiLlamaPrice).mockRejectedValue(new Error('llama down'))
    await expect(resolveQuorumReference(params)).resolves.toBeNull()
  })

  it('falls through to DefiLlama when Chainlink prices are unusable (zero-priced leg)', async () => {
    vi.mocked(fetchChainlinkPriceRaw).mockResolvedValue({ price: 0, updatedAt: 1_700_000_000, roundId: 1n })
    vi.mocked(fetchDefiLlamaPrice).mockImplementation(async (addr: string) =>
      addr === params.src
        ? { price: 1, symbol: 'USDC', timestamp: 1_700_000_000, confidence: 0.99 }
        : { price: 3000, symbol: 'WETH', timestamp: 1_700_000_000, confidence: 0.99 },
    )
    const ref = await resolveQuorumReference(params)
    expect(ref).toEqual({ toAmount: 10n ** 18n, source: 'defillama' })
  })
})

describe('applyLowQuorumSanityWithReference — the lazy wiring fetchMetaQuote consumes', () => {
  // 3_000 USDC (6dp) in; reference legs $1 / $3_000 ⇒ fair output 1 WETH = 10^18.
  const ctx = {
    src: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    dst: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    amount: '3000000000',
    srcDecimals: 6,
    dstDecimals: 18,
  }
  const chainlinkLegs = async (addr: string) =>
    addr === ctx.src
      ? { price: 1, updatedAt: 1_700_000_000, roundId: 1n }
      : { price: 3000, updatedAt: 1_700_000_000, roundId: 1n }

  beforeEach(() => {
    vi.mocked(fetchChainlinkPriceRaw).mockReset()
    vi.mocked(fetchDefiLlamaPrice).mockReset()
    vi.mocked(fetchChainlinkPriceRaw).mockResolvedValue(null)
    vi.mocked(fetchDefiLlamaPrice).mockResolvedValue(null)
  })

  it('touches NO plumbing when the band never trips — the healthy path stays reference-free', async () => {
    const out = await applyLowQuorumSanityWithReference(
      [q('kyberswap', '1003000000000000000'), q('velora', '1001000000000000000')], ctx)
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'velora'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
    expect(out.reference).toBeNull()
    expect(fetchChainlinkPriceRaw).not.toHaveBeenCalled()
    expect(fetchDefiLlamaPrice).not.toHaveBeenCalled()
  })

  it('resolves the reference on a band trip and demotes a reference-refuted winner end-to-end', async () => {
    vi.mocked(fetchChainlinkPriceRaw).mockImplementation(chainlinkLegs)
    const out = await applyLowQuorumSanityWithReference(
      [q('openocean', '1200000000000000000'), q('kyberswap', '1000000000000000000')], ctx)
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap'])
    expect(out.demoted.map(x => x.source)).toEqual(['openocean'])
    expect(out.lowConfidence).toBe(true)
    expect(out.reference).toEqual({ toAmount: 10n ** 18n, source: 'chainlink' })
  })

  it('keeps a reference-confirmed winner against a beyond-band low-baller end-to-end (NEW2-M-01 closed at the wiring level)', async () => {
    vi.mocked(fetchChainlinkPriceRaw).mockImplementation(chainlinkLegs)
    const out = await applyLowQuorumSanityWithReference(
      [q('kyberswap', '1000000000000000000'), q('openocean', '900000000000000000')], ctx)
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'openocean'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(false)
    expect(out.reference).toEqual({ toAmount: 10n ** 18n, source: 'chainlink' })
  })

  it('falls back to flag-without-reorder when neither plumbing prices the tripped pair', async () => {
    const out = await applyLowQuorumSanityWithReference(
      [q('kyberswap', '1000000000000000000'), q('openocean', '900000000000000000')], ctx)
    expect(out.quotes.map(x => x.source)).toEqual(['kyberswap', 'openocean'])
    expect(out.demoted).toHaveLength(0)
    expect(out.lowConfidence).toBe(true)
    expect(out.reference).toBeNull()
  })

  it('a single responder never resolves a reference (nothing to adjudicate)', async () => {
    const out = await applyLowQuorumSanityWithReference([q('uniswapv3', '123456')], ctx)
    expect(out.quotes.map(x => x.source)).toEqual(['uniswapv3'])
    expect(out.lowConfidence).toBe(true)
    expect(out.reference).toBeNull()
    expect(fetchChainlinkPriceRaw).not.toHaveBeenCalled()
    expect(fetchDefiLlamaPrice).not.toHaveBeenCalled()
  })
})
