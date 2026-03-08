/**
 * TeraSwap Order Engine — Gelato Web3 Function
 *
 * This function runs every 30 seconds via Gelato Automate.
 * It checks Supabase for active orders and executes them
 * when conditions are met.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  Gelato Web3 Function (runs every 30s)                   │
 * │                                                          │
 * │  1. Fetch active orders from Supabase                    │
 * │  2. For each order:                                      │
 * │     a. Check price condition (Chainlink via RPC)         │
 * │     b. Check user balance + allowance                    │
 * │     c. If conditions met → build swap calldata           │
 * │     d. Call OrderExecutor.executeOrder()                 │
 * │  3. Update order status in Supabase                      │
 * └──────────────────────────────────────────────────────────┘
 *
 * DEPLOYMENT:
 *   npx w3f deploy web3Function.ts --secrets .env.gelato
 *
 * REQUIRED SECRETS:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RPC_URL (Ethereum mainnet)
 *   ORDER_EXECUTOR_ADDRESS
 */

import {
  Web3Function,
  Web3FunctionContext,
} from "@gelatonetwork/web3-functions-sdk"
import { Contract, ethers } from "ethers"

// ── ABI fragments ──────────────────────────────────────────

const ORDER_EXECUTOR_ABI = [
  "function canExecute(tuple(address owner, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint8 orderType, uint8 condition, uint256 targetPrice, address priceFeed, uint256 expiry, uint256 nonce, uint256 dcaInterval, uint256 dcaTotal) order, bytes signature) view returns (bool canExec, string reason)",
  "function executeOrder(tuple(address owner, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint8 orderType, uint8 condition, uint256 targetPrice, address priceFeed, uint256 expiry, uint256 nonce, uint256 dcaInterval, uint256 dcaTotal) order, bytes signature, address router, bytes routerData)",
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
  dca_interval: number
  dca_total: number
  dca_executed: number
  router: string
  created_at: string
}

// ── Gelato Web3 Function ───────────────────────────────────

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { secrets, multiChainProvider } = context

  // Load secrets
  const supabaseUrl = await secrets.get("SUPABASE_URL")
  const supabaseKey = await secrets.get("SUPABASE_SERVICE_ROLE_KEY")
  const executorAddress = await secrets.get("ORDER_EXECUTOR_ADDRESS")

  if (!supabaseUrl || !supabaseKey || !executorAddress) {
    return { canExec: false, message: "Missing secrets" }
  }

  const provider = multiChainProvider.default()

  // ── 1. Fetch active orders from Supabase ──

  const response = await fetch(
    `${supabaseUrl}/rest/v1/orders?status=eq.active&select=*`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
    },
  )

  if (!response.ok) {
    return { canExec: false, message: `Supabase error: ${response.status}` }
  }

  const orders: SupabaseOrder[] = await response.json()

  if (orders.length === 0) {
    return { canExec: false, message: "No active orders" }
  }

  // ── 2. Check each order ──

  const executor = new Contract(executorAddress, ORDER_EXECUTOR_ABI, provider)

  for (const dbOrder of orders) {
    try {
      // Check if expired
      if (dbOrder.expiry < Math.floor(Date.now() / 1000)) {
        await updateOrderStatus(supabaseUrl, supabaseKey, dbOrder.id, "expired")
        continue
      }

      // Build order struct for contract
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
        continue
      }

      // ── 3. Build swap calldata ──
      // Fetch optimal swap route from TeraSwap API
      const swapData = await fetchSwapRoute(
        dbOrder.token_in,
        dbOrder.token_out,
        dbOrder.amount_in,
        executorAddress, // The executor contract is the "from" address
        dbOrder.router,
      )

      if (!swapData) {
        console.log(`Order ${dbOrder.id}: Failed to get swap route`)
        continue
      }

      // ── 4. Execute via Gelato ──
      return {
        canExec: true,
        callData: [
          {
            to: executorAddress,
            data: executor.interface.encodeFunctionData("executeOrder", [
              orderStruct,
              dbOrder.signature,
              swapData.router,
              swapData.data,
            ]),
          },
        ],
      }
    } catch (err) {
      console.error(`Order ${dbOrder.id} error:`, err)
      continue
    }
  }

  return { canExec: false, message: "No orders ready for execution" }
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

async function fetchSwapRoute(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  from: string,
  preferredRouter: string,
): Promise<{ router: string; data: string } | null> {
  // In production, this calls your TeraSwap API to get optimal swap route
  // For now, return null (will be connected to /api/swap)
  //
  // const res = await fetch(`https://teraswap.app/api/swap`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     source: 'best',
  //     src: tokenIn,
  //     dst: tokenOut,
  //     amount,
  //     from,
  //     slippage: 0.5,
  //   }),
  // })
  // const data = await res.json()
  // return { router: data.tx.to, data: data.tx.data }

  console.log("fetchSwapRoute: Not yet connected to TeraSwap API")
  return null
}
