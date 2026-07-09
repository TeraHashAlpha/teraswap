/**
 * TeraSwapOrderExecutor v2 — Order Engine SDK
 *
 * Re-exports everything the frontend needs.
 */

export { ORDER_EXECUTOR_ABI } from './abi'
export { ORDER_EXECUTOR_BY_CHAIN, getOrderExecutor, ORDER_EXECUTOR_ADDRESS, getOrderExecutorDomain, CANCEL_ORDER_TYPES, WHITELISTED_ROUTERS, getWhitelistedRouters, getDefaultRouter, CHAINLINK_FEEDS, getChainlinkFeeds, EXPIRY_PRESETS, DCA_INTERVAL_PRESETS, DCA_TOTAL_PRESETS, MAX_EXPIRY_DAYS, MAX_ACTIVE_ORDERS, ORDER_POLL_INTERVAL_MS, MIN_ORDER_AMOUNT,
  // [SPRINT-V3-P2] v3 config — fail-closed while ORDER_EXECUTOR_V3_BY_CHAIN[chainId] is null.
  ORDER_EXECUTOR_V3_BY_CHAIN, getOrderExecutorV3, getOrderExecutorV3Domain } from './config'
export { OrderType, PriceCondition, ORDER_EIP712_TYPES,
  // [SPRINT-V3-P2 / ADR-013 §1]
  ORDER_V3_EIP712_TYPES, ORDER_V3_TYPE_STRING, MAX_ORDER_SLIPPAGE_BPS, DEFAULT_MAX_SLIPPAGE_BPS } from './types'
export type { OnChainOrder, AutonomousOrder, AutonomousOrderStatus, CreateOrderConfig, OrderEngineEvent } from './types'
// [SPRINT-V3-P2] Pure absolute-min derivation (signing-side floor, ADR-013 §1 I-01/L-01 closure).
export { deriveAbsoluteMinAmountOut, computeReferenceExpectedOutTs, deriveSigningMinAmountOut } from './v3-min-derivation'
export type { MinAmountOutSource, DeriveSigningMinParams, DeriveSigningMinResult } from './v3-min-derivation'
export { createOrderInSupabase, fetchUserOrders, fetchActiveOrders, cancelOrderInSupabase, subscribeToOrders } from './supabase'
export type { OrderRow } from './supabase'
// [AUDIT-W6 / W6-M-01] Per-session proof-of-ownership for active-order reads.
export {
  buildOrdersReadTypedData,
  verifyOrdersReadAccess,
  ensureOrdersReadAuth,
  retryOrdersReadAuth,
  ordersReadHeaders,
  getCachedOrdersReadAuth,
  storeOrdersReadAuth,
  ReadAuthRequiredError,
  PUBLIC_ORDER_STATUSES,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  ORDERS_READ_TTL_MS,
  ORDERS_READ_PURPOSE,
} from './read-auth'
export type { OrdersReadAuth } from './read-auth'
// [CHORE-DCA-POSITIONS-DASHBOARD] Positions dashboard helpers (pure, unit-tested).
export { nextBuyAtMs, isDue, formatHMS } from './dca-countdown'
export { fillUsd, APPROX_PRICES } from './usd'
export { sourceForRouter, routeLabel, ROUTER_TO_SOURCE } from './route-source'
export { failedOrderReason, DEFAULT_FAILED_REASON, FAILURE_REASON_LABELS } from './failed-reason'
export { dcaScheduleFitsExpiry } from './dca-creation-guard'
export type { DcaScheduleFit } from './dca-creation-guard'
// [CHORE-DCA-CUSTOM-PERIODS] Custom interval/buys mode: input clamps, auto-derived expiry
// (capped at MAX_EXPIRY_DAYS), the SC-02 min-chunk dust guard, and the summary line.
export {
  DCA_CUSTOM_BUYS_MIN,
  DCA_CUSTOM_BUYS_MAX,
  DCA_CUSTOM_INTERVAL_NUMBER_MIN,
  DCA_CUSTOM_INTERVAL_NUMBER_MAX,
  DCA_MIN_CHUNK_USD_DEFAULT,
  clampCustomBuys,
  clampCustomIntervalNumber,
  customIntervalSeconds,
  deriveCustomExpirySeconds,
  getDcaMinChunkUsd,
  applyDcaMinChunkGuard,
  customDcaSummary,
} from './dca-custom'
export type { DcaCustomIntervalUnit, DcaMinChunkResult } from './dca-custom'
