/**
 * TeraSwap Order Executor — Self-hosted keeper
 *
 * Replaces Gelato Web3 Functions with a standalone Node.js process.
 * Runs every POLL_INTERVAL_MS, checks Supabase for active orders,
 * verifies on-chain conditions via canExecute(), fetches swap routes,
 * and sends executeOrder() transactions directly.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  Self-hosted Executor (runs every 30s)                       │
 * │                                                              │
 * │  1. Unlock stale "executing" orders (>60s stuck)             │
 * │  2. Fetch active orders from Supabase (oldest first)         │
 * │  3. For each order (up to MAX_BATCH):                        │
 * │     a. Atomic lock: set status → "executing"                 │
 * │     b. Call contract.canExecute() on-chain                   │
 * │     c. Fetch swap route from TeraSwap API                    │
 * │     d. Send executeOrder() transaction                       │
 * │     e. Record execution in order_executions table            │
 * │     f. Update order status                                   │
 * │  4. Log results, wait, repeat                                │
 * └──────────────────────────────────────────────────────────────┘
 *
 * DEPLOYMENT:
 *   1. Copy .env.executor.example → .env.executor
 *   2. Fill in secrets
 *   3. npm install
 *   4. npm start  (or use pm2 / systemd for production)
 *
 * REQUIRED ENV VARS:
 *   RPC_URL                     — Ethereum RPC endpoint
 *   EXECUTOR_PRIVATE_KEY        — Private key for the executor wallet (pays gas)
 *   SUPABASE_URL                — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY   — Supabase service role key (server-side)
 *   ORDER_EXECUTOR_ADDRESS      — Deployed contract address
 *   TERASWAP_API_URL            — (optional) Base URL for swap route API
 *   CHAIN_ID                    — (optional) Chain ID, defaults to 11155111 (Sepolia)
 */

import { ethers } from "ethers"
import { readFileSync } from "fs"
import { join } from "path"
import { createServer } from "http"
import { createExecutorSigner } from "./kms-signer.js"  // [C-02/B-01] HSM/KMS support

// ── Load .env.executor manually (no dotenv dependency) ──────────

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
    console.warn(`⚠ Could not load ${filePath}: ${err.message}`)
  }
}

// Use process.cwd() — works with spaces in path
loadEnv(join(process.cwd(), ".env.executor"))

// ── Configuration ───────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL
const PRIVATE_KEY = process.env.EXECUTOR_PRIVATE_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CONTRACT_ADDRESS = process.env.ORDER_EXECUTOR_ADDRESS
const API_URL = process.env.TERASWAP_API_URL || ""
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "1") // Default to mainnet

// [B-02] Flashbots Protect RPC — prevents MEV/sandwich attacks on executor txs
const FLASHBOTS_RPC = process.env.FLASHBOTS_RPC_URL || ""

const POLL_INTERVAL_MS = 30_000 // 30 seconds
const MAX_BATCH = 5             // Max orders per cycle
const LOCK_TIMEOUT_MS = 60_000  // 60s — unlock stale orders
const MAX_GAS_PRICE_GWEI = 100  // Safety cap on gas price
const MAX_RETRIES = 3           // [Audit] Max retries per order before marking failed
const RETRY_BACKOFF_BASE = 5_000 // [Audit] Base backoff 5s (exponential: 5s, 10s, 20s)

// [Audit] Per-order retry tracking
const orderRetries = new Map()   // orderId → { count, lastAttempt }

// ── Validate config ─────────────────────────────────────────────

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
    console.error(`❌ Missing required env vars: ${missing.join(", ")}`)
    console.error("   Copy .env.executor.example → .env.executor and fill in values")
    process.exit(1)
  }

  // [C-02/B-01] Validate that at least one signing method is configured
  const hasKms = !!process.env.KMS_KEY_ID
  const hasVault = !!process.env.VAULT_ADDR
  const hasKey = !!PRIVATE_KEY

  if (!hasKms && !hasVault && !hasKey) {
    console.error("❌ No signing method configured.")
    console.error("   Set KMS_KEY_ID (recommended), VAULT_ADDR, or EXECUTOR_PRIVATE_KEY")
    process.exit(1)
  }

  if (hasKey && !hasKms && !hasVault) {
    if (CHAIN_ID === 1) {
      // [EX-01] Hard-fail on mainnet with plaintext key — too dangerous
      console.error("❌ FATAL: plaintext EXECUTOR_PRIVATE_KEY is not allowed on mainnet (CHAIN_ID=1).")
      console.error("   Configure KMS_KEY_ID (AWS KMS) or VAULT_ADDR (HashiCorp Vault) instead.")
      console.error("   If you intentionally want to run with a plaintext key, set ALLOW_PLAINTEXT_KEY_MAINNET=true")
      if (!process.env.ALLOW_PLAINTEXT_KEY_MAINNET) process.exit(1)
    } else {
      console.warn("⚠  Using plaintext EXECUTOR_PRIVATE_KEY — migrate to KMS/Vault before mainnet!")
    }
  }
}

