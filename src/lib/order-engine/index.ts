/**
 * TeraSwapOrderExecutor v2 — Order Engine SDK
 *
 * Re-exports everything the frontend needs.
 */

export { ORDER_EXECUTOR_ABI } from './abi'
export { ORDER_EXECUTOR_BY_CHAIN, getOrderExecutor, ORDER_EXECUTOR_ADDRESS, getOrderExecutorDomain, CANCEL_ORDER_TYPES, WHITELISTED_ROUTERS, getWhitelistedRouters, getDefaultRouter, CHAINLINK_FEEDS, getChainlinkFeeds, EXPIRY_PRESETS, DCA_INTERVAL_PRESETS, DCA_TOTAL_PRESETS, MAX_EXPIRY_DAYS, MAX_ACTIVE_ORDERS, ORDER_POLL_INTERVAL_MS, MIN_ORDER_AMOUNT } from './config'
export { OrderType, PriceCondition, ORDER_EIP712_TYPES } from './types'
export type { OnChainOrder, AutonomousOrder, AutonomousOrderStatus, CreateOrderConfig, OrderEngineEvent } from './types'
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
