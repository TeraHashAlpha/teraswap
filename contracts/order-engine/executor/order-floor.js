// order-floor.js — oracle-bounded per-fill floor for DCA (pure, unit-tested).
//
// [SPRINT-ORDER-ONCHAIN-FLOOR / P1a] Threat model PR #277 found that DCA signs
// minAmountOut=1 → TeraSwapOrderExecutor clamps the per-chunk minOut to 1 wei
// (:508-509) and DCA sets routerDataHash=0/priceFeed=0, so the ON-CHAIN
// minimumOutput is a NO-OP for DCA. The only economic floor was the flat 0.5%
// KEEPER_SLIPPAGE baked into the aggregator calldata — which is SELF-REFERENTIAL
// (0.5% off the aggregator's OWN quote): a manipulated/mis-scaled/loose quote
// stays under-protected, letting a keeper-compromise or route-builder bug drain
// a chunk's output to dust.
//
// This module adds an INDEPENDENT floor: before a DCA fill, compare the built
// swap's expected output to a fair-value reference (Chainlink first, else
// DefiLlama — fetched by the caller) and REJECT the fill when the built output
// is below reference × (1 − maxSlippage). It never re-routes and never changes
// which router the fill uses; it only decides fill-vs-reject. A rejected fill is
// DELAYED (retried next cycle), never forced — delay ≫ drain.
//
// Interim (off-chain, Phase 0). The terminal on-chain floor (a Chainlink read at
// execution within a SIGNED bound, replacing the 1-wei clamp with a revert) is
// designed in ADR-011 and is a separate gated deploy — this keeper gate cuts the
// live exposure now without a redeploy.
//
// Pure + never-throwing (mirrors deviation-guard.js / retry-policy.js): no I/O,
// no Date.now, no provider — the caller passes the fetched prices in.

/** Default anti-manipulation floor band, in basis points (300 = 3%). Wide enough
 *  to clear legitimate DCA execution cost (pool fee + small price impact +
 *  oracle-vs-mid spread, typically <1%) while still catching gross manipulation
 *  (a drain-to-dust output is ~100% below fair value). Auditor-tunable. */
export const DCA_ORACLE_FLOOR_BPS = 300

/** Hard clamp for the env override so a mis-set value can only ever land in a
 *  sane band — never disable the floor (0) nor make it absurdly loose. */
export const DCA_ORACLE_FLOOR_BPS_MIN = 50    // 0.5%
export const DCA_ORACLE_FLOOR_BPS_MAX = 2000  // 20%

/**
 * The active floor band: `DCA_ORACLE_FLOOR_BPS` env override when it parses to an
 * integer inside [MIN, MAX], else the 300 bps default.
 * @returns {number}
 */
export function getFloorMaxSlippageBps() {
  const raw = process.env.DCA_ORACLE_FLOOR_BPS
  if (!raw) return DCA_ORACLE_FLOOR_BPS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DCA_ORACLE_FLOOR_BPS
  if (parsed < DCA_ORACLE_FLOOR_BPS_MIN) return DCA_ORACLE_FLOOR_BPS_MIN
  if (parsed > DCA_ORACLE_FLOOR_BPS_MAX) return DCA_ORACLE_FLOOR_BPS_MAX
  return parsed
}

/**
 * Parse a positive raw token amount (bigint | number | decimal string) to BigInt,
 * or null if missing/unparseable/non-positive. Whitespace/empty → null (Number("")
 * would coerce to 0 and read as a false "0 output").
 * @param {unknown} v
 * @returns {bigint|null}
 */
function toPositiveBigInt(v) {
  try {
    if (typeof v === "bigint") return v > 0n ? v : null
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v <= 0) return null
      return BigInt(Math.trunc(v))
    }
    if (typeof v === "string") {
      const s = v.trim()
      if (s === "" || !/^\d+$/.test(s)) return null
      const b = BigInt(s)
      return b > 0n ? b : null
    }
    return null
  } catch {
    return null
  }
}

