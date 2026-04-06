/**
 * TeraSwap Order Executor -- Self-hosted keeper
 *
 * Replaces Gelato Web3 Functions with a standalone Node.js process.
 * Runs every POLL_INTERVAL_MS, checks Supabase for active orders,
 * verifies on-chain conditions via canExecute(), fetches swap routes,
 * and sends executeOrder() transactions directly.
 *
 * +---------------------------------------------------------+
 * |  Self-hosted Executor (runs every 30s)                   |
 * |                                                          |
 * |  1. Unlock stale "executing" orders (>60s stuck)         |
 * |  2. Fetch active orders from Supabase (oldest first)     |
 * |  3. For each order (up to MAX_BATCH):                    |
 * |     a. Atomic lock: set status -> "executing"            |
 * |     b. Call contract.canExecute() on-chain               |
 * |     c. Fetch swap route from TeraSwap API                |
 * |     d. Send executeOrder() transaction                   |
 * |     e. Record execution in order_executions table        |
 * |     f. Update order status                               |
 * |  4. Log results, wait, repeat                            |
 * +---------------------------------------------------------+
 *
 * DEPLOYMENT:
 *   1. Copy .env.executor.example -> .env.executor
 *   2. Fill in secrets
 *   3. npm install
 *   4. npm start  (or use pm2 / systemd for production)
 *
 * REQUIRED ENV VARS:
 *   RPC_URL                     -- Ethereum RPC endpoint
 *   EXECUTOR_PRIVATE_KEY        -- Private key for the executor wallet (pays gas)
 *   SUPABASE_URL                -- Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   -- Supabase service role key (server-side)
 *   ORDER_EXECUTOR_ADDRESS      -- Deployed contract address
 *   TERASWAP_API_URL            -- (optional) Base URL for swap route API
 *   CHAIN_ID                    -- (optional) Chain ID, defaults to 11155111 (Sepolia)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  getAddress,
  keccak256,
  parseGwei,
  formatUnits,
  formatEther,
  zeroHash,
} from "viem"
import { readFileSync } from "fs"
import { join } from "path"
import { createServer } from "http"
import { createExecutorAccount } from "./kms-signer.js"  // [C-02/B-01] HSM/KMS support
import { startEventWatcher } from "./event-watcher.js"
import { ExecutorMonitor } from "./monitor.js"            // [EX-MON] Prometheus + Telegram

// ---- Load .env.executor manually (no dotenv dependency) ----------------

function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIndex = trimmed.indexOf("=")
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim()
      if (!process.env[key]) {
        process.env[key] = value
      }
    }
  } catch (err) {
    console.warn(`WARNING: Could not load ${filePath}: ${err.message}`)
  }
}

// Use process.cwd() -- works with spaces in path
loadEnv(join(process.cwd(), ".env.executor"))

// ---- Configuration -----------------------------------------------------

const RPC_URL = process.env.RPC_URL
const PRIVATE_KEY = process.env.EXECUTOR_PRIVATE_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CONTRACT_ADDRESS = process.env.ORDER_EXECUTOR_ADDRESS
const FEE_COLLECTOR_ADDRESS = process.env.FEE_COLLECTOR_ADDRESS || ""
const API_URL = process.env.TERASWAP_API_URL || ""
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "1") // Default to mainnet

// [B-02] Flashbots Protect RPC -- prevents MEV/sandwich attacks on executor txs
const FLASHBOTS_RPC = process.env.FLASHBOTS_RPC_URL || ""

const POLL_INTERVAL_MS = 30_000 // 30 seconds
const MAX_BATCH = 5             // Max orders per cycle
const LOCK_TIMEOUT_MS = 60_000  // 60s -- unlock stale orders
// ── Gas Strategy Tiers ──────────────────────────────────────
// Defaults preserve 100 gwei ceiling but add tiered filtering: NORMAL ≤30, ELEVATED ≤80, URGENT ≤100.
// Orders below ceiling but above their tier threshold may be deferred — this is intentional.
const GAS_TIER_NORMAL   = parseInt(process.env.GAS_TIER_NORMAL_GWEI   || "30")
const GAS_TIER_ELEVATED = parseInt(process.env.GAS_TIER_ELEVATED_GWEI || "80")
const GAS_TIER_URGENT   = parseInt(process.env.GAS_TIER_URGENT_GWEI   || "100")

// EIP-1559 priority fees per tier (in gwei)
const PRIORITY_FEE_NORMAL   = parseFloat(process.env.GAS_PRIORITY_NORMAL_GWEI   || "1.5")
const PRIORITY_FEE_ELEVATED = parseFloat(process.env.GAS_PRIORITY_ELEVATED_GWEI || "2.5")
const PRIORITY_FEE_URGENT   = parseFloat(process.env.GAS_PRIORITY_URGENT_GWEI   || "4")

// Base fee multipliers per tier
const BASEFEE_MULT_NORMAL   = parseFloat(process.env.GAS_BASEFEE_MULT_NORMAL   || "2")
const BASEFEE_MULT_ELEVATED = parseFloat(process.env.GAS_BASEFEE_MULT_ELEVATED || "2.5")
const BASEFEE_MULT_URGENT   = parseFloat(process.env.GAS_BASEFEE_MULT_URGENT   || "3")

// Urgency thresholds
const EXPIRY_URGENCY_SECONDS = parseInt(process.env.GAS_EXPIRY_URGENCY_S || "7200") // 2 hours
const MAX_RETRIES = 3           // [Audit] Max retries per order before marking failed
const RETRY_BACKOFF_BASE = 5_000 // [Audit] Base backoff 5s (exponential: 5s, 10s, 20s)

// [Audit] Per-order retry tracking
const orderRetries = new Map()   // orderId -> { count, lastAttempt }

// ---- Chain config (minimal, supports any chain ID) ---------------------

const chain = {
  id: CHAIN_ID,
  name: "ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL || ""] } },
}

// ---- Validate config ---------------------------------------------------

function validateConfig() {
  const required = {
    RPC_URL,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY,
    ORDER_EXECUTOR_ADDRESS: CONTRACT_ADDRESS,
  }

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (missing.length > 0) {
    console.error(`FATAL: Missing required env vars: ${missing.join(", ")}`)
    console.error("   Copy .env.executor.example -> .env.executor and fill in values")
    process.exit(1)
  }

  // [C-02/B-01] Validate that at least one signing method is configured
  const hasKms = !!process.env.KMS_KEY_ID
  const hasVault = !!process.env.VAULT_ADDR
  const hasKey = !!PRIVATE_KEY

  if (!hasKms && !hasVault && !hasKey) {
    console.error("FATAL: No signing method configured.")
    console.error("   Set KMS_KEY_ID (recommended), VAULT_ADDR, or EXECUTOR_PRIVATE_KEY")
    process.exit(1)
  }

  if (hasKey && !hasKms && !hasVault) {
    if (CHAIN_ID === 1) {
      // [EX-01] Hard-fail on mainnet with plaintext key -- too dangerous
      console.error("FATAL: plaintext EXECUTOR_PRIVATE_KEY is not allowed on mainnet (CHAIN_ID=1).")
      console.error("   Configure KMS_KEY_ID (AWS KMS) or VAULT_ADDR (HashiCorp Vault) instead.")
      console.error("   If you intentionally want to run with a plaintext key, set ALLOW_PLAINTEXT_KEY_MAINNET=true")
      if (!process.env.ALLOW_PLAINTEXT_KEY_MAINNET) process.exit(1)
    } else {
      console.warn("WARNING: Using plaintext EXECUTOR_PRIVATE_KEY -- migrate to KMS/Vault before mainnet!")
    }
  }
}

// ---- ABI (JSON format for viem) ----------------------------------------

const ORDER_EXECUTOR_ABI = [
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "orderType", type: "uint8" },
          { name: "condition", type: "uint8" },
          { name: "targetPrice", type: "uint256" },
          { name: "priceFeed", type: "address" },
          { name: "expiry", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "router", type: "address" },
          { name: "routerDataHash", type: "bytes32" },
          { name: "dcaInterval", type: "uint256" },
          { name: "dcaTotal", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "canExec", type: "bool" },
      { name: "reason", type: "string" },
    ],
  },
  {
    name: "executeOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "orderType", type: "uint8" },
          { name: "condition", type: "uint8" },
          { name: "targetPrice", type: "uint256" },
          { name: "priceFeed", type: "address" },
          { name: "expiry", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "router", type: "address" },
          { name: "routerDataHash", type: "bytes32" },
          { name: "dcaInterval", type: "uint256" },
          { name: "dcaTotal", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
      { name: "routerData", type: "bytes" },
    ],
    outputs: [],
  },
]

// Chainlink price feed ABI (for debug logging)
const PRICE_FEED_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
]

// ---- Types -------------------------------------------------------------

function orderTypeToEnum(type) {
  switch (type) {
    case "limit": return 0
    case "stop_loss": return 1
    case "dca": return 2
    default: return 0
  }
}

// ---- Supabase helpers --------------------------------------------------

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })
  return res
}

async function fetchActiveOrders() {
  const query = `orders?status=eq.active&select=*&order=created_at.asc&limit=${MAX_BATCH * 3}`
  log(`  Querying: ${SUPABASE_URL}/rest/v1/${query.slice(0, 80)}...`)
  const res = await supabaseFetch(query)
  if (!res.ok) {
    const body = await res.text()
    console.error(`  Supabase fetch error: ${res.status} -- ${body}`)
    return []
  }
  const data = await res.json()
  log(`  Supabase returned ${data.length} row(s)`)
  if (data.length > 0) {
    log(`  First order: id=${data[0].id?.slice(0,8)}, status=${data[0].status}, wallet=${data[0].wallet?.slice(0,10)}...`)
  }
  return data
}

async function lockOrder(orderId) {
  const res = await supabaseFetch(
    `orders?id=eq.${orderId}&status=eq.active`,
    {
      method: "PATCH",
      headers: { Prefer: "return=headers-only" },
      body: JSON.stringify({
        status: "executing",
        updated_at: new Date().toISOString(),
      }),
    }
  )
  const contentRange = res.headers.get("content-range")
  if (contentRange && contentRange.includes("/0")) return false
  return res.ok
}

async function updateOrderStatus(orderId, status) {
  await supabaseFetch(`orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  })
}

async function unlockStaleOrders() {
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString()
  await supabaseFetch(
    `orders?status=eq.executing&updated_at=lt.${cutoff}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "active",
        updated_at: new Date().toISOString(),
      }),
    }
  )
}

async function recordExecution(orderId, txHash, amountIn, amountOut, gasUsed) {
  await supabaseFetch("order_executions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      order_id: orderId,
      tx_hash: txHash,
      amount_in: amountIn,
      amount_out: amountOut || "0",
      gas_used: gasUsed || "0",
      executed_at: new Date().toISOString(),
    }),
  })
}

// ---- Swap route fetcher ------------------------------------------------

async function fetchSwapRoute(tokenIn, tokenOut, amount, from, router) {
  if (!API_URL) {
    log("  TERASWAP_API_URL not configured -- skipping swap route")
    return null
  }

  try {
    const res = await fetch(`${API_URL}/api/swap`, {
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
      console.error(`  Swap API error: ${res.status}`)
      return null
    }

    const data = await res.json()
    if (!data.tx?.data) {
      console.error("  Swap route: missing tx data")
      return null
    }

    return { data: data.tx.data }
  } catch (err) {
    console.error("  fetchSwapRoute error:", err.message)
    return null
  }
}

// ---- Logging -----------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

// ── Gas Strategy: urgency classification + tier resolution ──────────

/**
 * Classify order urgency for gas tier filtering.
 * @param {object} dbOrder - Order from Supabase
 * @param {object} orderStruct - Parsed on-chain order struct
 * @returns {"URGENT" | "ELEVATED" | "NORMAL"}
 */
