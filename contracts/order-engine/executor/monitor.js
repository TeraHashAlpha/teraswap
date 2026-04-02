/**
 * Executor monitoring — Prometheus metrics + Telegram alerting.
 *
 * Metrics endpoint: http://localhost:9090/metrics
 * Alert rules:
 *   - 3+ consecutive errors → Telegram alert
 *   - Cycle duration > 120s → Telegram alert (executor stalled)
 *   - Heartbeat every 6 hours → Telegram "alive" message
 */

import { createServer } from "http"
import { sendTelegramAlert, sendTelegramHeartbeat } from "./alert.js"

const ALERT_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
const CONSECUTIVE_ERROR_THRESHOLD = 3
const STALL_THRESHOLD_MS = 120_000 // 120 seconds

export class ExecutorMonitor {
  /**
   * @param {object} stats — Reference to the executor's stats object
   */
  constructor(stats) {
    this.stats = stats
    this.consecutiveErrors = 0
    this.lastCycleStartTime = null
    this.lastCycleDurationMs = 0
    this.gasSpent = 0n // BigInt, accumulator of gas cost in wei
    this.alertCooldown = new Map() // type → lastSentTimestamp
  }

  /** Call at the start of each executeCycle */
  onCycleStart() {
    this.lastCycleStartTime = Date.now()
  }

  /**
   * Call at the end of each executeCycle
   * @param {number} executed — Orders executed this cycle
   * @param {number} errors — Errors encountered this cycle
   */
  onCycleEnd(executed, errors) {
    if (this.lastCycleStartTime) {
      this.lastCycleDurationMs = Date.now() - this.lastCycleStartTime
    }

    if (errors > 0) {
      this.consecutiveErrors += errors
    } else if (executed >= 0) {
      this.consecutiveErrors = 0
    }

    // Check consecutive error threshold
    if (this.consecutiveErrors >= CONSECUTIVE_ERROR_THRESHOLD) {
      this._sendCooldownAlert(
        "consecutive_errors",
        `⚠️ ${this.consecutiveErrors} consecutive errors!\nLast error: ${this.stats.lastError?.message || "unknown"}`
      )
    }

    // Check for stalled executor
    if (this.lastCycleDurationMs > STALL_THRESHOLD_MS) {
      const durationSec = Math.round(this.lastCycleDurationMs / 1000)
      this._sendCooldownAlert(
        "stalled",
        `🐌 Executor stalled — last cycle took ${durationSec}s (threshold: 120s)`
      )
    }
  }

  /**
   * Track gas spent after a successful transaction
   * @param {bigint|string|number} gasUsedWei — Gas cost in wei
   */
  onGasSpent(gasUsedWei) {
    try {
      this.gasSpent += BigInt(gasUsedWei)
    } catch {
      // Ignore invalid values
    }
  }

  /**
   * Call when executeCycle throws (the catch in setInterval)
   * @param {Error} error — The caught error
   */
  onCycleError(error) {
    this.consecutiveErrors++

    if (this.consecutiveErrors >= CONSECUTIVE_ERROR_THRESHOLD) {
      this._sendCooldownAlert(
        "consecutive_errors",
        `⚠️ ${this.consecutiveErrors} consecutive errors!\nLast error: ${error?.message || "unknown"}`
      )
    }
  }

  /**
   * Start periodic heartbeat via Telegram
   * @param {number} intervalMs — Heartbeat interval (default: 6 hours)
   */
  startHeartbeat(intervalMs = 6 * 60 * 60 * 1000) {
    // Send initial heartbeat after 10s (let first cycle complete)
    setTimeout(() => sendTelegramHeartbeat(this.stats), 10_000)

    // Then every intervalMs
    const timer = setInterval(() => sendTelegramHeartbeat(this.stats), intervalMs)
    if (timer.unref) timer.unref()
  }

  /** Returns Prometheus text exposition format string */
  getMetrics() {
    const uptimeSeconds = Math.floor(
      (Date.now() - new Date(this.stats.startedAt).getTime()) / 1000
    )

    return [
      "# HELP teraswap_executor_cycles_total Total execution cycles",
      "# TYPE teraswap_executor_cycles_total counter",
      `teraswap_executor_cycles_total ${this.stats.totalCycles}`,
      "",
      "# HELP teraswap_executor_orders_executed_total Total orders executed",
      "# TYPE teraswap_executor_orders_executed_total counter",
      `teraswap_executor_orders_executed_total ${this.stats.totalExecuted}`,
      "",
      "# HELP teraswap_executor_orders_skipped_total Total orders skipped",
      "# TYPE teraswap_executor_orders_skipped_total counter",
      `teraswap_executor_orders_skipped_total ${this.stats.totalSkipped}`,
      "",
      "# HELP teraswap_executor_errors_total Total errors",
      "# TYPE teraswap_executor_errors_total counter",
      `teraswap_executor_errors_total ${this.stats.totalErrors}`,
      "",
      "# HELP teraswap_executor_consecutive_errors Current consecutive errors",
      "# TYPE teraswap_executor_consecutive_errors gauge",
      `teraswap_executor_consecutive_errors ${this.consecutiveErrors}`,
      "",
      "# HELP teraswap_executor_last_cycle_duration_ms Duration of last cycle in ms",
      "# TYPE teraswap_executor_last_cycle_duration_ms gauge",
      `teraswap_executor_last_cycle_duration_ms ${this.lastCycleDurationMs}`,
      "",
      "# HELP teraswap_executor_gas_spent_wei Total gas spent in wei",
      "# TYPE teraswap_executor_gas_spent_wei counter",
      `teraswap_executor_gas_spent_wei ${this.gasSpent.toString()}`,
      "",
      "# HELP teraswap_executor_uptime_seconds Executor uptime in seconds",
      "# TYPE teraswap_executor_uptime_seconds gauge",
      `teraswap_executor_uptime_seconds ${uptimeSeconds}`,
      "",
    ].join("\n")
  }

  /**
   * Start HTTP server serving /metrics in Prometheus format
   * @param {number} port — Port to listen on (default: 9090)
   */
  startMetricsServer(port = parseInt(process.env.METRICS_PORT || "9090")) {
    try {
      const server = createServer((req, res) => {
        if (req.url === "/metrics") {
          res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          })
          res.end(this.getMetrics())
        } else {
          res.writeHead(404)
          res.end("Not Found")
        }
      })

      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[MONITOR] Metrics port ${port} already in use, metrics server disabled`)
        } else {
          console.warn(`[MONITOR] Metrics server error: ${err.message}`)
        }
      })

      server.listen(port, () => {
        console.log(`[MONITOR] Prometheus metrics at http://localhost:${port}/metrics`)
      })
    } catch (err) {
      console.warn(`[MONITOR] Failed to start metrics server: ${err.message}`)
    }
  }

  /**
   * Send alert with cooldown to prevent spam
   * @param {string} type — Alert type key for cooldown tracking
   * @param {string} message — Alert message
   */
  _sendCooldownAlert(type, message) {
    const now = Date.now()
    const lastSent = this.alertCooldown.get(type) || 0

    if (now - lastSent < ALERT_COOLDOWN_MS) return

    this.alertCooldown.set(type, now)
    sendTelegramAlert(message)
  }
}
