// deviation-guard.js — pure execution-QUALITY defer gate for DCA fills.
//
// A DCA order executes through ONE pinned aggregator: the EIP-712 signed
// order.router (Velora/Augustus V6 on Base), NOT a best-of-N re-route. The keeper
// therefore cannot "shop around" per fill — it must build calldata for the
// committed router. This module answers a narrower question: is that committed
// route STILL competitive right now, or has it drifted meaningfully below the best
// cross-aggregator quote? If it has drifted, we DEFER the fill within a bounded
// window (a fraction of the DCA interval) in the hope the route recovers before
// the next chunk — we never fail it, never switch aggregators, and never touch
// DCA's market-price neutrality (the chunk still buys regardless of price).
//
// Why this module exists: executor.js auto-runs main() on import, so this decision
// logic is factored out here (side-effect-free, never-throwing, no Date.now inside
// the pure fns — nowSec is passed in) to be unit-tested directly — same pattern as
// retry-policy.js / record-execution.js / swap-route.js.
//
// Relationship to retry-policy.js: this is a SEPARATE path. A DEFER is NOT a
// failure — it must NOT touch orderRetries, MUST NOT call handleExecutionFailure,
// MUST NOT mark the order 'failed', and MUST NOT emit a failure alert. The gate is
// also fail-OPEN: a missing cross-agg reference, an unparseable quote, or a window
// shorter than one poll cycle all resolve to EXECUTE (never block on our own
// uncertainty). [chore/dca-deviation-guard]

// ─── Tunable thresholds (env-overridable, guarded to a sane range) ──────────
// Both are clamped on load: a mis-set env var can only ever tighten/loosen the
// gate within safe bounds, never disable the fail-safe (unparseable ⇒ default).
// [KEEPER-ENV-ORDER] These module-scope env reads resolve correctly because every
// entrypoint imports ./env.js FIRST — pinned by env-order.test.mjs.

/**
 * Clamp a parsed fraction into [0,1], falling back on unparseable input. When
 * `exclusiveMin` is set the lower bound is exclusive (range (0,1]) — a value that
 * clamps to 0 is treated as invalid and returns the fallback instead.
 * @param {string} raw
 * @param {number} fallback
 * @param {{ exclusiveMin?: boolean }} [opts]
 * @returns {number}
 */
function clampFraction(raw, fallback, { exclusiveMin = false } = {}) {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(1, Math.max(0, n))
  if (exclusiveMin && clamped <= 0) return fallback
  return clamped
}

// Max relative shortfall of the committed route vs the best cross-agg quote before
// we treat the fill as "deviated" (default 1%). Range [0,1], fallback 0.01.
export const DCA_DEVIATION_THRESHOLD = clampFraction(
  process.env.DCA_DEVIATION_THRESHOLD || "0.01",
  0.01,
)

// Defer window as a fraction of the DCA interval (default 0.25 = the first quarter
// of the interval). Bounds the wait so a deferred chunk can never overlap the next
// chunk or drift past expiry. Range (0,1], fallback 0.25.
export const DCA_DEVIATION_WINDOW_FRACTION = clampFraction(
  process.env.DCA_DEVIATION_WINDOW_FRACTION || "0.25",
  0.25,
  { exclusiveMin: true },
)

/**
 * Parse a wei amount (bigint | number | decimal string) to a finite Number, or
 * null if it is missing/unparseable. Note: Number("")/Number("  ") coerce to 0,
 * which would be a false "best=0" — so empty/whitespace strings are rejected.
 * @param {unknown} v
 * @returns {number|null}
 */