// ── ABI fragments ───────────────────────────────────────────────

const ORDER_EXECUTOR_ABI = [
  // [C-01] v3: includes routerDataHash in Order struct
  "function canExecute(tuple(address owner, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint8 orderType, uint8 condition, uint256 targetPrice, address priceFeed, uint256 expiry, uint256 nonce, address router, bytes32 routerDataHash, uint256 dcaInterval, uint256 dcaTotal) order, bytes signature) view returns (bool canExec, string reason)",
  "function executeOrder(tuple(address owner, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint8 orderType, uint8 condition, uint256 targetPrice, address priceFeed, uint256 expiry, uint256 nonce, address router, bytes32 routerDataHash, uint256 dcaInterval, uint256 dcaTotal) order, bytes signature, bytes routerData)",
]

// ── Types ────────────────────────────────────────────────────────

function orderTypeToEnum(type) {
  switch (type) {
    case "limit": return 0
    case "stop_loss": return 1
    case "dca": return 2
    default: return 0
  }
}

// ── Supabase helpers ─────────────────────────────────────────────

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
  log(`  🔍 Querying: ${SUPABASE_URL}/rest/v1/${query.slice(0, 80)}…`)
  const res = await supabaseFetch(query)
  if (!res.ok) {
    const body = await res.text()
    console.error(`  ⚠ Supabase fetch error: ${res.status} — ${body}`)
    return []
  }
  const data = await res.json()
  log(`  📦 Supabase returned ${data.length} row(s)`)
  if (data.length > 0) {
    log(`  📋 First order: id=${data[0].id?.slice(0,8)}, status=${data[0].status}, wallet=${data[0].wallet?.slice(0,10)}…`)
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

// ── Swap route fetcher ──────────────────────────────────────────

async function fetchSwapRoute(tokenIn, tokenOut, amount, from, router) {
  if (!API_URL) {
    log("  ⚠ TERASWAP_API_URL not configured — skipping swap route")
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
      console.error(`  ⚠ Swap API error: ${res.status}`)
      return null
    }

    const data = await res.json()
    if (!data.tx?.data) {
      console.error("  ⚠ Swap route: missing tx data")
      return null
    }

    return { data: data.tx.data }
  } catch (err) {
    console.error("  ⚠ fetchSwapRoute error:", err.message)
    return null
  }
}

// ── Logging ─────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

// ── Main execution loop ─────────────────────────────────────────

