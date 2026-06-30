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
 *   CHAIN_ID                    -- (optional) Chain ID, defaults to 1 (mainnet)
 *
 * FREEZE-OBSERVABILITY (all OPTIONAL, safe defaults; alerts only fire when Telegram is set):
 *   OUTFLOW_THRESHOLD_ETH       -- (optional) unexplained ETH outflow "full alarm" (default 0.01)
 *   ETH_USD_FEED                -- (optional) Chainlink ETH/USD aggregator, 8 dec (default mainnet feed)
 *   LOW_GAS_USD_THRESHOLD       -- (optional) USD gas-value below which a low-gas alert fires (default 5)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID -- (optional) Telegram alert sink (see alert.js)
 *
 * SIGNING (prefer a managed signer over a plaintext key -- required on every production chain):
 *   KMS_KEY_ID                  -- (recommended) AWS KMS key id for signing
 *   VAULT_ADDR                  -- HashiCorp Vault signer address
 *   ALLOW_PLAINTEXT_KEY         -- bypass the production-chain plaintext-key refusal (DANGEROUS)
 *   ALLOW_PLAINTEXT_KEY_MAINNET -- back-compat alias for ALLOW_PLAINTEXT_KEY (either enables the bypass)
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
// [DCA-OBS] Freeze-urgency scoring + Telegram alert builders (pure/fail-safe modules).
import { computeFreezeScore, scoreTier } from "./freeze-score.js"
import { buildSwapRoutePayload, computeNetChunkAmount, sourceForRouter } from "./swap-route.js" // [chore/dca-router-chainaware] router-constrained route for the net chunk
import { decodeSwapFailed, extractRevertData } from "./revert-decode.js" // [chore/dca-swapfailed] unwrap SwapFailed(bytes)
// [CHORE-KEEPER-RECORD-EXECUTIONS] Confirmed-only, idempotent order_executions row
// + parent-order status transition (pure, unit-tested in record-execution.test.mjs).
import {
  decodeOrderExecuted,
  shouldRecord,
  nextOrderStatus,
  buildExecutionRow,
  recordExecutionRow,
} from "./record-execution.js"
import {
  alertNewDcaPosition,
  alertLowGas,
  alertUnexplainedOutflow,
  alertOps,
} from "./alert.js"
// [chore/dca-resilience] Transient-vs-permanent failure classification + retry
// decision + reason-bearing orders patches (pure, unit-tested in
// retry-policy.test.mjs). Replaces the old blunt MAX_RETRIES=3 → 'failed' (no
// reason) that permanently failed a routable DCA on a single transient miss.
import {
  MAX_CYCLE_FAILURES,
  backoffMs,
  planFailureHandling,
} from "./retry-policy.js"

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

// [CHORE-EXECUTOR-KEY-GUARD] Chains where a plaintext EXECUTOR_PRIVATE_KEY is acceptable (dev/testnet
// only -- no real funds). Every OTHER chain (mainnet 1, Base 8453, and any future production chain)
// requires a managed signer (KMS/Vault) unless an explicit override is set.
const TESTNET_CHAIN_IDS = new Set([11155111 /* Sepolia */, 84532 /* Base Sepolia */])

// [B-02] Flashbots Protect RPC -- prevents MEV/sandwich attacks on executor txs
const FLASHBOTS_RPC = process.env.FLASHBOTS_RPC_URL || ""

// [DCA-OBS] Freeze-observability env vars (all OPTIONAL, safe defaults; alerting
// is non-blocking and only fires when Telegram is configured via alert.js).
//   OUTFLOW_THRESHOLD_ETH  -- ETH leaving the executor wallet beyond own gas spend
//                             that counts as a "full alarm" unexplained outflow.
//                             Default 0.01 ETH. Drives the DOMINANT freeze signal.
//   ETH_USD_FEED           -- Chainlink ETH/USD aggregator (8 decimals) used to
//                             value the wallet's ETH for the low-gas signal.
//                             Default = mainnet ETH/USD feed.
//   LOW_GAS_USD_THRESHOLD  -- USD value of the wallet's ETH below which we emit a
//                             low-gas alert. Default 5 (matches freeze-score GAS_LOW_USD).
const OUTFLOW_THRESHOLD_ETH = parseFloat(process.env.OUTFLOW_THRESHOLD_ETH || "0.01")
const ETH_USD_FEED = process.env.ETH_USD_FEED || "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"
const LOW_GAS_USD_THRESHOLD = parseFloat(process.env.LOW_GAS_USD_THRESHOLD || "5")

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

