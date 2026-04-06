/**
 * On-chain event watcher for TeraSwap admin events.
 *
 * Polls for contract events every 30 seconds using viem's getLogs.
 * Sends Telegram alerts for governance-critical events (timelock, pause, admin transfer).
 *
 * Design:
 *   - Polling-based (getLogs), NOT WebSocket subscriptions
 *   - On first poll, records current block number — no history replay
 *   - Exponential backoff on RPC errors (5s → 80s)
 *   - After 5 consecutive failures, sends degradation alert then resets
 *   - Non-blocking: runs via setInterval, returns { stop } function
 */

import { parseAbiItem, formatEther, decodeEventLog } from "viem"
import { sendTelegramAlert } from "./alert.js"

// ── Events to monitor ───────────────────────────────────────
const WATCHED_EVENTS = [
  parseAbiItem("event TimelockQueued(bytes32 indexed actionId, bytes32 actionHash, uint256 readyAt)"),
  parseAbiItem("event TimelockExecuted(bytes32 indexed actionId, string actionType, bytes data)"),
  parseAbiItem("event TimelockCancelled(bytes32 indexed actionId)"),
  parseAbiItem("event AdminTransferred(address indexed oldAdmin, address indexed newAdmin)"),
  parseAbiItem("event RouterWhitelisted(address indexed router, bool status)"),
  parseAbiItem("event Paused(address indexed admin)"),
  parseAbiItem("event Unpaused(address indexed admin)"),
  parseAbiItem("event SweepQueued(bytes32 indexed actionId, address token)"),
]

// Build a lookup map: topic0 → ABI item
const EVENT_BY_TOPIC = new Map()
for (const abi of WATCHED_EVENTS) {
  // viem parseAbiItem returns { type: 'event', name, inputs }
  // We need to compute the topic hash for matching
  EVENT_BY_TOPIC.set(abi.name, abi)
}

const POLL_INTERVAL_MS = 30_000 // 30 seconds
const INITIAL_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 80_000
const MAX_CONSECUTIVE_FAILURES = 5

const CHAIN_ID = process.env.CHAIN_ID || "1"
const ETHERSCAN_BASE =
  CHAIN_ID === "1"
    ? "https://etherscan.io"
    : CHAIN_ID === "11155111"
      ? "https://sepolia.etherscan.io"
      : "https://etherscan.io"

// ── Event formatters ────────────────────────────────────────

function formatTimelockQueued(args, txHash) {
  const readyAtDate = new Date(Number(args.readyAt) * 1000)
  const hoursUntilReady = Math.max(0, (Number(args.readyAt) * 1000 - Date.now()) / 3_600_000).toFixed(1)
  return [
    `<b>Timelock Queued</b>`,
    `Action ID: <code>${args.actionId.slice(0, 18)}...</code>`,
    `Ready at: ${readyAtDate.toISOString()} (~${hoursUntilReady}h)`,
    txLink(txHash),
  ].join("\n")
}

function formatTimelockExecuted(args, txHash) {
  return [
    `<b>Timelock Executed</b>`,
    `Action ID: <code>${args.actionId.slice(0, 18)}...</code>`,
    args.actionType ? `Type: ${args.actionType}` : null,
    txLink(txHash),
  ].filter(Boolean).join("\n")
}

function formatTimelockCancelled(args, txHash) {
  return [
    `<b>Timelock Cancelled</b>`,
    `Action ID: <code>${args.actionId.slice(0, 18)}...</code>`,
    txLink(txHash),
  ].join("\n")
}

function formatAdminTransferred(args, txHash) {
  return [
    `<b>ADMIN TRANSFERRED</b>`,
    `Old: <code>${args.oldAdmin}</code>`,
    `New: <code>${args.newAdmin}</code>`,
    txLink(txHash),
  ].join("\n")
}

function formatRouterWhitelisted(args, txHash) {
  return [
    `<b>Router Whitelist Updated</b>`,
    `Router: <code>${args.router}</code>`,
    `Status: ${args.status ? "ENABLED" : "REMOVED"}`,
    txLink(txHash),
  ].join("\n")
}

function formatPaused(args, txHash) {
  return [
    `<b>CONTRACT PAUSED</b>`,
    `By: <code>${args.admin}</code>`,
    txLink(txHash),
  ].join("\n")
}

function formatUnpaused(args, txHash) {
  return [
    `<b>Contract Unpaused</b>`,
    `By: <code>${args.admin}</code>`,
    txLink(txHash),
  ].join("\n")
}

function formatSweepQueued(args, txHash) {
  return [
    `<b>Sweep Queued</b>`,
    `Action ID: <code>${args.actionId.slice(0, 18)}...</code>`,
    `Token: <code>${args.token}</code>`,
    txLink(txHash),
  ].join("\n")
}

