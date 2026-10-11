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
// designed in ADR-013 and is a separate gated deploy — this keeper gate cuts the
// live exposure now without a redeploy.
//
// Pure + never-throwing (mirrors deviation-guard.js / retry-policy.js): no I/O,
// no Date.now, no provider — the caller passes the fetched prices in.

/**
 * Parse an env override as an integer clamped to [min, max]; unset/unparseable ⇒ the default.
 * @param {string|undefined} raw
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampedIntEnv(raw, def, min, max) {
  if (!raw) return def
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return def
  if (parsed < min) return min
  if (parsed > max) return max
  return parsed
}

// ── [ADR-024 / feat/keeper-price-quorum] Price-quorum constants ──────────────
// Owner decisions 2026-10-11. All three are env-overridable BY NAME (the env var is the
// constant's name), clamped so a mis-set value can only land in a sane band.

/** Price-source trust order, highest first. The quorum uses it ONLY to break a tie between two
 *  equally sized agreeing clusters (price-sources.js documents each source). */
export const PRICE_SOURCE_TRUST_ORDER = Object.freeze(["chainlink", "defillama", "coingecko"])

/** A source quote older than this (seconds) is ABSENT for the quorum — never stale-but-counted. */
export const MAX_PRICE_AGE_SEC = 600
export const MAX_PRICE_AGE_SEC_MIN = 30
export const MAX_PRICE_AGE_SEC_MAX = 86_400

/** Active max quote age: `MAX_PRICE_AGE_SEC` env override clamped to [30, 86400], else 600. */
export function getMaxPriceAgeSec(env = process.env) {
  return clampedIntEnv(env.MAX_PRICE_AGE_SEC, MAX_PRICE_AGE_SEC, MAX_PRICE_AGE_SEC_MIN, MAX_PRICE_AGE_SEC_MAX)
}

/** Two sources AGREE when their spread is within this many basis points (300 = 3%). */
export const QUORUM_TOLERANCE_BPS = 300
export const QUORUM_TOLERANCE_BPS_MIN = 10
export const QUORUM_TOLERANCE_BPS_MAX = 2000

/** Active tolerance: `QUORUM_TOLERANCE_BPS` env override clamped to [10, 2000], else 300. */
export function getQuorumToleranceBps(env = process.env) {
  return clampedIntEnv(env.QUORUM_TOLERANCE_BPS, QUORUM_TOLERANCE_BPS, QUORUM_TOLERANCE_BPS_MIN, QUORUM_TOLERANCE_BPS_MAX)
}

/** Consecutive quorum SKIPS of one order before the keeper alert fires (and re-fires every N). */
export const SKIP_ALERT_CYCLES = 3
export const SKIP_ALERT_CYCLES_MIN = 1
export const SKIP_ALERT_CYCLES_MAX = 1000

/** Active alert cadence: `SKIP_ALERT_CYCLES` env override clamped to [1, 1000], else 3. */
export function getSkipAlertCycles(env = process.env) {
  return clampedIntEnv(env.SKIP_ALERT_CYCLES, SKIP_ALERT_CYCLES, SKIP_ALERT_CYCLES_MIN, SKIP_ALERT_CYCLES_MAX)
}

/**
 * Spread between two positive prices in basis points, relative to the LOWER one (a 3% gap reads
 * the same whichever side is higher). Non-positive input ⇒ +∞ (can never agree).
 */
export function spreadBps(a, b) {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (!(lo > 0) || !Number.isFinite(hi)) return Number.POSITIVE_INFINITY
  return ((hi - lo) / lo) * 10_000
}

function lexLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return a.length < b.length
}