// [chore/dca-resilience] Per-order CONSECUTIVE transient-failure tracking. A miss
// (no route this cycle, route/API hiccup, transient revert, momentary slippage)
// keeps the order ACTIVE and retries a later cycle with backoff (backoffMs); only
// a PERMANENT reason (classifyFailure) or the consecutive-failure CAP
// (MAX_CYCLE_FAILURES, default 8) marks it 'failed' — with the real reason. The
// count resets to 0 on any successful execution. In-memory only (resets on keeper
// restart — see FEEDBACK).
const orderRetries = new Map()   // orderId -> { count, lastAttempt }

// [DCA-OBS] Cross-cycle freeze-observability state (in-memory only; never persisted).
//   seenDcaOrderIds          -- DCA order ids already announced via alertNewDcaPosition.
//   consecutiveExecFailures  -- back-to-back executeOrder failures (drives a freeze signal;
//                               reset to 0 on any successful execution).
//   rpcDown                  -- last cycle could not read chain state (RPC unreachable).
//   freezeAlertedState       -- the frozen flag last alerted on, so we alert ONCE per
//                               state transition (null = never alerted this run).
const seenDcaOrderIds = new Set()
let consecutiveExecFailures = 0
let rpcDown = false
let freezeAlertedState = null

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
    // [EX-01 / CHORE-EXECUTOR-KEY-GUARD] A plaintext EXECUTOR_PRIVATE_KEY controls real funds on any
    // PRODUCTION chain, so it is FATAL on every chain that is NOT an explicit testnet (mainnet 1, Base
    // 8453, and any future prod chain). Prefer KMS_KEY_ID (AWS KMS) / VAULT_ADDR (HashiCorp Vault).
    // Escape hatch: ALLOW_PLAINTEXT_KEY (generic) or ALLOW_PLAINTEXT_KEY_MAINNET (back-compat alias).
    const allowPlaintext = !!process.env.ALLOW_PLAINTEXT_KEY || !!process.env.ALLOW_PLAINTEXT_KEY_MAINNET
    if (TESTNET_CHAIN_IDS.has(CHAIN_ID)) {
      console.warn(`WARNING: Using plaintext EXECUTOR_PRIVATE_KEY on testnet (CHAIN_ID=${CHAIN_ID}) -- migrate to KMS/Vault before any production chain!`)
    } else if (allowPlaintext) {
      console.warn(`WARNING: plaintext EXECUTOR_PRIVATE_KEY accepted on production CHAIN_ID=${CHAIN_ID} via an explicit override (ALLOW_PLAINTEXT_KEY) -- this is DANGEROUS; migrate to KMS/Vault.`)
    } else {
      console.error(`FATAL: plaintext EXECUTOR_PRIVATE_KEY is not allowed on production chain CHAIN_ID=${CHAIN_ID}.`)
      console.error("   Configure KMS_KEY_ID (AWS KMS) or VAULT_ADDR (HashiCorp Vault) instead.")
      console.error("   To intentionally run with a plaintext key, set ALLOW_PLAINTEXT_KEY=true (or ALLOW_PLAINTEXT_KEY_MAINNET).")
      process.exit(1)
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
  // [CHORE-ORDER-API-CHAIN-AWARE] Scope the active-orders query by the keeper's configured chain so a
  // per-chain keeper only processes its OWN chain's rows. Without this filter a mainnet keeper would
  // pick up Base rows (and vice-versa) and execute them against the wrong OrderExecutor. Relies on the
  // create route persisting chain_id (deployed first); pre-existing rows default to chain_id=1.
  const query = `orders?status=eq.active&chain_id=eq.${CHAIN_ID}&select=*&order=created_at.asc&limit=${MAX_BATCH * 3}`
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
    // [CHORE-ORDER-API-CHAIN-AWARE] Defense-in-depth: the id is already row-specific, but the chain
    // filter ensures a keeper can only claim rows for its own chain even if an id from another chain
    // somehow reached this call.
    `orders?id=eq.${orderId}&status=eq.active&chain_id=eq.${CHAIN_ID}`,
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

// [chore/dca-resilience] Single failure handler for BOTH the no-route path and a
// thrown/reverted execution. The decision is the pure, unit-tested
// planFailureHandling() (retry-policy.js); this function only EXECUTES the plan:
//   (1) expiry wins — an expired order becomes 'expired' (its own status), never
//       a generic route 'failed';
//   (2) a PERMANENT cause (allowance/balance/nonce) fails NOW with that reason;
//   (3) a TRANSIENT miss keeps the order ACTIVE and retries a later cycle
//       (backoff), failing only after MAX_CYCLE_FAILURES consecutive misses with
//       no_route_after_retries + a one-shot #201 Telegram alert.
// Never double-executes: only status/error/updated_at are written here — never
// dca_executed — so completed DCA chunks are preserved.
async function handleExecutionFailure(dbOrder, { err = null, swapReason = null, noRoute = false } = {}, obsCtx = null) {
  const prev = orderRetries.get(dbOrder.id)
  const plan = planFailureHandling({
    dbOrder,
    err,
    swapReason,
    noRoute,
    prevFailures: prev ? prev.count : 0,
    nowSec: Math.floor(Date.now() / 1000),
    nowIso: new Date().toISOString(),
  })

  // [#201] One-shot Telegram alert at the cap, BEFORE flagging failed.
  if (plan.alert) {
    try {
      await alertOps(
        {
          kind: "failed-exec",
          detail: `Order ${dbOrder.id.slice(0, 8)}… (${dbOrder.order_type}) hit ${plan.failures} consecutive transient failures — flagging FAILED (${plan.reason}). Completed chunks (dca_executed=${dbOrder.dca_executed ?? 0}) are kept.`,
        },
        scoreFromContext(obsCtx || {}),
      )
    } catch { /* alert is best-effort, never blocks the fail */ }
  }

  // Apply the Supabase patch (status [+ error] + updated_at).
  await supabaseFetch(`orders?id=eq.${dbOrder.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(plan.patch),
  })

  // Update the in-memory consecutive-miss tracker.
  if (plan.clearRetries) {
    orderRetries.delete(dbOrder.id)
  } else {
    orderRetries.set(dbOrder.id, { count: plan.failures, lastAttempt: Date.now() })
  }

  if (plan.kind === "expired") {
    log(`  Order ${dbOrder.id.slice(0, 8)}... expired — recording 'expired', not a route failure`)
  } else if (plan.kind === "fail") {
    log(`  Order ${dbOrder.id.slice(0, 8)}... FAILED — reason=${plan.reason} (after ${plan.failures} attempt(s))`)
  } else {
    log(`  Order ${dbOrder.id.slice(0, 8)}... transient miss ${plan.failures}/${MAX_CYCLE_FAILURES}, retry in ~${Math.round(plan.backoffMs / 1000)}s (left active)`)
  }
}

async function unlockStaleOrders() {
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString()
  await supabaseFetch(
    // [CHORE-ORDER-API-CHAIN-AWARE] Chain-scope the stale-unlock so a per-chain keeper only releases
    // its OWN in-flight rows, never another chain's keeper's locked rows.
    `orders?status=eq.executing&chain_id=eq.${CHAIN_ID}&updated_at=lt.${cutoff}`,
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

// [CHORE-KEEPER-RECORD-EXECUTIONS] The per-fill order_executions write now lives in
// record-execution.js (recordExecutionRow): idempotent (keyed by tx_hash), schema-valid
// (writes execution_number + fee_amount, drops the phantom executed_at column), and it
// CHECKS res.ok instead of swallowing failures. See the confirmed-success block below.

// [DCA-OBS] Keeper-side freeze read. Reads the SAME circuit_breaker table the
// admin route + create-order API use (single fixed row id='dca'). FAIL-OPEN:
// any error / missing table / missing row ⇒ { frozen:false } so the keeper keeps
// running (the on-chain pause() is the nuclear fail-safe; this only delays DCA).
async function readFreezeFlag() {
  try {
    const res = await supabaseFetch(
      "circuit_breaker?id=eq.dca&select=frozen,reason"
    )
    if (!res.ok) {
      log(`  WARNING: freeze read failed (HTTP ${res.status}) -- treating as NOT frozen`)
      return { frozen: false }
    }
    const rows = await res.json()
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) return { frozen: false }
    return { frozen: row.frozen === true, reason: row.reason || null }
  } catch (err) {
    log(`  WARNING: freeze read error (${err.message}) -- treating as NOT frozen`)
    return { frozen: false }
  }
}

// [DCA-OBS] Read ETH/USD from the Chainlink aggregator (8 decimals). Returns a
// Number USD price, or null if the feed read fails (non-fatal; low-gas signal is
// simply skipped that cycle). Never throws.
async function readEthUsd(publicClient) {
  try {
    const [, answer] = await publicClient.readContract({
      address: getAddress(ETH_USD_FEED),
      abi: PRICE_FEED_ABI,
      functionName: "latestRoundData",
    })
    const usd = Number(answer) / 1e8
    return Number.isFinite(usd) && usd > 0 ? usd : null
  } catch (err) {
    log(`  WARNING: ETH/USD feed read failed (${err.message?.slice(0, 80)}) -- skipping low-gas signal`)
    return null
  }
}

// ---- Swap route fetcher ------------------------------------------------

// [chore/dca-router-chainaware] A conditional order is EIP-712-signed with a
// specific order.router; executeOrder approves + calls THAT router with the
// keeper's calldata. So the keeper must build calldata for order.router — it
// requests the /api/swap source that targets it (sourceForRouter), NOT an
// unconstrained "best source" (which would hand e.g. Augustus calldata to the
// 1inch router → SwapFailed). `amount` here is the per-chunk NET amount (after
// the contract's 0.1% tokenIn fee — see computeNetChunkAmount at the call site).
async function fetchSwapRoute(tokenIn, tokenOut, amount, from, chainId, srcDecimals, dstDecimals, router) {
  if (!API_URL) {
    log("  TERASWAP_API_URL not configured -- skipping swap route")
    return null
  }

  const source = sourceForRouter(router)
  if (!source) {
    console.error(`  Swap route: no /api/swap source maps to order.router ${router} -- skipping (would mis-route)`)
    return null
  }

  try {
    // chainId is a BODY field (per /api/swap + the frontend useSwap contract) so
    // Base chunks route on Base; omitted on mainnet (CHAIN_ID=1) → byte-identical.
    // Token decimals are required so non-18-dec outputs aren't 422'd by the guard.
    const res = await fetch(`${API_URL}/api/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildSwapRoutePayload({ source, tokenIn, tokenOut, amount, from, srcDecimals, dstDecimals, chainId }),
      ),
    })

    if (!res.ok) {
      // Log the response BODY, not just the status — the status alone hid the
      // INVALID_SOURCE / priceGuard cause (chore/keeper-swap-payload-fix).
      const body = await res.text().catch(() => "")
      console.error(`  Swap API error: ${res.status} ${body.slice(0, 300)} (source=${source})`)
      return null
    }

    const data = await res.json()
    if (!data.tx?.data) {
      console.error("  Swap route: missing tx data")
      return null
    }

    // [chore/dca-router-chainaware] FUND-FLOW GUARD: the calldata MUST target the
    // signed order.router (the contract approves + calls exactly that router). If
    // /api/swap returned calldata for a different router, refuse — sending it
    // would approve order.router but the call target would differ → SwapFailed.
    const target = data.tx.to
    if (!target || !router || target.toLowerCase() !== router.toLowerCase()) {
      console.error(`  Swap route: tx.to ${target} != order.router ${router} (source=${source}) -- refusing to mis-route`)
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

// ---- Freeze-observability helpers (all NON-BLOCKING / fail-safe) --------
// These NEVER throw and NEVER alter the execution path. They only read state,
// compute the freeze-urgency score (computeFreezeScore) and emit Telegram alerts
// (no-ops unless Telegram is configured). The bot NEVER auto-freezes.

/**
 * Compute a cycle-level freeze-urgency score from the current observability
 * context. Outflow defaults to 0 (only known at cycle END). Never throws.
 * @param {{ethUsd:number|null, walletBalanceEth:number, unexplainedOutflowEth?:number}} ctx
 */
function scoreFromContext(ctx) {
  try {
    const gasUsdValue =
      ctx && typeof ctx.ethUsd === "number" && Number.isFinite(ctx.ethUsd)
        ? ctx.walletBalanceEth * ctx.ethUsd
        : undefined
    return computeFreezeScore({
      unexplainedOutflowEth: (ctx && ctx.unexplainedOutflowEth) || 0,
      outflowThresholdEth: OUTFLOW_THRESHOLD_ETH,
      gasUsdValue,
      consecutiveExecFailures,
      rpcDown,
    })
  } catch {
    return 0
  }
}

/**
 * Cycle START observability: capture the wallet ETH balance, read the freeze
 * flag ONCE, read ETH/USD ONCE, emit a one-shot freeze alert + a low-gas alert.
 * Returns a context object consumed at cycle end. Never throws; on any failure
 * it returns safe fail-open defaults (NOT frozen).
 */
async function beginCycleObservability(publicClient, walletAddress, monitor) {
  const ctx = {
    walletAddress,
    cycleStartBalanceWei: null,
    walletBalanceEth: 0,
    frozen: false,
    freezeReason: null,
    ethUsd: null,
  }

  try {
    ctx.cycleStartBalanceWei = await publicClient.getBalance({ address: walletAddress })
    ctx.walletBalanceEth = Number(formatEther(ctx.cycleStartBalanceWei))
    rpcDown = false
  } catch (err) {
    // Could not read chain state ⇒ flag RPC down for the score; keep going.
    rpcDown = true
    log(`  WARNING: balance read failed (${err.message?.slice(0, 80)}) -- rpcDown=true`)
    try {
      await alertOps({ kind: "rpc", detail: `balance read failed: ${err.message}` }, scoreFromContext(ctx))
    } catch { /* never throw */ }
  }

  // Freeze flag (fail-open). Alert ONCE per state transition (frozen<->unfrozen).
  try {
    const flag = await readFreezeFlag()
    ctx.frozen = flag.frozen === true
    ctx.freezeReason = flag.reason || null
    if (ctx.frozen !== freezeAlertedState) {
      freezeAlertedState = ctx.frozen
      if (ctx.frozen) {
        await alertOps(
          { kind: "failed-exec", detail: `DCA execution is FROZEN (circuit_breaker). Reason: ${ctx.freezeReason || "n/a"}. Non-DCA orders still execute.` },
          scoreFromContext(ctx),
        )
      }
    }
  } catch { /* never throw */ }

  // ETH/USD for the low-gas signal (cached for the cycle; non-fatal on failure).
  try {
    ctx.ethUsd = await readEthUsd(publicClient)
    if (typeof ctx.ethUsd === "number" && ctx.cycleStartBalanceWei !== null) {
      const gasUsdValue = ctx.walletBalanceEth * ctx.ethUsd
      if (gasUsdValue < LOW_GAS_USD_THRESHOLD) {
        await alertLowGas(
          { balanceEth: ctx.walletBalanceEth.toFixed(6), gasUsdValue: gasUsdValue.toFixed(2) },
          scoreFromContext(ctx),
        )
      }
    }
  } catch { /* never throw */ }

  return ctx
}

/**
 * Cycle END observability: capture the wallet balance again and compute
 * unexplainedOutflowEth = max(0, (start - end - ownGasSpentWei)/1e18). If it
 * exceeds OUTFLOW_THRESHOLD_ETH, emit alertUnexplainedOutflow with the score.
 * Never throws.
 * @param {object} ctx — from beginCycleObservability
 * @param {bigint} ownGasSpentWei — gas this executor itself spent this cycle
 */
async function endCycleObservability(ctx, publicClient, ownGasSpentWei) {
  if (!ctx || ctx.cycleStartBalanceWei === null) return
  try {
    const endBalanceWei = await publicClient.getBalance({ address: ctx.walletAddress })
    const ownGas = typeof ownGasSpentWei === "bigint" ? ownGasSpentWei : 0n
    let outflowWei = ctx.cycleStartBalanceWei - endBalanceWei - ownGas
    if (outflowWei < 0n) outflowWei = 0n
    const unexplainedOutflowEth = Number(formatEther(outflowWei))
    if (unexplainedOutflowEth > OUTFLOW_THRESHOLD_ETH) {
      const score = scoreFromContext({ ...ctx, unexplainedOutflowEth })
      await alertUnexplainedOutflow(
        {
          outflowEth: unexplainedOutflowEth.toFixed(6),
          thresholdEth: OUTFLOW_THRESHOLD_ETH,
          walletAddress: ctx.walletAddress,
        },
        score,
      )
    }
  } catch { /* never throw */ }
}

/**
 * Detect a never-before-seen DCA order and announce it ONCE. Tracks seen ids
 * in-memory (dca_executed===0 is the "new" signal). Never throws.
 * @param {object} dbOrder — the Supabase order row
 * @param {object} ctx — observability context (for the score)
 */
async function maybeAlertNewDca(dbOrder, ctx) {
  try {
    if (!dbOrder || dbOrder.order_type !== "dca") return
    if (seenDcaOrderIds.has(dbOrder.id)) return
    // dca_executed===0 ⇒ a fresh position; still mark any DCA id as seen so we
    // announce each one at most once for this process lifetime.
    seenDcaOrderIds.add(dbOrder.id)
    if (Number(dbOrder.dca_executed || 0) !== 0) return

    const od = dbOrder.order_data || {}
    const tokenInSymbol = dbOrder.token_in_symbol || od.tokenInSymbol || "?"
    const tokenOutSymbol = dbOrder.token_out_symbol || od.tokenOutSymbol || "?"
    const decimalsIn = Number(dbOrder.token_in_decimals ?? od.tokenInDecimals ?? 18)
    const dcaTotal = Number(dbOrder.dca_total || od.dcaTotal || 0)
    const dcaInterval = Number(dbOrder.dca_interval || od.dcaInterval || 0)

    let amountInHuman = String(dbOrder.amount_in ?? od.amountIn ?? "0")
    let perChunkHuman = "?"
    try {
      const amountInWei = BigInt(dbOrder.amount_in ?? od.amountIn ?? "0")
      amountInHuman = formatUnits(amountInWei, decimalsIn)
      if (dcaTotal > 0) {
        perChunkHuman = formatUnits(amountInWei / BigInt(dcaTotal), decimalsIn)
      }
    } catch { /* fall back to raw strings */ }

    await alertNewDcaPosition(
      { tokenInSymbol, tokenOutSymbol, amountInHuman, dcaInterval, dcaTotal, perChunkHuman },
      scoreFromContext(ctx),
    )
  } catch { /* never throw */ }
}

// ---- Main execution loop -----------------------------------------------

async function executeCycle(publicClient, walletClient, contract, flashbotsPublicClient, flashbotsWalletClient, monitor = null) {
  log("Starting execution cycle...")
  if (monitor) monitor.onCycleStart()

  // [DCA-OBS] Cycle-start observability: snapshot balance, freeze flag, ETH/USD.
  // Fully fail-open + non-blocking — never affects the execution path below.
  const walletAddress = walletClient?.account?.address
  const obsCtx = walletAddress
    ? await beginCycleObservability(publicClient, walletAddress, monitor)
    : null
  const cycleFrozen = obsCtx ? obsCtx.frozen === true : false
  // Gas this executor itself spends this cycle (sum of receipt.gasUsed*price).
  let ownGasSpentWei = 0n

  // 0. Unlock stale orders
  await unlockStaleOrders()

  // 1. Fetch active orders
  const orders = await fetchActiveOrders()

  if (orders.length === 0) {
    log("  No active orders")
    // [DCA-OBS] Still close out observability (outflow check) even with no orders.
    await endCycleObservability(obsCtx, publicClient, ownGasSpentWei)
    return
  }

  log(`  Found ${orders.length} active order(s)`)

  let executed = 0
  let skipped = 0
  let errors = 0

  for (const dbOrder of orders) {
    if (executed >= MAX_BATCH) break

    try {
      // Check if expired (off-chain pre-filter). [chore/dca-resilience] An order
      // that expires mid-retry is recorded 'expired' (its own status) — never a
      // generic route 'failed' — so the UI shows the real cause; drop any stale
      // retry-tracker entry so the Map does not leak.
      const expiryTs = Number(dbOrder.expiry)
      if (expiryTs < Math.floor(Date.now() / 1000)) {
        await updateOrderStatus(dbOrder.id, "expired")
        orderRetries.delete(dbOrder.id)
        log(`  Order ${dbOrder.id.slice(0, 8)}... expired (expiry: ${dbOrder.expiry})`)
        continue
      }

      // [chore/dca-resilience] Honor the per-order backoff — skip until the
      // exponential (capped) window since the last transient miss has elapsed,
      // so a transient route/API outage has time to recover between retries.
      const retryState = orderRetries.get(dbOrder.id)
      if (retryState && Date.now() - retryState.lastAttempt < backoffMs(retryState.count)) {
        continue // Still in backoff window — retry a later cycle
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

      // [DCA-OBS] Announce a never-before-seen DCA position (non-blocking).
      await maybeAlertNewDca(dbOrder, obsCtx)

      // [DCA-OBS] FREEZE-HONOR: if this cycle is frozen, DCA orders are delayed
      // (NOT lost) — return them to 'active' so they RESUME on a later cycle once
      // the operator unfreezes. Non-DCA (limit/stop_loss) are UNAFFECTED. The bot
      // never sets the freeze flag; this only honors a human's freeze.
      if (cycleFrozen && dbOrder.order_type === "dca") {
        log(`  Order ${dbOrder.id.slice(0, 8)}... DCA execution FROZEN -- delaying (left active)`)
        await updateOrderStatus(dbOrder.id, "active") // Unlock; resumes when unfrozen
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

      // Fetch swap route. Token decimals (required so a non-18-dec output isn't
      // 422'd by the price guard) come from the order row, order_data + 18
      // fallbacks (same source as the DCA alert). [chore/keeper-swap-payload-fix]
      const odSwap = dbOrder.order_data || {}
      const srcDecimals = Number(dbOrder.token_in_decimals ?? odSwap.tokenInDecimals ?? 18)
      const dstDecimals = Number(dbOrder.token_out_decimals ?? odSwap.tokenOutDecimals ?? 18)
      // [chore/dca-router-chainaware] Build the route for the per-chunk NET amount
      // the contract will actually swap — it takes the 0.1% tokenIn fee first and,
      // for DCA, swaps only the cumulative per-chunk slice — and constrain it to the
      // SIGNED order.router (executeOrder approves + calls exactly that router). All
      // swap params come from orderStruct (the EIP-712-signed order), not the DB row.
      const isDca = dbOrder.order_type === "dca"
      const netAmount = computeNetChunkAmount({
        amountIn: orderStruct.amountIn,
        dcaTotal: Number(orderStruct.dcaTotal),
        execCount: Number(dbOrder.dca_executed || 0),
        isDca,
      })
      const swapData = await fetchSwapRoute(
        orderStruct.tokenIn,
        orderStruct.tokenOut,
        netAmount,
        CONTRACT_ADDRESS,
        CHAIN_ID, // keeper's chain (8453 on Base; 1 → omitted, mainnet byte-identical)
        srcDecimals,
        dstDecimals,
        orderStruct.router,
      )

      if (!swapData) {
        // [chore/dca-resilience] No route THIS cycle is transient: keep the order
        // active and retry a later cycle (backoff). Only after MAX_CYCLE_FAILURES
        // consecutive misses does this fail with no_route_after_retries (+alert).
        log(`  Order ${dbOrder.id.slice(0, 8)}... -- no swap route this cycle`)
        await handleExecutionFailure(dbOrder, { noRoute: true }, obsCtx)
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

      if (shouldRecord(receipt)) {
        log(`  Order ${dbOrder.id.slice(0, 8)}... executed! Gas: ${receipt.gasUsed.toString()}`)

        // [EX-MON] Track gas spent
        if (receipt.gasUsed) {
          const effectiveGasPrice = receipt.effectiveGasPrice || 0n
          const txGasWei = receipt.gasUsed * effectiveGasPrice
          if (monitor) monitor.onGasSpent(txGasWei)
          // [DCA-OBS] Accumulate THIS executor's own gas spend so the cycle-end
          // outflow check can subtract it (legitimate spend, not a drain).
          ownGasSpentWei += txGasWei
        }
        // [DCA-OBS] A successful execution clears the consecutive-failure signal.
        consecutiveExecFailures = 0
        // [chore/dca-resilience] ...and resets THIS order's transient-miss count,
        // so a later isolated miss starts fresh (consecutive, not cumulative).
        orderRetries.delete(dbOrder.id)

        const now = new Date().toISOString()

        // [CHORE-KEEPER-RECORD-EXECUTIONS] Advance the parent order's status / exec-count.
        // DCA cycles active⇄active until the final chunk, then 'executed' (UI "N of M" reads
        // orders.dca_executed); limit/stop-loss complete on their single fill.
        if (dbOrder.order_type === "dca") {
          const next = nextOrderStatus(dbOrder)
          const orderPatch = {
            status: next.status,
            dca_executed: next.dca_executed,
            dca_last_exec: now,
            tx_hash: txHash,
            updated_at: now,
          }
          if (next.complete) orderPatch.executed_at = now
          await supabaseFetch(`orders?id=eq.${dbOrder.id}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify(orderPatch),
          })
        } else {
          // Limit / Stop-Loss: single execution
          await supabaseFetch(`orders?id=eq.${dbOrder.id}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              status: "executed",
              executed_at: now,
              tx_hash: txHash,
              updated_at: now,
            }),
          })
        }

        // [CHORE-KEEPER-RECORD-EXECUTIONS] Record ONE order_executions row for this
        // confirmed fill (idempotent, keyed by tx_hash). Per-chunk amount_in/amount_out/fee
        // are decoded from the on-chain OrderExecuted event (authoritative); analytics (#228)
        // values the chunk from the parent order, so no USD is written here. Failures are
        // surfaced, not swallowed (the original silent-400 bug that left the table empty).
        const decoded = decodeOrderExecuted(receipt.logs, CONTRACT_ADDRESS)
        if (!decoded) {
          log(`  WARNING: OrderExecuted event not found in tx ${txHash.slice(0, 10)}... — recording with fallback amounts`)
        }
        const execRow = buildExecutionRow({ dbOrder, txHash, receipt, decoded })
        const rec = await recordExecutionRow(supabaseFetch, execRow)
        if (rec.recorded) {
          log(`  Recorded execution #${execRow.execution_number} for order ${dbOrder.id.slice(0, 8)}...`)
        } else if (rec.reason === "duplicate") {
          log(`  Execution for tx ${txHash.slice(0, 10)}... already recorded — skipping`)
        } else {
          console.error(`  Failed to record execution for ${dbOrder.id.slice(0, 8)}...: ${rec.error}`)
        }

        executed++
      } else {
        log(`  TX reverted: ${txHash}`)
        // [DCA-OBS] A reverted tx still burned gas — count it as own spend so it
        // is NOT mistaken for an unexplained outflow; and as a failure signal.
        try {
          if (receipt.gasUsed) {
            ownGasSpentWei += receipt.gasUsed * (receipt.effectiveGasPrice || 0n)
          }
        } catch { /* ignore */ }
        consecutiveExecFailures++
        // [chore/dca-resilience] A mined revert (no decodable reason here) is
        // treated as a transient miss: keep the order active and retry a later
        // cycle (backoff), capping at MAX_CYCLE_FAILURES so a persistently
        // reverting tx stops burning gas and fails with no_route_after_retries
        // (+alert) instead of re-sending forever.
        await handleExecutionFailure(dbOrder, {}, obsCtx)
      }
    } catch (err) {
      // [chore/dca-swapfailed] If the revert is SwapFailed(bytes), unwrap the
      // inner DEX-router reason so the log shows WHY the on-chain swap reverted
      // (e.g. allowance/amount mismatch, or an empty revert = order.router does
      // not match the calldata's target router). The unwrapped reason ALSO feeds
      // classifyFailure below so a permanent cause (allowance/balance/nonce) is
      // failed-with-reason immediately rather than retried to the cap.
      let swapReason = null
      try {
        const sf = decodeSwapFailed(extractRevertData(err))
        if (sf) {
          swapReason = sf.reason
          // dbOrder (loop var) is in catch scope; orderStruct is not (declared in the try).
          const failedRouter = dbOrder.router ?? (dbOrder.order_data || {}).router ?? "?"
          console.error(`  Order ${dbOrder.id.slice(0, 8)}... SwapFailed → ${sf.reason} (router=${failedRouter}, inner=${sf.innerHex})`)
        }
      } catch { /* never let diagnostics mask the original error */ }
      console.error(`  Order ${dbOrder.id.slice(0, 8)}... error:`, err.message)
      errors++
      // [DCA-OBS] Execution threw (RPC/revert/timeout) — bump the failure signal.
      consecutiveExecFailures++
      stats.totalErrors++
      stats.lastError = { orderId: dbOrder.id, message: err.message, at: new Date().toISOString() }

      // [chore/dca-resilience] Classify transient vs permanent and decide retry
      // (keep active) vs fail-with-specific-reason — replaces the old blunt
      // MAX_RETRIES=3 → 'failed' (no reason), which permanently failed a routable
      // DCA on a single transient miss and masked the real cause.
      await handleExecutionFailure(dbOrder, { err, swapReason }, obsCtx)
    }
  }

  // Update stats
  stats.totalCycles++
  stats.totalExecuted += executed
  stats.totalSkipped += skipped
  stats.lastCycleAt = new Date().toISOString()
  if (executed > 0) stats.lastExecutionAt = new Date().toISOString()

  if (monitor) monitor.onCycleEnd(executed, errors)

  // [DCA-OBS] Cycle-end observability: unexplained-outflow check (subtracting
  // this executor's own gas spend). Non-blocking + fail-safe.
  await endCycleObservability(obsCtx, publicClient, ownGasSpentWei)

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
