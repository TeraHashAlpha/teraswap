/**
 * TeraSwap Order Engine — Gelato Web3 Function v2
 *
 * This function runs every 30 seconds via Gelato Automate.
 * It checks Supabase for active orders and executes them
 * when conditions are met.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  Gelato Web3 Function v2 (runs every 30s)               │
 * │                                                          │
 * │  1. Fetch active orders from Supabase (oldest first)     │
 * │  2. For each order (up to MAX_BATCH):                    │
 * │     a. Atomic lock: set status → "executing"             │
 * │     b. Check via contract.canExecute()                   │
 * │     c. Fetch swap route from TeraSwap API                │
 * │     d. Build executeOrder() calldata                     │
 * │  3. Return batch of executable transactions              │
 * │  4. On-chain execution handles the actual swap           │
 * └──────────────────────────────────────────────────────────┘
 *
 * v2 CHANGES:
 * - H-01: router is now part of the Order struct (not separate param)
 * - M-03: Atomic check-and-execute with "executing" status lock
 * - L-04: Batch multiple orders per Gelato cycle
 * - Order prioritization: oldest first, then by gas efficiency
 *
 * DEPLOYMENT:
 *   npx w3f deploy web3Function.ts --secrets .env.gelato
 *
 * REQUIRED SECRETS:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RPC_URL (Ethereum mainnet)
 *   ORDER_EXECUTOR_ADDRESS
 *   TERASWAP_API_URL (optional, defaults to /api/swap)
 */

import {
  Web3Function,
  Web3FunctionContext,
} from "@gelatonetwork/web3-functions-sdk"
import { Contract, ethers } from "ethers"

// ── Constants ──────────────────────────────────────────────

const MAX_BATCH = 5 // Max orders to execute per Gelato cycle
const LOCK_TIMEOUT_MS = 60_000 // 60s — unlock stale "executing" orders

// ── ABI fragments (v2: router is part of Order struct) ─────

const ORDER_EXECUTOR_ABI = [
  "function canExecute(tuple(address owner, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint8 orderType, uint8 condition, uint256 targetPrice, address priceFeed, uint256 expiry, uint256 nonce, address router, uint256 dcaInterval, uint256 dcaTotal) order, bytes signature) view returns (bool canExec, string reason)",
  "function executeOrder(tuple(address owner, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint8 orderType, uint8 condition, uint256 targetPrice, address priceFeed, uint256 expiry, uint256 nonce, address router, uint256 dcaInterval, uint256 dcaTotal) order, bytes signature, bytes routerData)",
]

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]

// ── Types ──────────────────────────────────────────────────

interface SupabaseOrder {
  id: string
  wallet: string
  order_type: "limit" | "stop_loss" | "dca"
  token_in: string
  token_out: string
  amount_in: string
  min_amount_out: string
  target_price: string
  price_feed: string
  price_condition: "above" | "below"
  expiry: number
  nonce: number
  signature: string
  status: "active" | "executing" | "executed" | "cancelled" | "expired"
  router: string // [H-01] Router is now part of the signed order
  dca_interval: number
  dca_total: number
  dca_executed: number
  created_at: string
  updated_at: string
}

interface SwapRoute {
  data: string // Router calldata
}

