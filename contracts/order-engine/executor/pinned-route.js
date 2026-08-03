/**
 * [SPRINT-P1B / ADR-014 option (a)] Pinned-route resolution + route-revert telemetry for non-DCA
 * v3 conditional orders (Limit / Take-Profit).
 *
 * WHY A SEPARATE PURE MODULE: executor.js auto-runs main() on import, so it is not unit-testable.
 * Every decision here is therefore pure (no I/O, no clock) and covered by pinned-route.test.mjs,
 * matching the convention of order-floor.js / retry-policy.js / executor-routing.js.
 *
 * ── The rule this module enforces ──────────────────────────────────────────────────────────────
 * A non-DCA v3 order committed to EXACT swap calldata at signing time:
 * TeraSwapOrderExecutorV3.sol:463-465 reverts RouterDataRequired on ZeroHash and
 * RouterDataMismatch when keccak256(routerData) != order.routerDataHash. So the keeper must
 * REPLAY the stored bytes verbatim and must NEVER rebuild a route for these orders — a rebuilt
 * route would hash differently and revert 100% of the time (which is exactly the latent bug in
 * the pre-P1b code path, where the keeper hashed freshly-built calldata against the signed hash
 * and could only ever pass by luck).
 *
 * DCA is untouched: it signs ZeroHash by design and keeps keeper-built per-chunk calldata.
 */

import { keccak256 } from "viem"

/** bytes32(0) — the DCA "dynamic calldata" sentinel. */
export const ZERO_HASH = "0x" + "00".repeat(32)

/**
 * How many CONSECUTIVE route reverts on one order before we page ops.
 *
 * A pinned route reverting is an EXPECTED, recoverable outcome under ADR-014 option (a): the
 * pool the user pinned may be temporarily thin or dislocated, in which case the correct
 * behaviour is to leave the order active and retry later — it is not an order failure and must
 * never mark the order 'failed' (for a Limit/TP, "did not fill" is an acceptable outcome; that
 * is precisely why Stop-Loss was deferred to v4). But a route that reverts over and over is a
 * LIVENESS signal the owner needs to see, because the user's order is silently not filling
 * despite its price condition being met.
 */
export const MAX_CONSECUTIVE_ROUTE_REVERTS = 5

/**
 * Resolve the calldata a non-DCA v3 order must be executed with.
 *
 * @param {object} p
 * @param {string} p.orderType         DB `order_type` ('limit' | 'stop_loss' | 'dca')
 * @param {object|null} p.orderData    The stored `order_data` JSONB
 * @param {string} p.signedRouterDataHash `orderStruct.routerDataHash` (the SIGNED value)
 * @returns {{ pinned: boolean, ok: boolean, routerData: string|null, reason: string }}
 *   pinned=false ⇒ this order does not use a pinned route (DCA) — the caller builds a route.
 *   pinned=true + ok=false ⇒ REFUSE to execute (never fall back to building a route).
 */
export function resolvePinnedRouterData({ orderType, orderData, signedRouterDataHash }) {
  const isDca = orderType === "dca"
  if (isDca) {
    return { pinned: false, ok: true, routerData: null, reason: "DCA — keeper-built calldata" }
  }

  // A non-DCA order whose signed hash is ZeroHash is the P1c landmine: the contract reverts
  // RouterDataRequired unconditionally, so it can NEVER execute. Refuse loudly rather than
  // burning gas on a guaranteed revert.
  if (!signedRouterDataHash || signedRouterDataHash.toLowerCase() === ZERO_HASH) {
    return {
      pinned: true,
      ok: false,
      routerData: null,
      reason:
        "non-DCA order carries ZeroHash routerDataHash — unexecutable by construction (contract reverts RouterDataRequired)",
    }
  }

  const stored = orderData && typeof orderData.routerData === "string" ? orderData.routerData : null
  if (!stored) {
    return {
      pinned: true,
      ok: false,
      routerData: null,
      reason: "non-DCA order has a real routerDataHash but no stored order_data.routerData to replay",
    }
  }

  if (!/^0x[0-9a-fA-F]*$/.test(stored) || stored.length < 10) {
    return { pinned: true, ok: false, routerData: null, reason: "stored routerData is not valid calldata" }
  }

  // Pre-flight the exact check the contract performs at :465. Cheaper to catch here than to
  // spend gas discovering it on-chain; the contract remains the authority either way.
  let actual
  try {
    actual = keccak256(stored)
  } catch {
    return { pinned: true, ok: false, routerData: null, reason: "stored routerData could not be hashed" }
  }

  if (actual.toLowerCase() !== signedRouterDataHash.toLowerCase()) {
    return {
      pinned: true,
      ok: false,
      routerData: null,
      reason: `stored routerData does not match the SIGNED routerDataHash (got ${actual.slice(0, 10)}..., want ${signedRouterDataHash.slice(0, 10)}...)`,
    }
  }

  return { pinned: true, ok: true, routerData: stored, reason: "pinned route verified against the signed hash" }
}