function toFiniteNumber(v) {
  if (typeof v === "bigint") return Number(v)
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string") {
    const s = v.trim()
    if (s === "") return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Relative shortfall of the committed router's expected out vs the best cross-agg
 * quote: (best - committed) / best.
 *   > 0  → committed is WORSE than best (candidate for a defer)
 *   <= 0 → committed matches or BEATS best (never deviated)
 * Fail-safe: if `best` is unparseable or <= 0, or `committed` is unparseable,
 * returns 0 (⇒ not deviated ⇒ execute) — we never block on our own uncertainty.
 * The ratio is precision-tolerant: Number's ~2^-52 relative error is negligible
 * against a 1% threshold, even for 18-decimal wei magnitudes. Never throws.
 * @param {bigint|number|string} bestOut      best cross-agg quote (raw wei)
 * @param {bigint|number|string} committedOut committed router's expected out (raw wei)
 * @returns {number} the deviation fraction (0 on any unparseable / non-positive best)
 */
export function computeDeviation(bestOut, committedOut) {
  const best = toFiniteNumber(bestOut)
  const committed = toFiniteNumber(committedOut)
  if (best == null || committed == null) return 0 // unparseable ⇒ fail-safe
  if (!(best > 0)) return 0 // best <= 0 guard ⇒ fail-safe
  return (best - committed) / best
}

/**
 * The SCHEDULED unix-seconds due time of THIS DCA chunk (mirrors the contract's
 * dcaLastExecution semantics): the FIRST chunk (no dca_last_exec) is due AT
 * CREATION (created_at); a subsequent chunk is due at (last_exec + dca_interval).
 * Returns null when the governing timestamp/interval is missing or unparseable
 * (the caller floors a null dueSec to EXECUTE). Never throws.
 * @param {{ created_at?: string, dca_last_exec?: string|null, dca_interval?: number|string }} dbOrder
 * @returns {number|null}
 */
export function dcaDueSec(dbOrder) {
  if (!dbOrder || typeof dbOrder !== "object") return null

  // Subsequent chunk: keyed off the last execution timestamp.
  const rawLast = dbOrder.dca_last_exec
  const lastMs = rawLast == null ? NaN : Date.parse(rawLast)
  if (Number.isFinite(lastMs)) {
    const interval = Number(dbOrder.dca_interval)
    if (!Number.isFinite(interval)) return null
    return Math.floor(lastMs / 1000) + interval
  }

  // First chunk: due at creation (dcaLastExecution[hash] starts at 0 on-chain).
  const rawCreated = dbOrder.created_at
  const createdMs = rawCreated == null ? NaN : Date.parse(rawCreated)
  if (!Number.isFinite(createdMs)) return null
  return Math.floor(createdMs / 1000)
}

/**
 * Decide whether to EXECUTE this DCA chunk now or DEFER it within its window.
 * Pure + never-throwing; the caller passes nowSec (no Date.now in here).
 *
 * Logic order (short-circuits top-down):
 *   1. No cross-agg reference        → EXECUTE (fail-open).
 *   2. Window shorter than one poll  → EXECUTE (deferring would just miss the
 *      cycle; also covers a null/non-finite dueSec or interval). This is the FLOOR.
 *   3. Route competitive (dev<=thr)  → EXECUTE.
 *   4. Deviated: within the window   → DEFER; window elapsed → EXECUTE anyway
 *      (atWindowEnd) so the chunk is never blocked indefinitely.
 *
 * @param {{
 *   deviation: number,          // from computeDeviation (0 when no reference)
 *   threshold: number,          // DCA_DEVIATION_THRESHOLD
 *   nowSec: number,             // current unix seconds (passed in)
 *   dueSec: number|null,        // from dcaDueSec
 *   intervalSec: number,        // DCA interval (Number(orderStruct.dcaInterval))
 *   windowFraction: number,     // DCA_DEVIATION_WINDOW_FRACTION
 *   pollIntervalSec: number,    // POLL_INTERVAL_MS / 1000
 *   referenceAvailable: boolean // best AND committed quotes both present
 * }} p
 * @returns {{ action: 'execute'|'defer', atWindowEnd: boolean, deviated: boolean, reason: string }}
 */
export function decideDcaExecution({
  deviation,
  threshold,
  nowSec,
  dueSec,
  intervalSec,
  windowFraction,
  pollIntervalSec,
  referenceAvailable,
}) {
  // 1. Fail-open: with no cross-agg reference there is nothing to compare against,
  //    so we execute (DCA still buys regardless of price).
  if (!referenceAvailable) {
    return {
      action: "execute",
      atWindowEnd: false,
      deviated: false,
      reason: "fail-open: no cross-agg reference",
    }
  }

  // 2. Window floor: if the defer window is shorter than one poll cycle (or the
  //    due time / interval is unusable) a defer could not be re-evaluated before
  //    the window elapses — so just execute now.
  const windowLen = windowFraction * intervalSec
  const windowEnd = dueSec + windowLen
  if (dueSec == null || !Number.isFinite(windowEnd) || windowLen < pollIntervalSec) {
    return {
      action: "execute",
      atWindowEnd: false,
      deviated: false,
      reason: "window shorter than one poll cycle",
    }
  }

  // 3. Competitive route (committed within `threshold` of best) → execute.
  const deviated = deviation > threshold
  if (!deviated) {
    return {
      action: "execute",
      atWindowEnd: false,
      deviated: false,
      reason: "route competitive",
    }
  }

  // 4. Deviated: defer while inside the window; otherwise execute anyway so the
  //    chunk is never blocked past its bounded window (advisory note at call site).
  if (nowSec < windowEnd) {
    return {
      action: "defer",
      atWindowEnd: false,
      deviated: true,
      reason: "deviated within window",
    }
  }
  return {
    action: "execute",
    atWindowEnd: true,
    deviated: true,
    reason: "window elapsed; executing anyway",
  }
}