async function executeCycle(wallet, contract) {
  log("🔄 Starting execution cycle...")

  // 0. Unlock stale orders
  await unlockStaleOrders()

  // 1. Fetch active orders
  const orders = await fetchActiveOrders()

  if (orders.length === 0) {
    log("  💤 No active orders")
    return
  }

  log(`  📋 Found ${orders.length} active order(s)`)

  let executed = 0
  let skipped = 0

  for (const dbOrder of orders) {
    if (executed >= MAX_BATCH) break

    try {
      // Check if expired (off-chain pre-filter)
      // expiry is stored as ISO string in Supabase
      const expiryTs = Number(dbOrder.expiry)
      if (expiryTs < Math.floor(Date.now() / 1000)) {
        await updateOrderStatus(dbOrder.id, "expired")
        log(`  ⏰ Order ${dbOrder.id.slice(0, 8)}… expired (expiry: ${dbOrder.expiry})`)
        continue
      }

      // [Audit] Check retry backoff — skip if too soon
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
        log(`  🔒 Order ${dbOrder.id.slice(0, 8)}… already locked`)
        skipped++
        continue
      }

      // Build order struct from order_data JSON (has all fields with correct types)
      const od = dbOrder.order_data
      if (!od) {
        log(`  ⚠ Order ${dbOrder.id.slice(0, 8)}… missing order_data, skipping`)
        await updateOrderStatus(dbOrder.id, "active")
        skipped++
        continue
      }

      // Use order_data directly — it has the exact values that were EIP-712 signed
      const orderStruct = {
        owner: ethers.getAddress(od.owner),                  // checksum address
        tokenIn: ethers.getAddress(od.tokenIn),
        tokenOut: ethers.getAddress(od.tokenOut),
        amountIn: BigInt(od.amountIn),                       // uint256
        minAmountOut: BigInt(od.minAmountOut),
        orderType: Number(od.orderType),                     // uint8
        condition: Number(od.condition),                     // uint8
        targetPrice: BigInt(od.targetPrice),                 // uint256
        priceFeed: ethers.getAddress(od.priceFeed),
        expiry: BigInt(od.expiry),                           // uint256
        nonce: BigInt(od.nonce),                             // uint256
        router: ethers.getAddress(od.router),
        routerDataHash: od.routerDataHash || ethers.ZeroHash, // [C-01] keccak256 of routerData
        dcaInterval: BigInt(od.dcaInterval),                 // uint256
        dcaTotal: BigInt(od.dcaTotal),                       // uint256
      }

      log(`  📦 Order struct: owner=${orderStruct.owner?.slice(0,10)}, type=${orderStruct.orderType}, cond=${orderStruct.condition}, target=${orderStruct.targetPrice}, expiry=${orderStruct.expiry}, nonce=${orderStruct.nonce}`)

      // Debug: read current Chainlink price
      try {
        const feedAbi = ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]
        const feedContract = new ethers.Contract(orderStruct.priceFeed, feedAbi, wallet)
        const [, answer] = await feedContract.latestRoundData()
        log(`  💰 Chainlink price from ${orderStruct.priceFeed.slice(0,10)}…: ${answer.toString()} (=$${Number(answer) / 1e8})`)
        log(`  🎯 Target: ${orderStruct.targetPrice.toString()} (=$${Number(orderStruct.targetPrice) / 1e8}), Condition: ${orderStruct.condition === 0 ? 'ABOVE' : 'BELOW'}`)
      } catch (e) {
        log(`  ⚠ Could not read Chainlink price: ${e.message?.slice(0, 80)}`)
      }

      // Check via contract
      const [canExec, reason] = await contract.canExecute(
        orderStruct,
        dbOrder.signature
      )

      if (!canExec) {
        log(`  ❌ Order ${dbOrder.id.slice(0, 8)}… — ${reason}`)
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
        log(`  ⚠ Order ${dbOrder.id.slice(0, 8)}… — no swap route, will retry`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock
        skipped++
        continue
      }

      // [C-01] Verify routerData hash for non-DCA orders.
      // DCA orders use ZeroHash as routerDataHash since calldata varies per execution —
      // the contract now skips the hash check when routerDataHash == bytes32(0).
      // IMPORTANT: Do NOT modify orderStruct.routerDataHash — it must match the
      // original signed value or EIP-712 signature verification will fail.
      if (orderStruct.routerDataHash !== ethers.ZeroHash) {
        const actualRouterDataHash = ethers.keccak256(swapData.data)
        if (actualRouterDataHash !== orderStruct.routerDataHash) {
          log(`  ⚠ Order ${dbOrder.id.slice(0, 8)}… routerData hash mismatch, skipping`)
          await updateOrderStatus(dbOrder.id, "active") // Unlock
          skipped++
          continue
        }
      }

      // Gas price safety check
      const feeData = await wallet.provider.getFeeData()
      const gasPrice = feeData.gasPrice || 0n
      const maxGas = ethers.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei")

      if (gasPrice > maxGas) {
        log(`  ⛽ Gas too high (${ethers.formatUnits(gasPrice, "gwei")} gwei), skipping cycle`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock
        break // Skip all remaining orders this cycle
      }

      // Send transaction!
      log(`  🚀 Executing order ${dbOrder.id.slice(0, 8)}… (${dbOrder.order_type})`)

      // [B-02] Use Flashbots Protect RPC if configured (prevents MEV/sandwich attacks)
      const txSigner = FLASHBOTS_RPC ? flashbotsWallet : wallet
      const txContract = FLASHBOTS_RPC
        ? new ethers.Contract(CONTRACT_ADDRESS, ORDER_EXECUTOR_ABI, flashbotsWallet)
        : contract

      const tx = await txContract.executeOrder(
        orderStruct,
        dbOrder.signature,
        swapData.data
      )

      log(`  📤 TX sent: ${tx.hash}`)

      // Wait for confirmation
      const receipt = await tx.wait(1)

      if (receipt.status === 1) {
        log(`  ✅ Order ${dbOrder.id.slice(0, 8)}… executed! Gas: ${receipt.gasUsed.toString()}`)

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
                tx_hash: tx.hash,
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
                tx_hash: tx.hash,
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
              tx_hash: tx.hash,
              updated_at: new Date().toISOString(),
            }),
          })
        }

        // Record execution
        await recordExecution(
          dbOrder.id,
          tx.hash,
          dbOrder.amount_in,
          null, // amountOut from events (could parse logs)
          receipt.gasUsed.toString()
        )

        executed++
      } else {
        log(`  ❌ TX reverted: ${tx.hash}`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock for retry
      }
    } catch (err) {
      console.error(`  💥 Order ${dbOrder.id.slice(0, 8)}… error:`, err.message)
      stats.totalErrors++
      stats.lastError = { orderId: dbOrder.id, message: err.message, at: new Date().toISOString() }

      // [Audit] Retry tracking with exponential backoff
      const retryState = orderRetries.get(dbOrder.id) || { count: 0, lastAttempt: 0 }
      retryState.count++
      retryState.lastAttempt = Date.now()
      orderRetries.set(dbOrder.id, retryState)

      if (retryState.count >= MAX_RETRIES) {
        log(`  🚫 Order ${dbOrder.id.slice(0, 8)}… max retries (${MAX_RETRIES}) reached, marking failed`)
        await updateOrderStatus(dbOrder.id, "failed")
        orderRetries.delete(dbOrder.id)
      } else {
        const backoff = RETRY_BACKOFF_BASE * Math.pow(2, retryState.count - 1)
        log(`  🔄 Order ${dbOrder.id.slice(0, 8)}… retry ${retryState.count}/${MAX_RETRIES}, backoff ${backoff / 1000}s`)
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

  log(`  📊 Cycle done: ${executed} executed, ${skipped} skipped`)
}

// ── Stats tracking ──────────────────────────────────────────────

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

// ── Health check HTTP server ────────────────────────────────────

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3001")

function startHealthServer(wallet) {
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
      // [Audit B-05] Sanitized response — no executor address or sensitive data
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
    log(`🏥 Health check: http://localhost:${HEALTH_PORT}/health`)
  })

  server.on("error", (err) => {
    // Port in use — health check is optional, don't crash
    if (err.code === "EADDRINUSE") {
      log(`⚠ Health check port ${HEALTH_PORT} in use — skipping`)
    }
  })
}

