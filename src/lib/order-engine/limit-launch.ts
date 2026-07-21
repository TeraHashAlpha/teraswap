/**
 * [SPRINT-P1B / ADR-014 option (a)] Launch gate for Limit + Take-Profit conditional orders.
 *
 * Mirrors `src/lib/dca-launch.ts` exactly (same fail-closed shape, same strict `'true'` literal),
 * because Limit/TP carry the same class of risk: a real on-chain order signed against a real
 * executor. Every condition must hold:
 *
 *   1. `NEXT_PUBLIC_LIMIT_ENABLED === 'true'` — the owner's explicit kill-switch.
 *   2. chain === Base (8453) — P1b is Base-only; mainnet/Arbitrum are out of scope (SPRINT-48
 *      owns Arbitrum).
 *   3. an OrderExecutorV3 is configured for the chain — Limit/TP are v3-ONLY. v2's non-DCA path
 *      is structurally unexecutable (threat-model P1c), so falling back to v2 would silently
 *      create orders that can never fill.
 *   4. a canonical (quote-free) router exists in the chain's whitelisted set — without
 *      SwapRouter02 there is no pinnable route, and an aggregator route cannot be pinned.
 *
 * Stop-Loss is NOT covered by this gate and is blocked unconditionally — it is deferred to the v4
 * executor (owner decision 2026-07-22), because its failure mode is inverted: a pinned route that
 * cannot fill during a crash IS the loss. See ADR-014 "Decision".
 */

import { getOrderExecutorV3, getCanonicalRouteRouter } from './config'

/** The only chain P1b enables. */
export const LIMIT_TP_CHAIN_ID = 8453

/**
 * The reason Stop-Loss creation is refused everywhere (UI + API). Pinned verbatim by tests so the
 * copy can't drift away from the ADR rationale.
 */
export const STOP_LOSS_DEFERRED_REASON = 'Stop-Loss ships with the v4 executor'

/** Owner kill-switch. Strict literal `'true'` — `'1'`/`'TRUE'` do NOT enable (mirrors DCA). */
export function isLimitLaunchEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIMIT_ENABLED === 'true'
}

/**
 * True only when Limit/Take-Profit can be created safely on this chain. Fail-closed: any missing
 * condition ⇒ false, and the panel stays gated.
 */
export function isLimitLive(chainId: number): boolean {
  return (
    isLimitLaunchEnabled() &&
    chainId === LIMIT_TP_CHAIN_ID &&
    getOrderExecutorV3(chainId) !== null &&
    getCanonicalRouteRouter(chainId) !== null
  )
}