function classifyOrderUrgency(dbOrder, orderStruct) {
  const nowSec = Math.floor(Date.now() / 1000)

  // Stop-losses are always urgent (capital protection)
  // orderType 1 = STOP_LOSS, condition 1 = BELOW (price dropping)
  if (Number(orderStruct.orderType) === 1 && Number(orderStruct.condition) === 1) {
    return "URGENT"
  }

  // Orders expiring within EXPIRY_URGENCY_SECONDS are urgent
  const expiryTs = Number(orderStruct.expiry)
  if (expiryTs > 0 && expiryTs - nowSec < EXPIRY_URGENCY_SECONDS) {
    return "URGENT"
  }

  // DCA orders that missed at least one full interval are elevated
  if (dbOrder.order_type === "dca" && dbOrder.dca_last_exec) {
    const lastExec = Math.floor(new Date(dbOrder.dca_last_exec).getTime() / 1000)
    const interval = Number(orderStruct.dcaInterval)
    if (interval > 0 && nowSec - lastExec > interval * 2) {
      return "ELEVATED"
    }
  }

  // Stop-Loss with ABOVE condition (functionally a take-profit) — opportunity, not emergency
  if (Number(orderStruct.orderType) === 1 && Number(orderStruct.condition) === 0) {
    return "ELEVATED"
  }

  return "NORMAL"
}