/** A finite positive Number, else null. */
function toPositiveNumber(v) {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Fair-value expected output (raw tokenOut units) for a swap of `netAmountIn`
 * (raw tokenIn units, already NET of the on-chain fee) given both legs' USD
 * prices. Precision-safe: USD prices are scaled to 8-dp integers (the 1e8 factors
 * cancel), everything else is BigInt, so there is no float-mantissa loss on
 * 18-decimal magnitudes.
 *
 *   expectedOut_raw = amountIn_raw × pIn × 10^dstDec / (pOut × 10^srcDec)
 *
 * @param {object} p
 * @param {bigint|number|string} p.netAmountIn  raw tokenIn amount (post-fee chunk)
 * @param {number} p.srcDecimals
 * @param {number} p.dstDecimals
 * @param {number} p.priceInUsd   fair-value USD price of tokenIn
 * @param {number} p.priceOutUsd  fair-value USD price of tokenOut
 * @returns {bigint|null} expected raw output, or null if any input is unusable
 */
export function computeReferenceExpectedOut({ netAmountIn, srcDecimals, dstDecimals, priceInUsd, priceOutUsd }) {
  const amountIn = toPositiveBigInt(netAmountIn)
  const pInNum = toPositiveNumber(priceInUsd)
  const pOutNum = toPositiveNumber(priceOutUsd)
  if (amountIn === null || pInNum === null || pOutNum === null) return null
  if (!Number.isInteger(srcDecimals) || !Number.isInteger(dstDecimals) || srcDecimals < 0 || dstDecimals < 0) return null

  // Scale prices to 8-dp fixed point. Round to nearest; guard the rare case where
  // a sub-1e-8 price rounds to 0 (⇒ unusable reference).
  const pIn = BigInt(Math.round(pInNum * 1e8))
  const pOut = BigInt(Math.round(pOutNum * 1e8))
  if (pIn <= 0n || pOut <= 0n) return null

  const num = amountIn * pIn * 10n ** BigInt(dstDecimals)
  const den = pOut * 10n ** BigInt(srcDecimals)
  if (den === 0n) return null
  return num / den
}

/**
 * Decide whether a built DCA swap clears the oracle-bounded floor.
 *
 * @param {object} p
 * @param {bigint|number|string} p.builtExpectedOut  the aggregator's quoted output (raw tokenOut)
 * @param {bigint|null} p.referenceExpectedOut       from computeReferenceExpectedOut (null ⇒ no reference)
 * @param {number} p.maxSlippageBps                  floor band (getFloorMaxSlippageBps())
 * @param {boolean} p.hasReference                   a usable fair-value reference exists for BOTH legs
 * @returns {{ ok: boolean, floorOut: bigint|null, flagged: boolean, hasReference: boolean, reason: string }}
 *   ok=false ⇒ REJECT the fill this cycle (retry later; never fill below the floor).
 *   flagged=true ⇒ surface to ops (no-reference fill, or a breach).
 */
export function decideFloor({ builtExpectedOut, referenceExpectedOut, maxSlippageBps, hasReference }) {
  const built = toPositiveBigInt(builtExpectedOut)

  // No independent reference (oracle-less + DefiLlama-less pair): we CANNOT verify
  // the quote against fair value, so we do not claim to. Do not fill BLIND — the
  // aggregator calldata still carries its own (flat) minReturn — but FLAG the fill
  // so ops can see it wasn't oracle-bounded. The terminal fix is the on-chain
  // signed floor (ADR-011); no keeper-side check can catch a self-consistent bad
  // quote without an external anchor.
  if (!hasReference || referenceExpectedOut === null || referenceExpectedOut <= 0n) {
    return {
      ok: true,
      floorOut: null,
      flagged: true,
      hasReference: false,
      reason: "no fair-value reference (Chainlink/DefiLlama) — conservative flat floor + flag",
    }
  }

  // An unparseable built output cannot be verified against the floor ⇒ refuse
  // (fail-safe: never fill on an amount we can't read).
  if (built === null) {
    return {
      ok: false,
      floorOut: null,
      flagged: true,
      hasReference: true,
      reason: "unparseable built output — refusing to fill",
    }
  }

  const bps = BigInt(maxSlippageBps)
  const floorOut = (referenceExpectedOut * (10_000n - bps)) / 10_000n
  const ok = built >= floorOut
  return {
    ok,
    floorOut,
    flagged: !ok,
    hasReference: true,
    reason: ok
      ? "oracle-bounded: built output >= reference floor"
      : "oracle floor breached: built output < reference × (1 − maxSlippage) — refusing to fill",
  }
}

// ── [CHORE-KEEPER-HARDENING / P1A-M-01] Bounded fail-open ────────────────────
// decideFloor's "no reference ⇒ fill flagged" is fail-OPEN. That is right for a
// pair with genuinely NO feed, but wrong for a TRANSIENT outage of a pair that
// DOES have a feed (a momentary Chainlink RPC / DefiLlama blip should DELAY the
// fill, not wave it through unbounded). And even a feedless fail-open fill should
// be bounded to SMALL notionals. This splits the two cases and adds a USD cap.

/** Default USD notional cap for a fail-open (feedless) fill — only small fills
 *  proceed unbounded; larger ones delay. Auditor-tunable; clamped [0, 100000]
 *  (0 = never fail-open). */
export const DCA_FAIL_OPEN_MAX_USD = 250
export const DCA_FAIL_OPEN_MAX_USD_MIN = 0
export const DCA_FAIL_OPEN_MAX_USD_MAX = 100_000

/** The active fail-open cap: `DCA_FAIL_OPEN_MAX_USD` env override clamped to
 *  [MIN, MAX], else the 250 default. */
export function getFailOpenMaxUsd() {
  const raw = process.env.DCA_FAIL_OPEN_MAX_USD
  if (!raw) return DCA_FAIL_OPEN_MAX_USD
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DCA_FAIL_OPEN_MAX_USD
  if (parsed < DCA_FAIL_OPEN_MAX_USD_MIN) return DCA_FAIL_OPEN_MAX_USD_MIN
  if (parsed > DCA_FAIL_OPEN_MAX_USD_MAX) return DCA_FAIL_OPEN_MAX_USD_MAX
  return parsed
}

/**
 * Combine the two legs' reference statuses into one. A TRANSIENT leg means a feed
 * EXISTS but is momentarily unavailable ⇒ the whole pair is transient (delay). A
 * FEEDLESS leg (with neither transient) ⇒ feedless (fail-open, capped).
 * @param {{ inStatus: 'ok'|'transient'|'feedless', outStatus: 'ok'|'transient'|'feedless' }} p
 * @returns {'ok'|'transient'|'feedless'}
 */
export function classifyReference({ inStatus, outStatus }) {
  if (inStatus === "transient" || outStatus === "transient") return "transient"
  if (inStatus === "ok" && outStatus === "ok") return "ok"
  return "feedless"
}

/**
 * Decide what to do when the oracle floor could NOT be applied (not both legs
 * priced). Transient ⇒ DELAY (retry next cycle, never fill unbounded). Feedless ⇒
 * proceed only for a small fill within the USD cap; otherwise DELAY. An unsizable
 * feedless fill (no priced leg) ⇒ DELAY (never fill blind).
 * @param {{ referenceStatus: 'transient'|'feedless'|'ok', notionalUsd: number|null, maxFailOpenUsd: number }} p
 * @returns {{ ok: boolean, action: 'delay'|'fill-flagged', flagged: boolean, reason: string }}
 */
export function decideFailOpen({ referenceStatus, notionalUsd, maxFailOpenUsd }) {
  if (referenceStatus === "transient") {
    return { ok: false, action: "delay", flagged: false, reason: "transient reference outage on a feed-having pair — delaying (not fail-open)" }
  }
  // feedless (or an unexpected status — fail safe to delay)
  if (referenceStatus !== "feedless") {
    return { ok: false, action: "delay", flagged: false, reason: `unexpected reference status '${referenceStatus}' — delaying` }
  }
  if (notionalUsd === null || !Number.isFinite(notionalUsd)) {
    return { ok: false, action: "delay", flagged: false, reason: "feedless pair, notional unsizable — delaying (never fill blind)" }
  }
  if (notionalUsd <= maxFailOpenUsd) {
    return { ok: true, action: "fill-flagged", flagged: true, reason: `feedless pair, small fill ($${notionalUsd.toFixed(2)} <= $${maxFailOpenUsd} cap) — proceeding flagged` }
  }
  return { ok: false, action: "delay", flagged: false, reason: `feedless pair above the $${maxFailOpenUsd} fail-open cap ($${notionalUsd.toFixed(2)}) — delaying` }
}