// ── Entrypoint ──────────────────────────────────────────────────

async function main() {
  validateConfig()

  console.log("")
  console.log("╔══════════════════════════════════════════╗")
  console.log("║   TeraSwap Order Executor v1.0           ║")
  console.log("║   Self-hosted keeper (replaces Gelato)    ║")
  console.log("╚══════════════════════════════════════════╝")
  console.log("")

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID)

  // [C-02/B-01] Use KMS/Vault signer if configured, otherwise plaintext key
  const wallet = await createExecutorSigner(provider)
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ORDER_EXECUTOR_ABI, wallet)

  // [B-02] Flashbots wallet for MEV-protected transaction submission
  let flashbotsWallet = wallet
  if (FLASHBOTS_RPC) {
    const flashbotsProvider = new ethers.JsonRpcProvider(FLASHBOTS_RPC, CHAIN_ID)
    // For KMS signer, connect to Flashbots provider; for Wallet, create new instance
    flashbotsWallet = wallet.connect ? wallet.connect(flashbotsProvider) : new ethers.Wallet(PRIVATE_KEY, flashbotsProvider)
    log(`🛡️  Flashbots Protect RPC enabled: ${FLASHBOTS_RPC.slice(0, 40)}…`)
  }

  const balance = await provider.getBalance(wallet.address)
  const network = await provider.getNetwork()

  log(`🔑 Executor wallet: ${wallet.address}`)
  log(`⛓  Chain: ${network.name} (${network.chainId})`)
  log(`💰 Balance: ${ethers.formatEther(balance)} ETH`)
  log(`📜 Contract: ${CONTRACT_ADDRESS}`)
  log(`⏱  Poll interval: ${POLL_INTERVAL_MS / 1000}s`)
  log(`📦 Max batch: ${MAX_BATCH}`)
  log(`⛽ Max gas: ${MAX_GAS_PRICE_GWEI} gwei`)
  console.log("")

  if (balance === 0n) {
    console.warn("⚠  Executor wallet has 0 ETH — transactions will fail!")
    console.warn("   Fund the wallet before starting execution.\n")
  }

  // Start health check server
  startHealthServer(wallet)

  // Run immediately, then on interval
  await executeCycle(wallet, contract)

  setInterval(async () => {
    try {
      await executeCycle(wallet, contract)
    } catch (err) {
      console.error("💥 Cycle error:", err.message)
    }
  }, POLL_INTERVAL_MS)

  log("🟢 Executor running. Press Ctrl+C to stop.")
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("🛑 Shutting down executor...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  log("🛑 Shutting down executor...")
  process.exit(0)
})

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