/**
 * Determine if an order should execute at the current gas price,
 * and return EIP-1559 parameters if so.
 * @param {bigint} currentGasPrice
 * @param {bigint} baseFee
 * @param {"URGENT" | "ELEVATED" | "NORMAL"} urgency
 * @returns {{ execute: boolean, tier: string, maxFeePerGas?: bigint, maxPriorityFeePerGas?: bigint }}
 */
function resolveGasTier(currentGasPrice, baseFee, urgency) {
  const gasPriceGwei = Number(formatUnits(currentGasPrice, 9))

  if (gasPriceGwei > GAS_TIER_URGENT) {
    return { execute: false, tier: "SKIP" }
  }

  if (gasPriceGwei > GAS_TIER_ELEVATED) {
    if (urgency !== "URGENT") return { execute: false, tier: "URGENT_ONLY" }
    const priority = parseGwei(String(PRIORITY_FEE_URGENT))
    return {
      execute: true, tier: "URGENT_ONLY",
      maxPriorityFeePerGas: priority,
      maxFeePerGas: baseFee * BigInt(Math.ceil(BASEFEE_MULT_URGENT)) / 1n + priority,
    }
  }

  if (gasPriceGwei > GAS_TIER_NORMAL) {
    if (urgency === "NORMAL") return { execute: false, tier: "ELEVATED" }
    const priority = parseGwei(String(PRIORITY_FEE_ELEVATED))
    return {
      execute: true, tier: "ELEVATED",
      maxPriorityFeePerGas: priority,
      maxFeePerGas: baseFee * BigInt(Math.ceil(BASEFEE_MULT_ELEVATED)) / 1n + priority,
    }
  }

  const priority = parseGwei(String(PRIORITY_FEE_NORMAL))
  return {
    execute: true, tier: "NORMAL",
    maxPriorityFeePerGas: priority,
    maxFeePerGas: baseFee * BigInt(Math.ceil(BASEFEE_MULT_NORMAL)) / 1n + priority,
  }
}

