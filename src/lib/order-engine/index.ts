/**
 * TeraSwapOrderExecutor v2 — Order Engine SDK
 *
 * Re-exports everything the frontend needs.
 */

export { ORDER_EXECUTOR_ABI } from './abi'
export { ORDER_EXECUTOR_ADDRESS, ORDER_EXECUTOR_DOMAIN, getOrderExecutorDomain, WHITELISTED_ROUTERS, getWhitelistedRouters, getDefaultRouter, CHAINLINK_FEEDS, getChainlinkFeeds, EXPIRY_PRESETS, DCA_INTERVAL_PRESETS, DCA_TOTAL_PRESETS, MAX_EXPIRY_DAYS, MAX_ACTIVE_ORDERS, ORDER_POLL_INTERVAL_MS } from './config'
export { OrderType, PriceCondition, ORDER_EIP712_TYPES } from './types'
export type { OnChainOrder, AutonomousOrder, AutonomousOrderStatus, CreateOrderConfig, OrderEngineEvent } from './types'
export { createOrderInSupabase, fetchUserOrders, fetchActiveOrders, cancelOrderInSupabase, fetchDCAExecutions, subscribeToOrders } from './supabase'
export type { OrderRow, ExecutionRow } from './supabase'