/**
 * The PRICE QUORUM for one leg of a DCA fill (owner decisions 2026-10-11, ADR-024). Pure.
 *
 *   quorum  ≥ 2 independent sources agree within `toleranceBps` ⇒ normal floor, from the more
 *           CONSERVATIVE price of the agreeing set. Conservative is leg-relative and always the
 *           PROTECTIVE side for a floor: the 'in' leg (what the user sells) takes the HIGHEST
 *           valuation, the 'out' leg (what the user receives) the LOWEST — both raise the floor,
 *           never lower it. With three sources, any agreeing pair forms the quorum and the outlier
 *           is dropped (the third source breaks the tie). Two equal-sized agreeing sets (A~B, B~C,
 *           A≁C) are split by trust order (chainlink > defillama > coingecko).
 *   single  exactly 1 source ⇒ the caller executes with a TIGHTER floor, capped at the no-price
 *           $ cap, flagged (singleSourceFloorBps / decideSingleSourceCap).
 *   skip    0 sources, or 2 that disagree beyond tolerance with no third to break the tie, or no
 *           agreeing pair at all ⇒ SKIP THIS CYCLE. Never fill blind, never cancel the order.
 *
 * One quote per source counts (the first wins — callers pass them in trust order); a quote with a
 * non-finite / non-positive price or no source name is ignored. An unknown leg is a skip (fail-safe).
 *
 * @param {'in'|'out'} leg
 * @param {Array<{ price: number, source: string }>} quotes
 * @param {{ toleranceBps?: number, trustOrder?: readonly string[] }} [opts]
 * @returns {{ mode: 'quorum'|'single'|'skip', price: number|null, reason: string, sources: string[], dropped: string[], spreadBps: number|null }}
 */
export function resolveFloorPrice(leg, quotes, { toleranceBps = getQuorumToleranceBps(), trustOrder = PRICE_SOURCE_TRUST_ORDER } = {}) {
  const none = (reason, extra = {}) => ({ mode: "skip", price: null, reason, sources: [], dropped: [], spreadBps: null, ...extra })
  if (leg !== "in" && leg !== "out") return none(`unknown leg '${String(leg)}' — skipping (fail-safe)`)

  const seen = new Set()
  const valid = []
  for (const q of Array.isArray(quotes) ? quotes : []) {
    if (!q || typeof q.source !== "string" || q.source === "") continue
    const p = Number(q.price)
    if (!Number.isFinite(p) || p <= 0) continue
    if (seen.has(q.source)) continue
    seen.add(q.source)
    valid.push({ price: p, source: q.source })
  }

  const n = valid.length
  if (n === 0) return none("no price source answered (0 of required 2)")
  if (n === 1) {
    return {
      mode: "single",
      price: valid[0].price,
      reason: `single source (${valid[0].source}) — tighter floor, $-capped, flagged`,
      sources: [valid[0].source],
      dropped: [],
      spreadBps: 0,
    }
  }

  const tol = Number.isFinite(toleranceBps) && toleranceBps >= 0 ? toleranceBps : QUORUM_TOLERANCE_BPS
  const agrees = (a, b) => spreadBps(a.price, b.price) <= tol
  const rank = (s) => {
    const i = trustOrder.indexOf(s)
    return i === -1 ? trustOrder.length : i
  }

  // Largest subset in which EVERY pair agrees (n is tiny: 2-3 sources). Tie ⇒ the subset whose
  // sorted trust ranks are lexicographically smallest (most-trusted members).
  let best = null
  for (let mask = 1; mask < 1 << n; mask++) {
    const members = valid.filter((_, i) => mask & (1 << i))
    if (members.length < 2) continue
    let ok = true
    for (let i = 0; i < members.length && ok; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (!agrees(members[i], members[j])) { ok = false; break }
      }
    }
    if (!ok) continue
    const ranks = members.map((m) => rank(m.source)).sort((a, b) => a - b)
    if (!best || members.length > best.members.length || (members.length === best.members.length && lexLess(ranks, best.ranks))) {
      best = { members, ranks }
    }
  }

  if (!best) {
    let worst = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) worst = Math.max(worst, spreadBps(valid[i].price, valid[j].price))
    const worstR = Math.round(worst)
    const reason =
      n === 2
        ? `2 sources (${valid.map((v) => v.source).join(", ")}) disagree beyond ${tol} bps (spread ${worstR} bps), no third to break the tie`
        : `no two of ${n} sources (${valid.map((v) => v.source).join(", ")}) agree within ${tol} bps (max spread ${worstR} bps)`
    return none(reason, { sources: valid.map((v) => v.source), spreadBps: worstR })
  }

  const prices = best.members.map((m) => m.price)
  const price = leg === "in" ? Math.max(...prices) : Math.min(...prices)
  const used = best.members.map((m) => m.source)
  const dropped = valid.map((v) => v.source).filter((s) => !used.includes(s))
  const spread = Math.round(spreadBps(Math.min(...prices), Math.max(...prices)))
  return {
    mode: "quorum",
    price,
    reason:
      `quorum ${used.join("+")} within ${spread} bps (tol ${tol}); conservative(${leg}) = ${leg === "in" ? "max" : "min"}` +
      (dropped.length ? `; dropped outlier ${dropped.join(",")}` : ""),
    sources: used,
    dropped,
    spreadBps: spread,
  }
}