// ---- Main execution loop -----------------------------------------------

async function executeCycle(publicClient, walletClient, contract, flashbotsPublicClient, flashbotsWalletClient, monitor = null) {
  log("Starting execution cycle...")
  if (monitor) monitor.onCycleStart()

  // 0. Unlock stale orders
  await unlockStaleOrders()

  // 1. Fetch active orders
  const orders = await fetchActiveOrders()

  if (orders.length === 0) {
    log("  No active orders")
    return
  }

  log(`  Found ${orders.length} active order(s)`)

  let executed = 0
  let skipped = 0
  let errors = 0

  for (const dbOrder of orders) {
    if (executed >= MAX_BATCH) break

    try {
      // Check if expired (off-chain pre-filter)
      const expiryTs = Number(dbOrder.expiry)
      if (expiryTs < Math.floor(Date.now() / 1000)) {
        await updateOrderStatus(dbOrder.id, "expired")
        log(`  Order ${dbOrder.id.slice(0, 8)}... expired (expiry: ${dbOrder.expiry})`)
        continue
      }

      // [Audit] Check retry backoff -- skip if too soon
      const retryState = orderRetries.get(dbOrder.id)
      if (retryState) {
        const backoff = RETRY_BACKOFF_BASE * Math.pow(2, retryState.count - 1)
        if (Date.now() - retryState.lastAttempt < backoff) {
          continue // Still in backoff window
        }
      }

      // Atomic lock
      const locked = await lockOrder(dbOrder.id)
      if (!locked) {
        log(`  Order ${dbOrder.id.slice(0, 8)}... already locked`)
        skipped++
        continue
      }

      // Build order struct from order_data JSON (has all fields with correct types)
      const od = dbOrder.order_data
      if (!od) {
        log(`  Order ${dbOrder.id.slice(0, 8)}... missing order_data, skipping`)
        await updateOrderStatus(dbOrder.id, "active")
        skipped++
        continue
      }

      // Use order_data directly -- it has the exact values that were EIP-712 signed
      const orderStruct = {
        owner: getAddress(od.owner),                         // checksum address
        tokenIn: getAddress(od.tokenIn),
        tokenOut: getAddress(od.tokenOut),
        amountIn: BigInt(od.amountIn),                       // uint256
        minAmountOut: BigInt(od.minAmountOut),
        orderType: Number(od.orderType),                     // uint8
        condition: Number(od.condition),                     // uint8
        targetPrice: BigInt(od.targetPrice),                 // uint256
        priceFeed: getAddress(od.priceFeed),
        expiry: BigInt(od.expiry),                           // uint256
        nonce: BigInt(od.nonce),                             // uint256
        router: getAddress(od.router),
        routerDataHash: od.routerDataHash || zeroHash,       // [C-01] keccak256 of routerData
        dcaInterval: BigInt(od.dcaInterval),                 // uint256
        dcaTotal: BigInt(od.dcaTotal),                       // uint256
      }

      log(`  Order struct: owner=${orderStruct.owner?.slice(0,10)}, type=${orderStruct.orderType}, cond=${orderStruct.condition}, target=${orderStruct.targetPrice}, expiry=${orderStruct.expiry}, nonce=${orderStruct.nonce}`)

      // Debug: read current Chainlink price
      try {
        const [, answer] = await publicClient.readContract({
          address: orderStruct.priceFeed,
          abi: PRICE_FEED_ABI,
          functionName: "latestRoundData",
        })
        log(`  Chainlink price from ${orderStruct.priceFeed.slice(0,10)}...: ${answer.toString()} (=$${Number(answer) / 1e8})`)
        log(`  Target: ${orderStruct.targetPrice.toString()} (=$${Number(orderStruct.targetPrice) / 1e8}), Condition: ${orderStruct.condition === 0 ? 'ABOVE' : 'BELOW'}`)
      } catch (e) {
        log(`  Could not read Chainlink price: ${e.message?.slice(0, 80)}`)
      }

      // Check via contract
      const [canExec, reason] = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: ORDER_EXECUTOR_ABI,
        functionName: "canExecute",
        args: [orderStruct, dbOrder.signature],
      })

      if (!canExec) {
        log(`  Order ${dbOrder.id.slice(0, 8)}... -- ${reason}`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock
        skipped++
        continue
      }

      // Fetch swap route
      const swapData = await fetchSwapRoute(
        dbOrder.token_in,
        dbOrder.token_out,
        dbOrder.amount_in,
        CONTRACT_ADDRESS,
        dbOrder.router
      )

      if (!swapData) {
        log(`  Order ${dbOrder.id.slice(0, 8)}... -- no swap route, will retry`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock
        skipped++
        continue
      }

      // [C-01] Verify routerData hash for non-DCA orders.
      // DCA orders use ZeroHash as routerDataHash since calldata varies per execution --
      // the contract now skips the hash check when routerDataHash == bytes32(0).
      // IMPORTANT: Do NOT modify orderStruct.routerDataHash -- it must match the
      // original signed value or EIP-712 signature verification will fail.
      if (orderStruct.routerDataHash !== zeroHash) {
        const actualRouterDataHash = keccak256(swapData.data)
        if (actualRouterDataHash !== orderStruct.routerDataHash) {
          log(`  Order ${dbOrder.id.slice(0, 8)}... routerData hash mismatch, skipping`)
          await updateOrderStatus(dbOrder.id, "active") // Unlock
          skipped++
          continue
        }
      }

      // ── Gas Strategy: tier-based execution ──
      const [gasPrice, latestBlock] = await Promise.all([
        publicClient.getGasPrice(),
        publicClient.getBlock({ blockTag: "latest" }),
      ])
      const baseFee = latestBlock.baseFeePerGas || 0n

      if (monitor) monitor.onGasObserved(gasPrice)

      const urgency = classifyOrderUrgency(dbOrder, orderStruct)
      const gasTier = resolveGasTier(gasPrice, baseFee, urgency)

      log(`  Gas: ${formatUnits(gasPrice, 9)} gwei | baseFee: ${formatUnits(baseFee, 9)} gwei | urgency: ${urgency} | tier: ${gasTier.tier}`)

      if (!gasTier.execute) {
        log(`  Order ${dbOrder.id.slice(0, 8)}... skipped by gas tier (${gasTier.tier}, urgency: ${urgency})`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock
        if (monitor) monitor.onGasSkip(gasTier.tier)
        if (gasTier.tier === "SKIP") break  // Above max — skip remaining orders too
        continue  // ELEVATED/URGENT_ONLY — skip this order, try next
      }

      // Send transaction!
      log(`  Executing order ${dbOrder.id.slice(0, 8)}... (${dbOrder.order_type}, tier: ${gasTier.tier})`)

      // [B-02] Use Flashbots Protect RPC if configured (prevents MEV/sandwich attacks)
      const txWalletClient = FLASHBOTS_RPC ? flashbotsWalletClient : walletClient
      const txPublicClient = FLASHBOTS_RPC ? flashbotsPublicClient : publicClient

      const txHash = await txWalletClient.writeContract({
        address: CONTRACT_ADDRESS,
        abi: ORDER_EXECUTOR_ABI,
        functionName: "executeOrder",
        args: [orderStruct, dbOrder.signature, swapData.data],
        maxFeePerGas: gasTier.maxFeePerGas,
        maxPriorityFeePerGas: gasTier.maxPriorityFeePerGas,
      })

      log(`  TX sent: ${txHash}`)

      // Wait for confirmation
      const receipt = await txPublicClient.waitForTransactionReceipt({ hash: txHash })

      if (receipt.status === "success") {
        log(`  Order ${dbOrder.id.slice(0, 8)}... executed! Gas: ${receipt.gasUsed.toString()}`)

        // [EX-MON] Track gas spent
        if (monitor && receipt.gasUsed) {
          const effectiveGasPrice = receipt.effectiveGasPrice || 0n
          monitor.onGasSpent(receipt.gasUsed * effectiveGasPrice)
        }

        // Update status based on order type
        if (dbOrder.order_type === "dca") {
          const newExecCount = (dbOrder.dca_executed || 0) + 1
          const now = new Date().toISOString()
          if (newExecCount >= dbOrder.dca_total) {
            // All DCA executions complete
            await supabaseFetch(`orders?id=eq.${dbOrder.id}`, {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                status: "executed",
                dca_executed: newExecCount,
                dca_last_exec: now,
                executed_at: now,
                tx_hash: txHash,
                updated_at: now,
              }),
            })
          } else {
            // DCA: back to active for next interval
            await supabaseFetch(`orders?id=eq.${dbOrder.id}`, {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                status: "active",
                dca_executed: newExecCount,
                dca_last_exec: now,
                tx_hash: txHash,
                updated_at: now,
              }),
            })
          }
        } else {
          // Limit / Stop-Loss: single execution
          await supabaseFetch(`orders?id=eq.${dbOrder.id}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              status: "executed",
              executed_at: new Date().toISOString(),
              tx_hash: txHash,
              updated_at: new Date().toISOString(),
            }),
          })
        }

        // Record execution
        await recordExecution(
          dbOrder.id,
          txHash,
          dbOrder.amount_in,
          null, // amountOut from events (could parse logs)
          receipt.gasUsed.toString()
        )

        executed++
      } else {
        log(`  TX reverted: ${txHash}`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock for retry
      }
    } catch (err) {
      console.error(`  Order ${dbOrder.id.slice(0, 8)}... error:`, err.message)
      errors++
      stats.totalErrors++
      stats.lastError = { orderId: dbOrder.id, message: err.message, at: new Date().toISOString() }

      // [Audit] Retry tracking with exponential backoff
      const retryState = orderRetries.get(dbOrder.id) || { count: 0, lastAttempt: 0 }
      retryState.count++
      retryState.lastAttempt = Date.now()
      orderRetries.set(dbOrder.id, retryState)

      if (retryState.count >= MAX_RETRIES) {
        log(`  Order ${dbOrder.id.slice(0, 8)}... max retries (${MAX_RETRIES}) reached, marking failed`)
        await updateOrderStatus(dbOrder.id, "failed")
        orderRetries.delete(dbOrder.id)
      } else {
        const backoff = RETRY_BACKOFF_BASE * Math.pow(2, retryState.count - 1)
        log(`  Order ${dbOrder.id.slice(0, 8)}... retry ${retryState.count}/${MAX_RETRIES}, backoff ${backoff / 1000}s`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock for retry
      }
    }
  }

  // Update stats
  stats.totalCycles++
  stats.totalExecuted += executed
  stats.totalSkipped += skipped
  stats.lastCycleAt = new Date().toISOString()
  if (executed > 0) stats.lastExecutionAt = new Date().toISOString()

  if (monitor) monitor.onCycleEnd(executed, errors)

  log(`  Cycle done: ${executed} executed, ${skipped} skipped`)
}

// ---- Stats tracking ----------------------------------------------------

const stats = {
  startedAt: new Date().toISOString(),
  totalCycles: 0,
  totalExecuted: 0,
  totalSkipped: 0,
  totalErrors: 0,
  lastCycleAt: null,
  lastExecutionAt: null,
  lastError: null,
}

// ---- Health check HTTP server ------------------------------------------

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3001")

function startHealthServer() {
  // [Audit] Health endpoint access token (optional, set in .env.executor)
  const HEALTH_TOKEN = process.env.HEALTH_TOKEN || ""

  const server = createServer(async (req, res) => {
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      // [Audit B-05] Require auth token if configured
      if (HEALTH_TOKEN) {
        const url = new URL(req.url, `http://localhost:${HEALTH_PORT}`)
        const token = url.searchParams.get("token") || req.headers["x-health-token"]
        if (token !== HEALTH_TOKEN) {
          res.writeHead(401, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Unauthorized" }))
          return
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      // [Audit B-05] Sanitized response -- no executor address or sensitive data
      res.end(JSON.stringify({
        status: "ok",
        chainId: CHAIN_ID,
        uptime: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
        stats: {
          totalCycles: stats.totalCycles,
          totalExecuted: stats.totalExecuted,
          totalSkipped: stats.totalSkipped,
          totalErrors: stats.totalErrors,
          lastCycleAt: stats.lastCycleAt,
        },
      }, null, 2))
    } else if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("TeraSwap Executor running")
    } else {
      res.writeHead(404)
      res.end("Not found")
    }
  })

  server.listen(HEALTH_PORT, () => {
    log(`Health check: http://localhost:${HEALTH_PORT}/health`)
  })

  server.on("error", (err) => {
    // Port in use -- health check is optional, don't crash
    if (err.code === "EADDRINUSE") {
      log(`Health check port ${HEALTH_PORT} in use -- skipping`)
    }
  })
}

