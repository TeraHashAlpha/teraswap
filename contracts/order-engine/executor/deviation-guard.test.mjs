// Tests for deviation-guard.js — the pure execution-QUALITY defer gate for DCA
// fills. A DCA order executes through ONE pinned aggregator (the EIP-712 signed
// order.router — Velora/Augustus V6 on Base), NOT best-of-N. This gate checks the
// committed route is still competitive vs the best cross-aggregator quote; if it
// has drifted beyond a threshold it DEFERS the fill within a bounded window —
// it does NOT fail, does NOT switch aggregators, and does NOT alter DCA's
// market-price neutrality (the chunk still buys regardless of price).
//
// Pattern mirrors record-execution.test.mjs / retry-policy.test.mjs: import the
// pure functions, assert on returned values. No network, no Supabase, no provider
// — so executor.js (which auto-runs main() on import) is never imported.
//
// The DEFER path here is SEPARATE from retry-policy.js: a defer must NOT touch
// orderRetries, MUST NOT be classified as a failure, and is fail-OPEN (a missing
// cross-agg reference or a too-short window always executes). [chore/dca-deviation-guard]

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import {
  DCA_DEVIATION_THRESHOLD,
  DCA_DEVIATION_WINDOW_FRACTION,
  computeDeviation,
  dcaDueSec,
  decideDcaExecution,
} from "./deviation-guard.js"

// A fixed ISO/epoch pair (same instant retry-policy.test.mjs uses).
const CREATED = "2026-06-30T12:00:00.000Z"
const CREATED_SEC = 1782820800

// A representative 1-hour DCA whose defer-window (0.25 × 3600 = 900s) is far
// longer than one 30s poll cycle, so the "too-short window" floor never trips.
const INTERVAL = 3600
const WINDOW_FRACTION = 0.25
const POLL = 30
const WINDOW_LEN = WINDOW_FRACTION * INTERVAL // 900s
const DUE = 1_000_000
const WINDOW_END = DUE + WINDOW_LEN // 1_000_900
const THRESHOLD = 0.01

// Build the decideDcaExecution input with sane defaults; override per case.
function decisionInput(over = {}) {
  return {
    deviation: 0,
    threshold: THRESHOLD,
    nowSec: DUE + 1, // just inside the window by default
    dueSec: DUE,
    intervalSec: INTERVAL,
    windowFraction: WINDOW_FRACTION,
    pollIntervalSec: POLL,
    referenceAvailable: true,
    ...over,
  }
}

describe("env constants — thresholds guarded to a sane range with safe fallbacks", () => {
  test("DCA_DEVIATION_THRESHOLD is a number in [0,1] (default 0.01 when unset)", () => {
    assert.equal(typeof DCA_DEVIATION_THRESHOLD, "number")
    assert.ok(DCA_DEVIATION_THRESHOLD >= 0 && DCA_DEVIATION_THRESHOLD <= 1)
    if (process.env.DCA_DEVIATION_THRESHOLD == null) {
      assert.equal(DCA_DEVIATION_THRESHOLD, 0.01)
    }
  })

  test("DCA_DEVIATION_WINDOW_FRACTION is a number in (0,1] (default 0.25 when unset)", () => {
    assert.equal(typeof DCA_DEVIATION_WINDOW_FRACTION, "number")
    assert.ok(DCA_DEVIATION_WINDOW_FRACTION > 0 && DCA_DEVIATION_WINDOW_FRACTION <= 1)
    if (process.env.DCA_DEVIATION_WINDOW_FRACTION == null) {
      assert.equal(DCA_DEVIATION_WINDOW_FRACTION, 0.25)
    }
  })
})