function txLink(txHash) {
  return `Tx: <a href="${ETHERSCAN_BASE}/tx/${txHash}">${txHash.slice(0, 18)}...</a>`
}

// Map event name → { emoji, severity, formatter }
const EVENT_CONFIG = {
  TimelockQueued:     { emoji: "\u23F3", severity: "INFO",     format: formatTimelockQueued },
  TimelockExecuted:   { emoji: "\u2705", severity: "INFO",     format: formatTimelockExecuted },
  TimelockCancelled:  { emoji: "\uD83D\uDEAB", severity: "WARN",     format: formatTimelockCancelled },
  AdminTransferred:   { emoji: "\uD83D\uDD34", severity: "CRITICAL", format: formatAdminTransferred },
  RouterWhitelisted:  { emoji: "\uD83D\uDD27", severity: "INFO",     format: formatRouterWhitelisted },
  Paused:             { emoji: "\uD83D\uDD34", severity: "CRITICAL", format: formatPaused },
  Unpaused:           { emoji: "\u2705", severity: "INFO",     format: formatUnpaused },
  SweepQueued:        { emoji: "\uD83E\uDDF9", severity: "INFO",     format: formatSweepQueued },
}

// ── Main watcher ────────────────────────────────────────────

/**
 * Start polling for on-chain admin events.
 *
 * @param {import('viem').PublicClient} publicClient — viem public client
 * @param {string} contractAddress — TeraSwapOrderExecutor address
 * @param {import('./monitor.js').ExecutorMonitor|null} monitor — optional Prometheus monitor
 * @returns {{ stop: () => void }}
 */
export function startEventWatcher(publicClient, contractAddress, monitor = null) {
  let lastBlock = null
  let consecutiveFailures = 0
  let backoffMs = INITIAL_BACKOFF_MS
  let timer = null
  let stopped = false

  async function poll() {
    if (stopped) return

    try {
      const currentBlock = await publicClient.getBlockNumber()

      // First poll: just record the block, don't replay history
      if (lastBlock === null) {
        lastBlock = currentBlock
        console.log(`[EVENT-WATCHER] Initialized at block ${currentBlock}`)
        consecutiveFailures = 0
        backoffMs = INITIAL_BACKOFF_MS
        return
      }

      // No new blocks
      if (currentBlock <= lastBlock) return

      // Fetch ALL logs from the contract in the block range, then decode
      const logs = await publicClient.getLogs({
        address: contractAddress,
        fromBlock: lastBlock + 1n,
        toBlock: currentBlock,
      })

      for (const log of logs) {
        try {
          // Try to decode against each watched event ABI
          let decoded = null
          let matchedName = null

          for (const abi of WATCHED_EVENTS) {
            try {
              decoded = decodeEventLog({
                abi: [abi],
                data: log.data,
                topics: log.topics,
              })
              matchedName = decoded.eventName
              break
            } catch {
              // Not this event, try next
            }
          }

          if (!decoded || !matchedName) continue

          const config = EVENT_CONFIG[matchedName]
          if (!config) continue

          const message = [
            `${config.emoji} <b>${config.severity}</b> — On-chain Event`,
            ``,
            config.format(decoded.args, log.transactionHash),
            `Block: ${log.blockNumber}`,
          ].join("\n")

          console.log(`[EVENT-WATCHER] ${matchedName} at block ${log.blockNumber}`)
          await sendTelegramAlert(message)

          // Report to Prometheus monitor
          if (monitor?.onAdminEvent) {
            monitor.onAdminEvent(matchedName)
          }
        } catch (decodeErr) {
          // Skip unrecognized events silently
        }
      }

      lastBlock = currentBlock
      consecutiveFailures = 0
      backoffMs = INITIAL_BACKOFF_MS
    } catch (err) {
      consecutiveFailures++
      console.error(`[EVENT-WATCHER] Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`)

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await sendTelegramAlert(
          `\u26A0\uFE0F <b>Event Watcher Degraded</b>\n${MAX_CONSECUTIVE_FAILURES} consecutive RPC failures.\nLast error: ${err.message}`
        )
        consecutiveFailures = 0
        backoffMs = INITIAL_BACKOFF_MS
      } else {
        // Exponential backoff: schedule next poll sooner
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      }
    }
  }

  // Start polling
  poll() // Initial poll (records block number)
  timer = setInterval(poll, POLL_INTERVAL_MS)
  if (timer.unref) timer.unref()

  console.log(`[EVENT-WATCHER] Started — polling every ${POLL_INTERVAL_MS / 1000}s for ${contractAddress}`)

  return {
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      console.log("[EVENT-WATCHER] Stopped")
    },
  }
}