// ---- Entrypoint --------------------------------------------------------

async function main() {
  validateConfig()

  // Validate gas tier ordering
  if (GAS_TIER_NORMAL >= GAS_TIER_ELEVATED || GAS_TIER_ELEVATED >= GAS_TIER_URGENT) {
    throw new Error(
      `Invalid gas tier ordering: NORMAL(${GAS_TIER_NORMAL}) < ELEVATED(${GAS_TIER_ELEVATED}) < URGENT(${GAS_TIER_URGENT}) required`
    )
  }

  console.log("")
  console.log("+===========================================+")
  console.log("|   TeraSwap Order Executor v1.1 (viem)     |")
  console.log("|   Self-hosted keeper (replaces Gelato)     |")
  console.log("+===========================================+")
  console.log("")

  // Create public client for reading chain state
  const publicClient = createPublicClient({
    chain,
    transport: http(RPC_URL),
  })

  // [C-02/B-01] Use KMS/Vault account if configured, otherwise plaintext key
  const account = await createExecutorAccount()

  // Create wallet client for sending transactions
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(RPC_URL),
  })

  // [B-02] Flashbots clients for MEV-protected transaction submission
  let flashbotsPublicClient = null
  let flashbotsWalletClient = null
  if (FLASHBOTS_RPC) {
    flashbotsPublicClient = createPublicClient({
      chain,
      transport: http(FLASHBOTS_RPC),
    })
    flashbotsWalletClient = createWalletClient({
      account,
      chain,
      transport: http(FLASHBOTS_RPC),
    })
    log(`Flashbots Protect RPC enabled: ${FLASHBOTS_RPC.slice(0, 40)}...`)
  }

  const balance = await publicClient.getBalance({ address: account.address })

  log(`Executor wallet: ${account.address}`)
  log(`Chain: ${CHAIN_ID}`)
  log(`Balance: ${formatEther(balance)} ETH`)
  log(`Contract: ${CONTRACT_ADDRESS}`)
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`)
  log(`Max batch: ${MAX_BATCH}`)
  log(`Gas tiers: NORMAL ≤${GAS_TIER_NORMAL}gwei | ELEVATED ≤${GAS_TIER_ELEVATED}gwei | URGENT ≤${GAS_TIER_URGENT}gwei | >URGENT → SKIP`)
  log(`Priority fees: NORMAL ${PRIORITY_FEE_NORMAL}gwei | ELEVATED ${PRIORITY_FEE_ELEVATED}gwei | URGENT ${PRIORITY_FEE_URGENT}gwei`)
  console.log("")

  if (balance === 0n) {
    console.warn("WARNING: Executor wallet has 0 ETH -- transactions will fail!")
    console.warn("   Fund the wallet before starting execution.\n")
  }

  // Start health check server
  startHealthServer()

  // [EX-MON] Start monitoring & alerting
  const monitor = new ExecutorMonitor(stats)
  monitor.startMetricsServer()
  monitor.startHeartbeat()

  // [EX-WATCH] Start on-chain admin event watcher (L-02: monitor FeeCollector too)
  const watchedContracts = [
    { address: CONTRACT_ADDRESS, label: 'OrderExecutor' },
  ]
  if (FEE_COLLECTOR_ADDRESS) {
    watchedContracts.push({ address: FEE_COLLECTOR_ADDRESS, label: 'FeeCollector' })
  }
  startEventWatcher(publicClient, watchedContracts, monitor)

  // Run immediately, then on interval
  await executeCycle(publicClient, walletClient, null, flashbotsPublicClient, flashbotsWalletClient, monitor)

  setInterval(async () => {
    try {
      await executeCycle(publicClient, walletClient, null, flashbotsPublicClient, flashbotsWalletClient, monitor)
    } catch (err) {
      console.error("Cycle error:", err.message)
      if (monitor) monitor.onCycleError(err)
    }
  }, POLL_INTERVAL_MS)

  log("Executor running. Press Ctrl+C to stop.")
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down executor...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  log("Shutting down executor...")
  process.exit(0)
})

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
