/**
 * TeraSwapOrderExecutor v2 — Order Engine SDK
 *
 * Re-exports everything the frontend needs.
 */

export { ORDER_EXECUTOR_ABI } from './abi'
export { ORDER_EXECUTOR_BY_CHAIN, getOrderExecutor, ORDER_EXECUTOR_ADDRESS, getOrderExecutorDomain, CANCEL_ORDER_TYPES, WHITELISTED_ROUTERS, getWhitelistedRouters, getDefaultRouter, CHAINLINK_FEEDS, getChainlinkFeeds, EXPIRY_PRESETS, DCA_INTERVAL_PRESETS, DCA_TOTAL_PRESETS, MAX_EXPIRY_DAYS, MAX_ACTIVE_ORDERS, ORDER_POLL_INTERVAL_MS, MIN_ORDER_AMOUNT } from './config'
export { OrderType, PriceCondition, ORDER_EIP712_TYPES } from './types'
export type { OnChainOrder, AutonomousOrder, AutonomousOrderStatus, CreateOrderConfig, OrderEngineEvent } from './types'
export { createOrderInSupabase, fetchUserOrders, fetchActiveOrders, cancelOrderInSupabase, fetchDCAExecutions, subscribeToOrders } from './supabase'
export type { OrderRow, ExecutionRow } from './supabase'
// [CHORE-DCA-POSITIONS-DASHBOARD] Positions dashboard helpers (pure, unit-tested).
export { nextBuyAtMs, isDue, formatHMS } from './dca-countdown'
export { fillUsd, APPROX_PRICES } from './usd'
export { sourceForRouter, routeLabel, ROUTER_TO_SOURCE } from './route-source'
export { failedOrderReason, DEFAULT_FAILED_REASON, FAILURE_REASON_LABELS } from './failed-reason'
export { dcaScheduleFitsExpiry } from './dca-creation-guard'
export type { DcaScheduleFit } from './dca-creation-guard'