// ── Gelato Web3 Function ───────────────────────────────────

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { secrets, multiChainProvider } = context

  // Load secrets
  const supabaseUrl = await secrets.get("SUPABASE_URL")
  const supabaseKey = await secrets.get("SUPABASE_SERVICE_ROLE_KEY")
  const executorAddress = await secrets.get("ORDER_EXECUTOR_ADDRESS")
  const teraswapApiUrl = (await secrets.get("TERASWAP_API_URL")) || ""

  if (!supabaseUrl || !supabaseKey || !executorAddress) {
    return { canExec: false, message: "Missing secrets" }
  }

  const provider = multiChainProvider.default()
  const executor = new Contract(executorAddress, ORDER_EXECUTOR_ABI, provider)

  // ── 0. Unlock stale "executing" orders (M-03: race condition prevention) ──
  await unlockStaleOrders(supabaseUrl, supabaseKey)

  // ── 1. Fetch active orders from Supabase (oldest first for priority) ──
  const orders = await fetchActiveOrders(supabaseUrl, supabaseKey)

  if (orders.length === 0) {
    return { canExec: false, message: "No active orders" }
  }

  // ── 2. Check each order, collect executable ones (up to MAX_BATCH) ──
  const callDatas: Array<{ to: string; data: string }> = []

  for (const dbOrder of orders) {
    if (callDatas.length >= MAX_BATCH) break

    try {
      // Check if expired (off-chain pre-filter)
      if (dbOrder.expiry < Math.floor(Date.now() / 1000)) {
        await updateOrderStatus(supabaseUrl, supabaseKey, dbOrder.id, "expired")
        continue
      }

      // [M-03] Atomic lock: set status to "executing" to prevent race conditions
      const locked = await lockOrder(supabaseUrl, supabaseKey, dbOrder.id)
      if (!locked) {
        console.log(`Order ${dbOrder.id}: Already locked by another worker`)
        continue
      }

      // Build order struct for v2 contract (includes router)
      const orderStruct = {
        owner: dbOrder.wallet,
        tokenIn: dbOrder.token_in,
        tokenOut: dbOrder.token_out,
        amountIn: dbOrder.amount_in,
        minAmountOut: dbOrder.min_amount_out,
        orderType: orderTypeToEnum(dbOrder.order_type),
        condition: dbOrder.price_condition === "above" ? 0 : 1,
        targetPrice: dbOrder.target_price,
        priceFeed: dbOrder.price_feed,
        expiry: dbOrder.expiry,
        nonce: dbOrder.nonce,
        router: dbOrder.router, // [H-01] Router from signed order
        dcaInterval: dbOrder.dca_interval || 0,
        dcaTotal: dbOrder.dca_total || 1,
      }

      // Check via contract (includes price, balance, allowance checks)
      const [canExec, reason] = await executor.canExecute(
        orderStruct,
        dbOrder.signature,
      )

      if (!canExec) {
        console.log(`Order ${dbOrder.id}: Cannot execute — ${reason}`)
        // Unlock — order is not ready yet
        await updateOrderStatus(supabaseUrl, supabaseKey, dbOrder.id, "active")
        continue
      }

      // ── 3. Build swap calldata ──
      const swapData = await fetchSwapRoute(
        teraswapApiUrl,
        dbOrder.token_in,
        dbOrder.token_out,
        dbOrder.amount_in,
        executorAddress,
        dbOrder.router,
      )

      if (!swapData) {
        console.log(`Order ${dbOrder.id}: Failed to get swap route`)
        // Unlock — we'll try again next cycle
        await updateOrderStatus(supabaseUrl, supabaseKey, dbOrder.id, "active")
        continue
      }

      // ── 4. Build executeOrder calldata ──
      // v2: executeOrder(order, signature, routerData) — no separate router param
      callDatas.push({
        to: executorAddress,
        data: executor.interface.encodeFunctionData("executeOrder", [
          orderStruct,
          dbOrder.signature,
          swapData.data,
        ]),
      })

      console.log(`Order ${dbOrder.id}: Queued for execution`)
    } catch (err) {
      console.error(`Order ${dbOrder.id} error:`, err)
      // Unlock on error
      await updateOrderStatus(supabaseUrl, supabaseKey, dbOrder.id, "active")
      continue
    }
  }

  if (callDatas.length === 0) {
    return { canExec: false, message: "No orders ready for execution" }
  }

  console.log(`Executing ${callDatas.length} orders this cycle`)

  return {
    canExec: true,
    callData: callDatas,
  }
})

// ── Helpers ─────────────────────────────────────────────────

function orderTypeToEnum(type: string): number {
  switch (type) {
    case "limit":
      return 0
    case "stop_loss":
      return 1
    case "dca":
      return 2
    default:
      return 0
  }
}

/**
 * Fetch active orders from Supabase, oldest first (prioritization).
 * Limits to MAX_BATCH * 3 to avoid processing too many in one cycle.
 */
async function fetchActiveOrders(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<SupabaseOrder[]> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/orders?status=eq.active&select=*&order=created_at.asc&limit=${MAX_BATCH * 3}`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
    },
  )

  if (!response.ok) {
    console.error(`Supabase fetch error: ${response.status}`)
    return []
  }

  return response.json()
}

/**
 * [M-03] Atomic lock: update status from "active" to "executing".
 * Uses Supabase's conditional update to prevent race conditions.
 * Returns true if lock acquired, false if already locked.
 */
async function lockOrder(
  supabaseUrl: string,
  supabaseKey: string,
  orderId: string,
): Promise<boolean> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/orders?id=eq.${orderId}&status=eq.active`,
    {
      method: "PATCH",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=headers-only",
      },
      body: JSON.stringify({
        status: "executing",
        updated_at: new Date().toISOString(),
      }),
    },
  )

  // If no rows matched (status wasn't "active"), the lock failed
  const contentRange = response.headers.get("content-range")
  if (contentRange && contentRange.includes("/0")) {
    return false
  }

  return response.ok
}

/**
 * [M-03] Unlock stale "executing" orders that have been stuck
 * for more than LOCK_TIMEOUT_MS. This prevents orders from being
 * permanently locked if a Gelato execution fails silently.
 */
async function unlockStaleOrders(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString()

  await fetch(
    `${supabaseUrl}/rest/v1/orders?status=eq.executing&updated_at=lt.${cutoff}`,
    {
      method: "PATCH",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        status: "active",
        updated_at: new Date().toISOString(),
      }),
    },
  )
}

async function updateOrderStatus(
  supabaseUrl: string,
  supabaseKey: string,
  orderId: string,
  status: string,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  })
}

/**
 * Fetch optimal swap route from TeraSwap aggregation API.
 * The router address is already part of the signed order,
 * so we just need the calldata for that specific router.
 */
async function fetchSwapRoute(
  apiUrl: string,
  tokenIn: string,
  tokenOut: string,
  amount: string,
  from: string,
  router: string,
): Promise<SwapRoute | null> {
  if (!apiUrl) {
    console.log("fetchSwapRoute: TERASWAP_API_URL not configured")
    return null
  }

  try {
    const res = await fetch(`${apiUrl}/api/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "best",
        src: tokenIn,
        dst: tokenOut,
        amount,
        from,
        slippage: 0.5,
        preferredRouter: router,
      }),
    })

    if (!res.ok) {
      console.error(`Swap route API error: ${res.status}`)
      return null
    }

    const data = await res.json()

    if (!data.tx?.data) {
      console.error("Swap route: missing tx data")
      return null
    }

    return { data: data.tx.data }
  } catch (err) {
    console.error("fetchSwapRoute error:", err)
    return null
  }
}