/**
 * The fill-level mode from the two legs' modes: any skip ⇒ skip; else any single ⇒ single; else
 * quorum. Unknown input ⇒ skip (fail-safe).
 * @param {string} inMode
 * @param {string} outMode
 * @returns {'quorum'|'single'|'skip'}
 */
export function combineLegModes(inMode, outMode) {
  const known = new Set(["quorum", "single", "skip"])
  if (!known.has(inMode) || !known.has(outMode)) return "skip"
  if (inMode === "skip" || outMode === "skip") return "skip"
  if (inMode === "single" || outMode === "single") return "single"
  return "quorum"
}

/**
 * The TIGHTER floor band for a single-source fill: half the normal band, never below the floor's
 * own MIN clamp (so it can never be disabled). 300 ⇒ 150 bps.
 * @param {number} normalBps  getFloorMaxSlippageBps()
 * @returns {number}
 */
export function singleSourceFloorBps(normalBps) {
  const n = Number(normalBps)
  if (!Number.isFinite(n) || n <= 0) return DCA_ORACLE_FLOOR_BPS_MIN
  return Math.max(DCA_ORACLE_FLOOR_BPS_MIN, Math.floor(n / 2))
}

/**
 * The $ cap on a single-source fill — the SAME cap the feedless fail-open path used
 * (getFailOpenMaxUsd / DCA_FAIL_OPEN_MAX_USD, value unchanged). Unsizable ⇒ delay (never blind);
 * within the cap ⇒ proceed flagged; above ⇒ delay.
 * @param {{ notionalUsd: number|null, maxUsd: number }} p
 * @returns {{ ok: boolean, action: 'delay'|'fill-flagged', flagged: boolean, reason: string }}
 */
export function decideSingleSourceCap({ notionalUsd, maxUsd }) {
  if (notionalUsd === null || notionalUsd === undefined || !Number.isFinite(notionalUsd)) {
    return { ok: false, action: "delay", flagged: false, reason: "single source, notional unsizable — delaying (never fill blind)" }
  }
  if (notionalUsd <= maxUsd) {
    return { ok: true, action: "fill-flagged", flagged: true, reason: `single source, small fill ($${notionalUsd.toFixed(2)} <= $${maxUsd} cap) — proceeding flagged` }
  }
  return { ok: false, action: "delay", flagged: false, reason: `single source, fill above the $${maxUsd} cap ($${notionalUsd.toFixed(2)}) — delaying` }
}

/**
 * Per-order CONSECUTIVE quorum-skip tracking (in-memory Map owned by the caller). Bump on a skip;
 * `alert` is true when the streak hits `alertEvery` (and every multiple of it, so a long outage
 * re-alerts rather than going silent). Never persisted: a restart starts the count fresh.
 * @param {Map<string, number>} skips
 * @param {string} orderId
 * @param {number} [alertEvery]  getSkipAlertCycles()
 * @returns {{ count: number, alert: boolean }}
 */
export function recordQuorumSkip(skips, orderId, alertEvery = getSkipAlertCycles()) {
  const count = (skips.get(orderId) || 0) + 1
  skips.set(orderId, count)
  const every = Number.isInteger(alertEvery) && alertEvery > 0 ? alertEvery : SKIP_ALERT_CYCLES
  return { count, alert: count % every === 0 }
}

/** Reset an order's skip streak — the cycle resolved a price (sources returned) or the fill succeeded. */
export function clearQuorumSkips(skips, orderId) {
  return skips.delete(orderId)
}

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
  // signed floor (ADR-013); no keeper-side check can catch a self-consistent bad
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
// [ADR-024 / feat/keeper-price-quorum] SUPERSEDED IN THE EXECUTOR: classifyReference and
// decideFailOpen are no longer called by executor.js — the transient-vs-feedless split is
// replaced by the price quorum above (0 or disagreeing sources ⇒ SKIP the cycle; exactly one ⇒
// decideSingleSourceCap with the SAME cap). Both functions and their tests are retained unchanged
// as the pure API surface (rule #4: nothing deleted); getFailOpenMaxUsd / DCA_FAIL_OPEN_MAX_USD
// remain the live cap (28b's web-side DCA_NO_PRICE_FILL_CAP_MAX_USD pins to that literal).
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