describe("computeDeviation — (best - committed)/best, fail-safe to 0", () => {
  test("committed worse than best → positive deviation (the math)", () => {
    // (1000 - 990)/1000 = 0.01
    assert.equal(computeDeviation(1000, 990), 0.01)
    // (1000 - 900)/1000 = 0.10, via decimal wei strings
    assert.equal(computeDeviation("1000", "900"), 0.1)
  })

  test("accepts bigint wei and large 18-dec magnitudes without precision loss at 1%", () => {
    assert.equal(computeDeviation(1000n, 990n), 0.01)
    // 2e18 vs 1.98e18 → exactly 1%
    assert.equal(computeDeviation(2000000000000000000n, 1980000000000000000n), 0.01)
  })

  test("committed BETTER than best → negative deviation (never a defer trigger)", () => {
    // (1000 - 1010)/1000 = -0.01
    assert.equal(computeDeviation(1000n, 1010n), -0.01)
    assert.ok(computeDeviation("1000", "1010") < 0)
  })

  test("best <= 0 guard → 0 (cannot compute a meaningful ratio; fail-safe execute)", () => {
    assert.equal(computeDeviation(0, 100), 0)
    assert.equal(computeDeviation("0", "100"), 0)
    assert.equal(computeDeviation(-5, 3), 0)
  })

  test("unparseable / missing inputs → 0 (fail-safe execute)", () => {
    assert.equal(computeDeviation("abc", "100"), 0)
    assert.equal(computeDeviation("1000", "xyz"), 0)
    assert.equal(computeDeviation(null, 100), 0)
    assert.equal(computeDeviation(undefined, undefined), 0)
    assert.equal(computeDeviation("", "100"), 0) // empty string is NOT 0
    assert.equal(computeDeviation("   ", "100"), 0) // whitespace is NOT 0
  })

  test("never throws on odd input", () => {
    assert.doesNotThrow(() => computeDeviation({}, []))
    assert.doesNotThrow(() => computeDeviation(NaN, Infinity))
  })
})

describe("dcaDueSec — scheduled due time of THIS chunk (first vs subsequent)", () => {
  test("first chunk (dca_last_exec null) is due AT CREATION (created_at seconds)", () => {
    const due = dcaDueSec({ created_at: CREATED, dca_last_exec: null, dca_interval: INTERVAL })
    assert.equal(due, CREATED_SEC)
  })

  test("first chunk when dca_last_exec is undefined behaves the same", () => {
    const due = dcaDueSec({ created_at: CREATED, dca_interval: INTERVAL })
    assert.equal(due, CREATED_SEC)
  })

  test("subsequent chunk is due at last_exec seconds + dca_interval", () => {
    const due = dcaDueSec({
      created_at: CREATED,
      dca_last_exec: CREATED,
      dca_interval: INTERVAL,
    })
    assert.equal(due, CREATED_SEC + INTERVAL)
  })

  test("null when created_at is unparseable and there is no last_exec", () => {
    assert.equal(dcaDueSec({ created_at: "not-a-date", dca_last_exec: null }), null)
  })

  test("null on a missing / non-object order", () => {
    assert.equal(dcaDueSec(null), null)
    assert.equal(dcaDueSec(undefined), null)
    assert.equal(dcaDueSec("nope"), null)
  })

  test("null when the subsequent-chunk interval is unparseable", () => {
    assert.equal(
      dcaDueSec({ created_at: CREATED, dca_last_exec: CREATED, dca_interval: "abc" }),
      null,
    )
  })

  test("never throws", () => {
    assert.doesNotThrow(() => dcaDueSec({}))
  })
})

