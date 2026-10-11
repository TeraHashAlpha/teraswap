// Tests for order-floor.js — the pure oracle-bounded per-fill floor for DCA.
//
// [SPRINT-ORDER-ONCHAIN-FLOOR / P1a] The keeper's only economic floor for DCA was
// a flat 0.5% off the aggregator's OWN quote, so a manipulated/loose/self-
// consistent bad quote could drain a chunk to dust (the on-chain minOut is 1 wei
// for DCA). This module adds an INDEPENDENT fair-value floor: reject a fill whose
// built output is below reference × (1 − maxSlippage). Pure, never-throwing —
// same pattern as deviation-guard.test.mjs: import the pure fns, assert values,
// never import executor.js (which auto-runs main() on import).

import { test, describe, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  computeReferenceExpectedOut,
  decideFloor,
  getFloorMaxSlippageBps,
  DCA_ORACLE_FLOOR_BPS,
  DCA_ORACLE_FLOOR_BPS_MIN,
  DCA_ORACLE_FLOOR_BPS_MAX,
  classifyReference,
  decideFailOpen,
  getFailOpenMaxUsd,
  DCA_FAIL_OPEN_MAX_USD,
} from "./order-floor.js"

afterEach(() => {
  delete process.env.DCA_ORACLE_FLOOR_BPS
})

describe("computeReferenceExpectedOut — fair-value expected output", () => {
  test("1 WETH (18dp) @ $3000 → USDC (6dp) @ $1 ⇒ 3000 USDC raw", () => {
    const out = computeReferenceExpectedOut({
      netAmountIn: 10n ** 18n, // 1 WETH
      srcDecimals: 18,
      dstDecimals: 6,
      priceInUsd: 3000,
      priceOutUsd: 1,
    })
    assert.equal(out, 3000_000000n) // 3000 * 1e6
  })

  test("USDC (6dp) $500 → WETH (18dp) @ $2500 ⇒ 0.2 WETH raw", () => {
    const out = computeReferenceExpectedOut({
      netAmountIn: 500_000000n, // 500 USDC
      srcDecimals: 6,
      dstDecimals: 18,
      priceInUsd: 1,
      priceOutUsd: 2500,
    })
    assert.equal(out, 2n * 10n ** 17n) // 0.2 WETH
  })

  test("same-decimals pair scales purely by price ratio", () => {
    // 100 tokenIn (18dp) @ $2 → tokenOut (18dp) @ $4 ⇒ 50 tokenOut
    const out = computeReferenceExpectedOut({
      netAmountIn: 100n * 10n ** 18n,
      srcDecimals: 18,
      dstDecimals: 18,
      priceInUsd: 2,
      priceOutUsd: 4,
    })
    assert.equal(out, 50n * 10n ** 18n)
  })

  test("accepts a decimal-string raw amount", () => {
    const out = computeReferenceExpectedOut({
      netAmountIn: "1000000000000000000",
      srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1,
    })
    assert.equal(out, 3000_000000n)
  })

  test("null on unusable inputs (zero/negative price, unparseable amount, bad decimals)", () => {
    assert.equal(computeReferenceExpectedOut({ netAmountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 0 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: 10n ** 18n, srcDecimals: 18, dstDecimals: 6, priceInUsd: -1, priceOutUsd: 1 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: "not-a-number", srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: "0", srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1 }), null)
    assert.equal(computeReferenceExpectedOut({ netAmountIn: 10n ** 18n, srcDecimals: 18.5, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1 }), null)
  })

  test("precision holds for a large (1000-token) chunk — no float-mantissa loss", () => {
    // 1000 WETH @ $3000 → USDC @ $1 ⇒ 3,000,000 USDC exactly.
    const out = computeReferenceExpectedOut({
      netAmountIn: 1000n * 10n ** 18n, srcDecimals: 18, dstDecimals: 6, priceInUsd: 3000, priceOutUsd: 1,
    })
    assert.equal(out, 3_000_000_000000n)
  })
})