// [FIX-P1B-M01] Executor errors that mean "the market/route wasn't right at THIS moment" — the
// pinned route itself is still valid and should be retried, never routed to the failure ladder.
// Deliberately NOT the executor's permanent-cause errors (OrderExpired, OrderCancelledError,
// InvalidNonce, RouterNotWhitelisted, InsufficientBalance/Allowance, RouterDataMismatch/Required)
// — those keep falling through to handleExecutionFailure exactly as before this fix.
export const MARKET_REVERT_ERROR_NAMES = new Set(["InsufficientOutput", "PriceConditionNotMet"])

/**
 * Decide whether an observed non-DCA-v3 revert is a MARKET/ROUTE revert (stay active, count
 * toward the pinned-route-revert streak) or something else (fall through to the existing
 * permanent-cause classification, unchanged).
 *
 * Bug this replaces: gating on `swapReason` truthiness alone only caught a ROUTER revert wrapped
 * in `SwapFailed(bytes)`. The executor's OWN `InsufficientOutput()` — the common case for a
 * triggered order whose pinned pool has moved (output lands in [signedMin, oracleFloor)) — never
 * wraps as SwapFailed (the router call itself succeeded), so it fell through to the failure
 * ladder and the order was marked 'failed' after MAX_CYCLE_FAILURES cycles instead of staying
 * active until expiry.
 *
 * @param {object} p
 * @param {string|null} [p.swapReason] set when the revert was SwapFailed(bytes) (decodeSwapFailed)
 * @param {string|null} [p.executorErrorName] set when the revert was one of the executor's OWN
 *   no-arg custom errors (decodeExecutorMarketRevert) — null for anything undecoded/permanent
 * @returns {boolean}
 */
export function isMarketRevert({ swapReason = null, executorErrorName = null } = {}) {
  if (swapReason) return true
  if (executorErrorName && MARKET_REVERT_ERROR_NAMES.has(executorErrorName)) return true
  return false
}

/**
 * Decide what to do after a pinned route reverted at trigger.
 *
 * Deliberately NOT wired into retry-policy.js's failure ladder: that ladder ends in marking the
 * order 'failed', which is wrong here. A pinned-route revert leaves the order ACTIVE so it can
 * fill on any later cycle within its expiry — the ADR-014 (a) trade-off, made visible instead of
 * silent.
 *
 * @param {object} p
 * @param {number} p.consecutiveReverts count INCLUDING the revert just observed
 * @param {number} [p.threshold]
 * @returns {{ keepActive: true, alert: boolean, reason: string }}
 */
export function planPinnedRouteRevert({ consecutiveReverts, threshold = MAX_CONSECUTIVE_ROUTE_REVERTS }) {
  const alert = consecutiveReverts >= threshold
  return {
    keepActive: true,
    alert,
    reason: alert
      ? `pinned route reverted ${consecutiveReverts}x consecutively — the pinned pool may be dislocated; the order is still active and will keep retrying until expiry`
      : `pinned route reverted (${consecutiveReverts}/${threshold}) — retrying on a later cycle`,
  }
}