describe("decideDcaExecution — competitive→execute, deviated→defer within a bounded window", () => {
  test("(a) deviated beyond threshold AND still inside the window → DEFER", () => {
    const d = decideDcaExecution(decisionInput({ deviation: 0.05, nowSec: DUE + 100 }))
    assert.deepEqual(d, {
      action: "defer",
      atWindowEnd: false,
      deviated: true,
      reason: "deviated within window",
    })
    assert.ok(DUE + 100 < WINDOW_END)
  })

  test("(b) route competitive (deviation <= threshold) → EXECUTE, not deviated", () => {
    const d = decideDcaExecution(decisionInput({ deviation: 0.005, nowSec: DUE + 100 }))
    assert.equal(d.action, "execute")
    assert.equal(d.deviated, false)
    assert.equal(d.atWindowEnd, false)
    assert.equal(d.reason, "route competitive")
  })

  test("(b') deviation EXACTLY at threshold is competitive (strict > to defer)", () => {
    const d = decideDcaExecution(decisionInput({ deviation: THRESHOLD, nowSec: DUE + 100 }))
    assert.equal(d.action, "execute")
    assert.equal(d.deviated, false)
  })

  test("(c) window elapsed and STILL deviated → EXECUTE anyway with atWindowEnd:true", () => {
    const d = decideDcaExecution(decisionInput({ deviation: 0.05, nowSec: WINDOW_END + 1 }))
    assert.deepEqual(d, {
      action: "execute",
      atWindowEnd: true,
      deviated: true,
      reason: "window elapsed; executing anyway",
    })
  })

  test("(c') at the exact window end (nowSec == windowEnd) the window has elapsed → execute", () => {
    const d = decideDcaExecution(decisionInput({ deviation: 0.05, nowSec: WINDOW_END }))
    assert.equal(d.action, "execute")
    assert.equal(d.atWindowEnd, true)
  })

  test("(d) window shorter than one poll cycle → EXECUTE immediately (floor), even if deviated", () => {
    // interval 60s × 0.25 = 15s window < 30s poll ⇒ deferring would just miss the poll.
    const d = decideDcaExecution(
      decisionInput({ deviation: 0.5, intervalSec: 60, nowSec: DUE + 1 }),
    )
    assert.equal(d.action, "execute")
    assert.equal(d.atWindowEnd, false)
    assert.equal(d.reason, "window shorter than one poll cycle")
  })

  test("(d') dueSec null → floor to EXECUTE (cannot bound a window without a due time)", () => {
    const d = decideDcaExecution(decisionInput({ deviation: 0.5, dueSec: null }))
    assert.equal(d.action, "execute")
    assert.equal(d.reason, "window shorter than one poll cycle")
  })

  test("(d'') non-finite interval → floor to EXECUTE", () => {
    const d = decideDcaExecution(decisionInput({ deviation: 0.5, intervalSec: NaN }))
    assert.equal(d.action, "execute")
    assert.equal(d.reason, "window shorter than one poll cycle")
  })

  test("(e) no cross-agg reference → EXECUTE (fail-open), regardless of deviation/time", () => {
    const d = decideDcaExecution(
      decisionInput({ referenceAvailable: false, deviation: 0.99, nowSec: DUE + 1 }),
    )
    assert.deepEqual(d, {
      action: "execute",
      atWindowEnd: false,
      deviated: false,
      reason: "fail-open: no cross-agg reference",
    })
  })

  test("(f) committed better than best (negative deviation) → EXECUTE, not deviated", () => {
    const d = decideDcaExecution(decisionInput({ deviation: -0.03, nowSec: DUE + 1 }))
    assert.equal(d.action, "execute")
    assert.equal(d.deviated, false)
    assert.equal(d.reason, "route competitive")
  })

  test("fail-open precedence: no reference wins even when the window would be too short", () => {
    const d = decideDcaExecution(
      decisionInput({ referenceAvailable: false, deviation: 0.5, intervalSec: 60 }),
    )
    assert.equal(d.reason, "fail-open: no cross-agg reference")
  })

  test("never throws on degenerate numeric input", () => {
    assert.doesNotThrow(() =>
      decideDcaExecution({
        deviation: NaN,
        threshold: NaN,
        nowSec: NaN,
        dueSec: NaN,
        intervalSec: NaN,
        windowFraction: NaN,
        pollIntervalSec: NaN,
        referenceAvailable: true,
      }),
    )
  })
})