describe("decideFloor — reject sub-reference fills", () => {
  const ref = 3000_000000n // 3000 USDC fair value
  const bps = 300 // 3%

  test("built output at fair value passes", () => {
    const d = decideFloor({ builtExpectedOut: ref, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, true)
    assert.equal(d.flagged, false)
    assert.equal(d.floorOut, (ref * 9700n) / 10000n)
  })

  test("built output exactly at the floor passes (inclusive)", () => {
    const floor = (ref * 9700n) / 10000n // reference × (1 − 3%)
    const d = decideFloor({ builtExpectedOut: floor, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, true)
  })

  test("built output one wei below the floor is REJECTED", () => {
    const floor = (ref * 9700n) / 10000n
    const d = decideFloor({ builtExpectedOut: floor - 1n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
    assert.equal(d.flagged, true)
  })

  test("ADVERSARIAL: a drain-to-dust built output cannot fill", () => {
    // A compromised keeper / loose calldata quotes ~1 wei out.
    const d = decideFloor({ builtExpectedOut: 1n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
  })

  test("ADVERSARIAL: a 50%-below-fair manipulated quote cannot fill", () => {
    const d = decideFloor({ builtExpectedOut: ref / 2n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
  })

  test("unparseable built output is REFUSED (fail-safe, not filled)", () => {
    const d = decideFloor({ builtExpectedOut: "garbage", referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, false)
    assert.equal(d.flagged, true)
  })

  test("no reference ⇒ fills but FLAGGED (conservative flat floor, not blind)", () => {
    const d = decideFloor({ builtExpectedOut: ref, referenceExpectedOut: null, maxSlippageBps: bps, hasReference: false })
    assert.equal(d.ok, true)
    assert.equal(d.flagged, true)
    assert.equal(d.hasReference, false)
  })

  test("hasReference=true but reference ≤ 0 falls back to the flagged no-reference path", () => {
    const d = decideFloor({ builtExpectedOut: ref, referenceExpectedOut: 0n, maxSlippageBps: bps, hasReference: true })
    assert.equal(d.ok, true)
    assert.equal(d.flagged, true)
    assert.equal(d.hasReference, false)
  })

  test("deterministic and side-effect-free over repeated calls", () => {
    const args = { builtExpectedOut: ref - 1n, referenceExpectedOut: ref, maxSlippageBps: bps, hasReference: true }
    const first = decideFloor(args)
    for (let i = 0; i < 50; i++) assert.deepEqual(decideFloor(args), first)
  })
})

describe("getFloorMaxSlippageBps — env override, clamped", () => {
  test("defaults to 300 bps", () => {
    assert.equal(DCA_ORACLE_FLOOR_BPS, 300)
    assert.equal(getFloorMaxSlippageBps(), 300)
  })

  test("honours a valid override", () => {
    process.env.DCA_ORACLE_FLOOR_BPS = "150"
    assert.equal(getFloorMaxSlippageBps(), 150)
  })

  test("clamps below MIN and above MAX (never disables the floor)", () => {
    process.env.DCA_ORACLE_FLOOR_BPS = "0"
    assert.equal(getFloorMaxSlippageBps(), DCA_ORACLE_FLOOR_BPS_MIN)
    process.env.DCA_ORACLE_FLOOR_BPS = "99999"
    assert.equal(getFloorMaxSlippageBps(), DCA_ORACLE_FLOOR_BPS_MAX)
  })

  test("falls back to default on a non-numeric override", () => {
    process.env.DCA_ORACLE_FLOOR_BPS = "banana"
    assert.equal(getFloorMaxSlippageBps(), DCA_ORACLE_FLOOR_BPS)
  })
})

// [CHORE-KEEPER-HARDENING / P1A-M-01] Tighten the fail-open path: a TRANSIENT
// reference outage on a feed-having pair DELAYS (not fail-open); a genuinely
// feedless pair flags but only for small fills (USD notional cap).
describe("classifyReference — transient beats feedless beats ok", () => {
  test("both legs ok ⇒ ok", () => {
    assert.equal(classifyReference({ inStatus: "ok", outStatus: "ok" }), "ok")
  })
  test("any transient leg ⇒ transient (a feed exists but is momentarily down)", () => {
    assert.equal(classifyReference({ inStatus: "ok", outStatus: "transient" }), "transient")
    assert.equal(classifyReference({ inStatus: "transient", outStatus: "feedless" }), "transient")
  })
  test("no transient, at least one feedless ⇒ feedless", () => {
    assert.equal(classifyReference({ inStatus: "ok", outStatus: "feedless" }), "feedless")
    assert.equal(classifyReference({ inStatus: "feedless", outStatus: "feedless" }), "feedless")
  })
})

describe("decideFailOpen — delay transient, cap feedless by USD notional", () => {
  const cap = 250
  test("TRANSIENT outage of a feed-having pair ⇒ DELAY (never fail-open)", () => {
    const d = decideFailOpen({ referenceStatus: "transient", notionalUsd: 10, maxFailOpenUsd: cap })
    assert.equal(d.ok, false)
    assert.equal(d.action, "delay")
  })
  test("feedless small fill within the USD cap ⇒ fill-flagged", () => {
    const d = decideFailOpen({ referenceStatus: "feedless", notionalUsd: 100, maxFailOpenUsd: cap })
    assert.equal(d.ok, true)
    assert.equal(d.action, "fill-flagged")
    assert.equal(d.flagged, true)
  })
  test("feedless fill ABOVE the USD cap ⇒ DELAY", () => {
    const d = decideFailOpen({ referenceStatus: "feedless", notionalUsd: 100000, maxFailOpenUsd: cap })
    assert.equal(d.ok, false)
    assert.equal(d.action, "delay")
  })
  test("feedless but notional unsizable (no priced leg) ⇒ DELAY (don't fill blind)", () => {
    const d = decideFailOpen({ referenceStatus: "feedless", notionalUsd: null, maxFailOpenUsd: cap })
    assert.equal(d.ok, false)
    assert.equal(d.action, "delay")
  })
  test("boundary: notional exactly at the cap fills (inclusive)", () => {
    const d = decideFailOpen({ referenceStatus: "feedless", notionalUsd: cap, maxFailOpenUsd: cap })
    assert.equal(d.ok, true)
  })
})

describe("getFailOpenMaxUsd — env override, clamped, default 250", () => {
  test("defaults to 250", () => {
    assert.equal(DCA_FAIL_OPEN_MAX_USD, 250)
    assert.equal(getFailOpenMaxUsd(), 250)
  })
  test("honours a valid override and clamps to [0, 100000]", () => {
    process.env.DCA_FAIL_OPEN_MAX_USD = "500"
    assert.equal(getFailOpenMaxUsd(), 500)
    process.env.DCA_FAIL_OPEN_MAX_USD = "-1"
    assert.equal(getFailOpenMaxUsd(), 0)
    process.env.DCA_FAIL_OPEN_MAX_USD = "999999999"
    assert.equal(getFailOpenMaxUsd(), 100000)
    delete process.env.DCA_FAIL_OPEN_MAX_USD
  })
  test("falls back to the default on a non-numeric override", () => {
    process.env.DCA_FAIL_OPEN_MAX_USD = "banana"
    assert.equal(getFailOpenMaxUsd(), DCA_FAIL_OPEN_MAX_USD)
    delete process.env.DCA_FAIL_OPEN_MAX_USD
  })
})

// ── [ADR-024 / feat/keeper-price-quorum] Price quorum ────────────────────────────────────────────
// Owner decisions 2026-10-11: (A) >= 2 sources agreeing within tolerance ⇒ quorum, floor from the
// more conservative price; (B) exactly 1 ⇒ single (tighter floor, $-capped, flagged); (C) 0, or 2
// that disagree with no third to break the tie ⇒ SKIP the cycle. Never cancel, never fill blind.
import {
  resolveFloorPrice,
  combineLegModes,
  singleSourceFloorBps,
  decideSingleSourceCap,
  recordQuorumSkip,
  clearQuorumSkips,
  spreadBps,
  getQuorumToleranceBps,
  getMaxPriceAgeSec,
  getSkipAlertCycles,
  QUORUM_TOLERANCE_BPS,
  MAX_PRICE_AGE_SEC,
  SKIP_ALERT_CYCLES,
  PRICE_SOURCE_TRUST_ORDER,
} from "./order-floor.js"

const CL = (price) => ({ price, ts: 1, source: "chainlink" })
const DL = (price) => ({ price, ts: 1, source: "defillama" })
const CG = (price) => ({ price, ts: 1, source: "coingecko" })
const TOL = { toleranceBps: 300 }

describe("resolveFloorPrice — mode (A) quorum", () => {
  test("two sources within tolerance ⇒ quorum; 'in' takes the HIGHER, 'out' the LOWER price (conservative = protective)", () => {
    const quotes = [CL(3000), DL(3030)] // 100 bps apart
    const inRes = resolveFloorPrice("in", quotes, TOL)
    const outRes = resolveFloorPrice("out", quotes, TOL)
    assert.equal(inRes.mode, "quorum")
    assert.equal(inRes.price, 3030)
    assert.equal(outRes.mode, "quorum")
    assert.equal(outRes.price, 3000)
    assert.deepEqual(inRes.sources, ["chainlink", "defillama"])
    assert.deepEqual(inRes.dropped, [])
    assert.equal(inRes.spreadBps, 100)
    assert.match(inRes.reason, /quorum chainlink\+defillama/)
  })

  test("three sources all agreeing ⇒ quorum over all three", () => {
    const r = resolveFloorPrice("out", [CL(3000), DL(3010), CG(2995)], TOL)
    assert.equal(r.mode, "quorum")
    assert.equal(r.price, 2995)
    assert.deepEqual(r.sources, ["chainlink", "defillama", "coingecko"])
  })

  test("THIRD SOURCE BREAKS THE TIE: two agree, the outlier is dropped, mode is quorum", () => {
    const r = resolveFloorPrice("in", [CL(3000), DL(3600), CG(3005)], TOL) // DL is 20% off
    assert.equal(r.mode, "quorum")
    assert.deepEqual(r.sources, ["chainlink", "coingecko"])
    assert.deepEqual(r.dropped, ["defillama"])
    assert.equal(r.price, 3005)
    assert.match(r.reason, /dropped outlier defillama/)
  })

  test("tolerance boundary is INCLUSIVE: exactly 300 bps agrees, 301 does not", () => {
    assert.equal(resolveFloorPrice("in", [CL(10000), DL(10300)], TOL).mode, "quorum")
    assert.equal(resolveFloorPrice("in", [CL(10000), DL(10301)], TOL).mode, "skip")
  })

  test("chain case A~B, B~C, A≁C: the equal-sized clusters are split by trust order (chainlink wins)", () => {
    // CL 10000, DL 10250 (250 bps from CL), CG 10500 (244 bps from DL, 500 from CL)
    const r = resolveFloorPrice("out", [CL(10000), DL(10250), CG(10500)], TOL)
    assert.equal(r.mode, "quorum")
    assert.deepEqual(r.sources, ["chainlink", "defillama"])
    assert.deepEqual(r.dropped, ["coingecko"])
  })

  test("quorum needs INDEPENDENT sources: a duplicated source name counts once", () => {
    assert.equal(resolveFloorPrice("in", [DL(3000), DL(3001)], TOL).mode, "single")
  })

  test("tolerance comes from QUORUM_TOLERANCE_BPS by name (default 300) when not passed", () => {
    assert.equal(QUORUM_TOLERANCE_BPS, 300)
    assert.equal(getQuorumToleranceBps({}), 300)
    assert.equal(resolveFloorPrice("in", [CL(10000), DL(10300)]).mode, "quorum")
    process.env.QUORUM_TOLERANCE_BPS = "100"
    try {
      assert.equal(getQuorumToleranceBps(), 100)
      assert.equal(resolveFloorPrice("in", [CL(10000), DL(10300)]).mode, "skip")
    } finally {
      delete process.env.QUORUM_TOLERANCE_BPS
    }
  })
})

describe("resolveFloorPrice — mode (B) single", () => {
  test("exactly one source ⇒ single, its price, flagged reason", () => {
    const r = resolveFloorPrice("in", [DL(3000)], TOL)
    assert.equal(r.mode, "single")
    assert.equal(r.price, 3000)
    assert.deepEqual(r.sources, ["defillama"])
    assert.match(r.reason, /single source \(defillama\)/)
  })
  test("junk quotes do not count towards the quorum (non-positive / NaN price, missing source)", () => {
    const r = resolveFloorPrice("in", [CL(3000), DL(0), CG(NaN), { price: 3000 }, null, { price: 3000, source: "" }], TOL)
    assert.equal(r.mode, "single")
    assert.deepEqual(r.sources, ["chainlink"])
  })
})

describe("resolveFloorPrice — mode (C) skip", () => {
  test("ZERO sources ⇒ skip with no price", () => {
    for (const q of [[], null, undefined, [null, { price: -1, source: "x" }]]) {
      const r = resolveFloorPrice("in", q, TOL)
      assert.equal(r.mode, "skip")
      assert.equal(r.price, null)
      assert.match(r.reason, /no price source answered/)
    }
  })
  test("TWO sources disagreeing beyond tolerance with NO third ⇒ skip (never fill on a coin-flip)", () => {
    const r = resolveFloorPrice("in", [CL(3000), DL(3200)], TOL) // 667 bps
    assert.equal(r.mode, "skip")
    assert.equal(r.price, null)
    assert.match(r.reason, /2 sources .* disagree beyond 300 bps .* no third to break the tie/)
    assert.equal(r.spreadBps, 667)
  })
  test("THREE sources, no two agreeing ⇒ skip", () => {
    const r = resolveFloorPrice("out", [CL(3000), DL(3200), CG(2800)], TOL)
    assert.equal(r.mode, "skip")
    assert.match(r.reason, /no two of 3 sources/)
  })
  test("unknown leg ⇒ skip (fail-safe), even with a perfect quorum", () => {
    assert.equal(resolveFloorPrice("sideways", [CL(3000), DL(3000)], TOL).mode, "skip")
  })
  test("deterministic and side-effect-free", () => {
    const q = [CL(3000), DL(3600), CG(3005)]
    const first = resolveFloorPrice("in", q, TOL)
    for (let i = 0; i < 25; i++) assert.deepEqual(resolveFloorPrice("in", q, TOL), first)
    assert.deepEqual(q, [CL(3000), DL(3600), CG(3005)], "input must not be mutated")
  })
})

describe("spreadBps + combineLegModes + singleSourceFloorBps", () => {
  test("spreadBps is relative to the LOWER price and symmetric", () => {
    assert.equal(Math.round(spreadBps(100, 103)), 300)
    assert.equal(Math.round(spreadBps(103, 100)), 300)
    assert.equal(spreadBps(0, 100), Number.POSITIVE_INFINITY)
  })
  test("combineLegModes: any skip ⇒ skip; else any single ⇒ single; else quorum; unknown ⇒ skip", () => {
    assert.equal(combineLegModes("quorum", "quorum"), "quorum")
    assert.equal(combineLegModes("quorum", "single"), "single")
    assert.equal(combineLegModes("single", "quorum"), "single")
    assert.equal(combineLegModes("single", "single"), "single")
    assert.equal(combineLegModes("skip", "quorum"), "skip")
    assert.equal(combineLegModes("single", "skip"), "skip")
    assert.equal(combineLegModes("quorum", "bogus"), "skip")
  })
  test("single-source floor is TIGHTER: half the band, never below the MIN clamp", () => {
    assert.equal(singleSourceFloorBps(300), 150)
    assert.equal(singleSourceFloorBps(2000), 1000)
    assert.equal(singleSourceFloorBps(60), DCA_ORACLE_FLOOR_BPS_MIN) // 30 would be below MIN (50)
    assert.equal(singleSourceFloorBps("junk"), DCA_ORACLE_FLOOR_BPS_MIN)
    assert.ok(singleSourceFloorBps(300) < 300, "must be strictly tighter than the normal band")
  })
})

describe("decideSingleSourceCap — the SAME cap as the old feedless path, value unchanged", () => {
  test("cap source is DCA_FAIL_OPEN_MAX_USD = 250 (getFailOpenMaxUsd default) — unchanged by the quorum", () => {
    assert.equal(DCA_FAIL_OPEN_MAX_USD, 250)
    assert.equal(getFailOpenMaxUsd(), 250)
  })
  test("within the cap ⇒ fill-flagged; above ⇒ delay; boundary inclusive; unsizable ⇒ delay", () => {
    const maxUsd = getFailOpenMaxUsd()
    assert.deepEqual(decideSingleSourceCap({ notionalUsd: 100, maxUsd }).action, "fill-flagged")
    assert.equal(decideSingleSourceCap({ notionalUsd: 100, maxUsd }).flagged, true)
    assert.equal(decideSingleSourceCap({ notionalUsd: maxUsd, maxUsd }).ok, true)
    assert.equal(decideSingleSourceCap({ notionalUsd: maxUsd + 0.01, maxUsd }).action, "delay")
    assert.equal(decideSingleSourceCap({ notionalUsd: 100000, maxUsd }).ok, false)
    assert.equal(decideSingleSourceCap({ notionalUsd: null, maxUsd }).action, "delay")
    assert.equal(decideSingleSourceCap({ notionalUsd: NaN, maxUsd }).action, "delay")
  })
  test("single-mode decisions agree with the legacy decideFailOpen feedless path for the same cap (parity)", () => {
    for (const n of [0.5, 100, 250, 251, 9999, null]) {
      const legacy = decideFailOpen({ referenceStatus: "feedless", notionalUsd: n, maxFailOpenUsd: 250 })
      const now = decideSingleSourceCap({ notionalUsd: n, maxUsd: 250 })
      assert.equal(now.ok, legacy.ok, `notional ${n}`)
      assert.equal(now.action, legacy.action, `notional ${n}`)
    }
  })
})

describe("recordQuorumSkip / clearQuorumSkips — alert at N, re-alert every N, reset", () => {
  test("counts consecutively per order; alert fires exactly at N (default 3) and at 2N, not between", () => {
    assert.equal(SKIP_ALERT_CYCLES, 3)
    const skips = new Map()
    assert.deepEqual(recordQuorumSkip(skips, "a"), { count: 1, alert: false })
    assert.deepEqual(recordQuorumSkip(skips, "a"), { count: 2, alert: false })
    assert.deepEqual(recordQuorumSkip(skips, "a"), { count: 3, alert: true })
    assert.deepEqual(recordQuorumSkip(skips, "a"), { count: 4, alert: false })
    assert.deepEqual(recordQuorumSkip(skips, "a"), { count: 5, alert: false })
    assert.deepEqual(recordQuorumSkip(skips, "a"), { count: 6, alert: true })
    assert.deepEqual(recordQuorumSkip(skips, "b"), { count: 1, alert: false }, "orders are independent")
  })
  test("reset: after clear the next skip starts at 1 (consecutive, not cumulative)", () => {
    const skips = new Map()
    recordQuorumSkip(skips, "a")
    recordQuorumSkip(skips, "a")
    assert.equal(clearQuorumSkips(skips, "a"), true)
    assert.equal(skips.has("a"), false)
    assert.deepEqual(recordQuorumSkip(skips, "a"), { count: 1, alert: false })
    assert.equal(clearQuorumSkips(skips, "never-seen"), false)
  })
  test("SKIP_ALERT_CYCLES env override by name (clamped [1, 1000])", () => {
    process.env.SKIP_ALERT_CYCLES = "1"
    try {
      assert.equal(getSkipAlertCycles(), 1)
      assert.deepEqual(recordQuorumSkip(new Map(), "a"), { count: 1, alert: true })
      process.env.SKIP_ALERT_CYCLES = "0"
      assert.equal(getSkipAlertCycles(), 1)
      process.env.SKIP_ALERT_CYCLES = "99999"
      assert.equal(getSkipAlertCycles(), 1000)
      process.env.SKIP_ALERT_CYCLES = "banana"
      assert.equal(getSkipAlertCycles(), SKIP_ALERT_CYCLES)
    } finally {
      delete process.env.SKIP_ALERT_CYCLES
    }
  })
})

describe("quorum constants — one production module, env-overridable BY NAME, clamped", () => {
  test("defaults: QUORUM_TOLERANCE_BPS=300, MAX_PRICE_AGE_SEC=600, SKIP_ALERT_CYCLES=3; trust order chainlink > defillama > coingecko", () => {
    assert.equal(getQuorumToleranceBps({}), 300)
    assert.equal(getMaxPriceAgeSec({}), 600)
    assert.equal(MAX_PRICE_AGE_SEC, 600)
    assert.equal(getSkipAlertCycles({}), 3)
    assert.deepEqual([...PRICE_SOURCE_TRUST_ORDER], ["chainlink", "defillama", "coingecko"])
    assert.ok(Object.isFrozen(PRICE_SOURCE_TRUST_ORDER))
  })
  test("clamps: tolerance [10, 2000], age [30, 86400]; junk ⇒ default", () => {
    assert.equal(getQuorumToleranceBps({ QUORUM_TOLERANCE_BPS: "1" }), 10)
    assert.equal(getQuorumToleranceBps({ QUORUM_TOLERANCE_BPS: "5000" }), 2000)
    assert.equal(getQuorumToleranceBps({ QUORUM_TOLERANCE_BPS: "x" }), 300)
    assert.equal(getMaxPriceAgeSec({ MAX_PRICE_AGE_SEC: "1" }), 30)
    assert.equal(getMaxPriceAgeSec({ MAX_PRICE_AGE_SEC: "999999" }), 86400)
    assert.equal(getMaxPriceAgeSec({ MAX_PRICE_AGE_SEC: "120" }), 120)
    assert.equal(getMaxPriceAgeSec({ MAX_PRICE_AGE_SEC: "nope" }), 600)
  })
})
