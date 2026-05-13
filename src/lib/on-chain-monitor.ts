/**
 * On-chain event monitoring — P47.
 *
 * Watches critical contract events from TeraSwapFeeCollector and
 * TeraSwapOrderExecutor via eth_getLogs polling. Categorises events
 * by severity and routes alerts accordingly:
 *
 *   info     — operational events (OrderExecuted, OrderCancelled) → KV only
 *   warning  — notable ops (large SwapWithFee, SweepQueued) → Telegram
 *   critical — admin ops (AdminTransferred, ExecutorChangeProposed,
 *              RouterWhitelisted, Paused/Unpaused) → P0 full fan-out
 *
 * Uses eth_getLogs with topic filters. Block range capped at 1000 per call
 * to prevent RPC timeouts; larger gaps are chunked across ticks.
 *
 * [P109/M-05] Runs every monitoring tick (~60 s — the Cloudflare Worker
 * cron interval). Previously gated to every 5th tick, which delayed
 * detection of AdminTransferred / Paused / OwnershipTransferred /
 * RouterWhitelisted by up to 5 minutes. RPC cost is bounded by a
 * process-scope `lastScannedBlock` cache (fast-path skip when no new
 * blocks since the last tick) plus the existing KV-backed tracker.
 *
 * @internal — server-only module. Called by runMonitoringTick().
 */

import { createPublicClient, http, keccak256, toBytes, type PublicClient, type Log } from 'viem'
import { mainnet } from 'viem/chains'
import { kv } from '@/lib/kv'
import { FEE_COLLECTOR_ADDRESS, FEE_COLLECTOR_V1_ADDRESS } from './constants'
import { ORDER_EXECUTOR_ADDRESS } from './order-engine/config'
import { emitTransitionAlert } from './alert-wrapper'

// ── Types ────────────────────────────────────────────────

export type EventSeverity = 'info' | 'warning' | 'critical'

export interface OnChainEvent {
  contract: 'FeeCollector' | 'OrderExecutor'
  eventName: string
  txHash: string
  blockNumber: number
  args: Record<string, unknown>
  severity: EventSeverity
}

export interface OnChainScanResult {
  fromBlock: number
  toBlock: number
  eventsFound: number
  criticalCount: number
  warningCount: number
  infoCount: number
  /** [10-L-04] True when the alert dispatcher had at least one failure
   *  this tick AND we therefore held lastScannedBlock back to retry. */
  blockAdvanceHeld?: boolean
  /** [10-L-04] Number of events that reached the 3-attempt retry cap
   *  this tick and were dropped to the alerts_lost_total counter. */
  permanentlyLost?: number
  /** [10-L-04] Number of retry-queue entries successfully delivered this tick. */
  retriesDelivered?: number
}

/** [10-L-04] Persistent retry-queue entry shape. */
export interface AlertRetryEntry {
  event: OnChainEvent
  /** 1 after the first failure; we drop + log lost when this would become > MAX_ALERT_ATTEMPTS. */
  attempts: number
  /** ISO timestamp of the first failed dispatch — useful for triage if an
   *  alert is "stuck" in the queue for a long time. */
  firstFailedAt: string
}

// ── Event topic hashes ───────────────────────────────────
// keccak256 of canonical event signatures. Hardcoded for performance
// (avoids ABI parsing at runtime). Verified against contract source.

function topic(sig: string): `0x${string}` {
  return keccak256(toBytes(sig))
}

// OrderExecutor events
const TOPICS = {
  // Info
  OrderExecuted: topic('OrderExecuted(bytes32,address,uint8,address,address,uint256,uint256,uint256)'),
  OrderCancelled: topic('OrderCancelled(bytes32,address)'),
  NoncesInvalidated: topic('NoncesInvalidated(address,uint256)'),
  // Critical — admin operations
  AdminTransferred: topic('AdminTransferred(address,address)'),
  ExecutorChangeProposed: topic('ExecutorChangeProposed(address,bool,uint256)'),
  ExecutorChangeExecuted: topic('ExecutorChangeExecuted(address,bool)'),
  ExecutorChangeCancelled: topic('ExecutorChangeCancelled(address)'),
  ExecutorWhitelisted: topic('ExecutorWhitelisted(address,bool)'),
  RouterWhitelisted: topic('RouterWhitelisted(address,bool)'),
  TimelockQueued: topic('TimelockQueued(bytes32,bytes32,uint256)'),
  TimelockExecuted: topic('TimelockExecuted(bytes32,string,bytes)'),
  TimelockCancelled: topic('TimelockCancelled(bytes32)'),
  Paused: topic('Paused(address)'),
  Unpaused: topic('Unpaused(address)'),
  OracleConfigured: topic('OracleConfigured(address,uint8,uint256,int256,int256)'),
  // Warning
  SweepQueued: topic('SweepQueued(bytes32,address)'),
  Bootstrap: topic('Bootstrap(address)'),

  // FeeCollector events
  // V2 (current — adds tokenOut + outputAmount per H-04 minimumOutput change)
  SwapWithFee: topic('SwapWithFee(address,address,address,uint256,uint256,address,uint256)'),
  // V1 (frozen — kept so residual swaps emitted by 0x4dAE…58eD still classify
  // correctly during the V1 wind-down. V1 and V2 share the same first three
  // non-indexed slots (tokenIn, totalAmount, feeAmount), so the large-fee
  // parser at maybeElevateFeeEvent works for both without branching.) [9B-I-01]
  SwapWithFeeV1: topic('SwapWithFee(address,address,address,uint256,uint256)'),
  // OwnershipTransferred — standard OpenZeppelin (FeeCollector is not Ownable,
  // but we monitor it on OrderExecutor's address too as a catch-all)
  OwnershipTransferred: topic('OwnershipTransferred(address,address)'),
} as const

// ── Severity classification ──────────────────────────────

/** Map topic0 → { eventName, severity, contract } */
interface EventClassification {
  eventName: string
  severity: EventSeverity
  contract: 'FeeCollector' | 'OrderExecutor'
}

function classifyOrderExecutorEvent(topic0: string): EventClassification | null {
  switch (topic0) {
    // Info — operational
    case TOPICS.OrderExecuted:
      return { eventName: 'OrderExecuted', severity: 'info', contract: 'OrderExecutor' }
    case TOPICS.OrderCancelled:
      return { eventName: 'OrderCancelled', severity: 'info', contract: 'OrderExecutor' }
    case TOPICS.NoncesInvalidated:
      return { eventName: 'NoncesInvalidated', severity: 'info', contract: 'OrderExecutor' }

    // Critical — admin operations
    case TOPICS.AdminTransferred:
      return { eventName: 'AdminTransferred', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.ExecutorChangeProposed:
      return { eventName: 'ExecutorChangeProposed', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.ExecutorChangeExecuted:
      return { eventName: 'ExecutorChangeExecuted', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.ExecutorChangeCancelled:
      return { eventName: 'ExecutorChangeCancelled', severity: 'warning', contract: 'OrderExecutor' }
    case TOPICS.ExecutorWhitelisted:
      return { eventName: 'ExecutorWhitelisted', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.RouterWhitelisted:
      return { eventName: 'RouterWhitelisted', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.TimelockQueued:
      return { eventName: 'TimelockQueued', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.TimelockExecuted:
      return { eventName: 'TimelockExecuted', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.TimelockCancelled:
      return { eventName: 'TimelockCancelled', severity: 'warning', contract: 'OrderExecutor' }
    case TOPICS.Paused:
      return { eventName: 'Paused', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.Unpaused:
      return { eventName: 'Unpaused', severity: 'critical', contract: 'OrderExecutor' }
    case TOPICS.OracleConfigured:
      return { eventName: 'OracleConfigured', severity: 'warning', contract: 'OrderExecutor' }
    case TOPICS.OwnershipTransferred:
      return { eventName: 'OwnershipTransferred', severity: 'critical', contract: 'OrderExecutor' }

    // Warning
    case TOPICS.SweepQueued:
      return { eventName: 'SweepQueued', severity: 'warning', contract: 'OrderExecutor' }
    case TOPICS.Bootstrap:
      return { eventName: 'Bootstrap', severity: 'warning', contract: 'OrderExecutor' }

    default:
      return null
  }
}

function classifyFeeCollectorEvent(topic0: string): EventClassification | null {
  switch (topic0) {
    case TOPICS.SwapWithFee:
      return { eventName: 'SwapWithFee', severity: 'info', contract: 'FeeCollector' }
    case TOPICS.SwapWithFeeV1:
      // [9B-I-01] V1 swap events tagged distinctly so dashboards can show
      // the wind-down separately from V2 traffic. Severity logic is identical
      // (info → warning when feeAmount >= 1 ETH, see maybeElevateFeeEvent).
      return { eventName: 'SwapWithFeeV1', severity: 'info', contract: 'FeeCollector' }
    case TOPICS.OwnershipTransferred:
      return { eventName: 'OwnershipTransferred', severity: 'critical', contract: 'FeeCollector' }
    default:
      return null
  }
}

// ── Large fee detection ──────────────────────────────────
// SwapWithFee feeAmount > 1 ETH (1e18 wei) elevates to warning

const LARGE_FEE_THRESHOLD = BigInt('1000000000000000000') // 1 ETH in wei

function maybeElevateFeeEvent(event: OnChainEvent, log: Log): OnChainEvent {
  if (event.eventName !== 'SwapWithFee' && event.eventName !== 'SwapWithFeeV1') return event
  try {
    // SwapWithFee data layout (shared by V1 and V2 for the first 3 slots):
    //   tokenIn (address), totalAmount (uint256), feeAmount (uint256)
    // V2 adds two more trailing slots (tokenOut, outputAmount) but they sit
    // after feeAmount, so the slice below is layout-agnostic.
    // Topics: [sig, user (indexed), router (indexed)]
    // Data: tokenIn (32 bytes) + totalAmount (32 bytes) + feeAmount (32 bytes) [+ V2: tokenOut (32) + outputAmount (32)]
    const data = log.data
    if (data.length >= 194) { // 0x + 3*64 chars = 194
      const feeHex = '0x' + data.slice(130, 194)
      const feeAmount = BigInt(feeHex)
      event.args.feeAmount = feeAmount.toString()
      if (feeAmount >= LARGE_FEE_THRESHOLD) {
        return { ...event, severity: 'warning' }
      }
    }
  } catch {
    // Parsing failed — keep as info
  }
  return event
}

// ── Constants ────────────────────────────────────────────

/** Max blocks per eth_getLogs call (prevents RPC timeout) */
const MAX_BLOCKS_PER_SCAN = 1000
/** KV key for last scanned block */
const LAST_BLOCK_KEY = 'teraswap:onchain:last-block'
/** KV key for recent critical events (7-day TTL) */
const CRITICAL_EVENTS_KEY = 'teraswap:onchain:critical-events'
const CRITICAL_EVENTS_TTL = 7 * 24 * 60 * 60
/** [P109] Tick-counter KV key — kept for telemetry continuity (existing
 *  dashboards graph the counter to detect a stalled monitoring worker).
 *  No longer used to gate execution; see shouldRunOnChainScan(). */
const ONCHAIN_TICK_COUNTER_KEY = 'teraswap:onchain:tick-counter'
/** [P109] Legacy modulo divisor — every tick now scans (M-05). Kept
 *  exported via `_internal` so downstream tooling that imports it for
 *  display purposes doesn't break, but the scan loop ignores it. */
const ONCHAIN_TICK_INTERVAL = 1

/** [P109] Process-scope cache of the highest block we've successfully
 *  scanned in this worker instance. Cold-start safe — when null we fall
 *  through to the KV-backed lastScannedBlock; when set we skip the
 *  eth_getLogs sweep if no new block has been mined since. Acceptable
 *  to lose on a Lambda cold start; the KV value catches us up. */
let lastScannedBlockInMemory: number | null = null

/** [10-L-04] KV key for the alert retry queue. AlertRetryEntry[]. */
const ALERT_RETRY_KEY = 'teraswap:onchain:alert-retry'
/** [10-L-04] KV key for the cumulative permanently-lost counter (monotonic). */
const ALERTS_LOST_TOTAL_KEY = 'teraswap:onchain:alerts-lost-total'
/** [10-L-04] Cap on attempts before an event is declared permanently lost. */
const MAX_ALERT_ATTEMPTS = 3
/** [10-L-04] Cap on retry-queue length so a runaway producer can't blow up KV. */
const MAX_RETRY_QUEUE_LENGTH = 256

// ── RPC client ───────────────────────────────────────────

function getServerClient(): PublicClient {
  const rpcUrl = process.env.RPC_URL
    || process.env.NEXT_PUBLIC_RPC_URL
    || 'https://eth.llamarpc.com'

  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  })
}

// ── Core scan ────────────────────────────────────────────

/**
 * Fetch and categorise events from both contracts within a block range.
 * Block range is automatically capped to MAX_BLOCKS_PER_SCAN.
 */
export async function scanContractEvents(
  fromBlock: number,
  toBlock: number,
  client: PublicClient,
): Promise<OnChainEvent[]> {
  // Cap range
  const effectiveTo = Math.min(toBlock, fromBlock + MAX_BLOCKS_PER_SCAN - 1)

  // Fetch logs from OrderExecutor + both FeeCollector versions in parallel.
  // V1 still emits Sweep on residual-balance recoveries even though no new
  // swaps route there; merging V1's logs into feeCollectorLogs keeps any
  // such admin actions visible to the classifier without changing downstream
  // classification logic (V1 and V2 share the SwapWithFee event signature).
  const [executorLogs, feeCollectorV2Logs, feeCollectorV1Logs] = await Promise.all([
    client.getLogs({
      address: ORDER_EXECUTOR_ADDRESS,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(effectiveTo),
    }),
    client.getLogs({
      address: FEE_COLLECTOR_ADDRESS,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(effectiveTo),
    }),
    client.getLogs({
      address: FEE_COLLECTOR_V1_ADDRESS,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(effectiveTo),
    }),
  ])
  const feeCollectorLogs = [...feeCollectorV2Logs, ...feeCollectorV1Logs]

  const events: OnChainEvent[] = []

  // Process OrderExecutor logs
  for (const log of executorLogs) {
    const topic0 = log.topics[0]
    if (!topic0) continue
    const classification = classifyOrderExecutorEvent(topic0)
    if (!classification) continue

    const event: OnChainEvent = {
      contract: classification.contract,
      eventName: classification.eventName,
      txHash: log.transactionHash ?? '',
      blockNumber: Number(log.blockNumber ?? 0),
      args: extractArgs(log),
      severity: classification.severity,
    }
    events.push(event)
  }

  // Process FeeCollector logs
  for (const log of feeCollectorLogs) {
    const topic0 = log.topics[0]
    if (!topic0) continue
    const classification = classifyFeeCollectorEvent(topic0)
    if (!classification) continue

    let event: OnChainEvent = {
      contract: classification.contract,
      eventName: classification.eventName,
      txHash: log.transactionHash ?? '',
      blockNumber: Number(log.blockNumber ?? 0),
      args: extractArgs(log),
      severity: classification.severity,
    }
    // Elevate large fee events
    event = maybeElevateFeeEvent(event, log)
    events.push(event)
  }

  return events
}

/** Extract indexed topics as args (best-effort, no full ABI decode) */
function extractArgs(log: Log): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  if (log.topics[1]) args.topic1 = log.topics[1]
  if (log.topics[2]) args.topic2 = log.topics[2]
  if (log.topics[3]) args.topic3 = log.topics[3]
  if (log.data && log.data !== '0x') args.data = log.data
  return args
}

// ── Alert routing ────────────────────────────────────────

/**
 * [10-L-04] Dispatch the appropriate alert for a single event.
 *
 * Throws on dispatch failure so the caller can track per-event
 * success/failure (the previous routeAlerts swallowed errors with a
 * console.error and the failure was invisible at the call site).
 * Info-severity events are no-ops (delivered=true).
 */
async function dispatchEventAlert(event: OnChainEvent): Promise<void> {
  if (event.severity === 'info') return

  if (event.severity === 'critical') {
    const reason = `on-chain-critical: ${event.contract}.${event.eventName} in tx ${event.txHash} (block ${event.blockNumber})`
    await emitTransitionAlert(
      `onchain-${event.contract.toLowerCase()}`,
      'active',
      'disabled',
      reason,
    )
    return
  }

  // warning
  const reason = `on-chain-warning: ${event.contract}.${event.eventName} in tx ${event.txHash} (block ${event.blockNumber})`
  await emitTransitionAlert(
    `onchain-${event.contract.toLowerCase()}`,
    'active',
    'degraded',
    reason,
  )
}

/**
 * [10-L-04] Dispatch alerts for a batch of events, returning per-event
 * outcome. Used by both the new-events path (in runOnChainScan) and the
 * retry-queue path (in processRetryQueue) so retry semantics stay
 * identical to first-attempt semantics.
 */
async function routeAlertsTracking(events: OnChainEvent[]): Promise<{
  delivered: OnChainEvent[]
  failed: OnChainEvent[]
}> {
  const delivered: OnChainEvent[] = []
  const failed: OnChainEvent[] = []

  for (const event of events) {
    if (event.severity === 'info') {
      delivered.push(event) // info isn't dispatched but is still considered "not blocking"
      continue
    }
    try {
      await dispatchEventAlert(event)
      delivered.push(event)
    } catch (err) {
      console.error(
        `[ONCHAIN] Alert dispatch failed for ${event.eventName} (${event.txHash}):`,
        err instanceof Error ? err.message : err,
      )
      failed.push(event)
    }
  }

  return { delivered, failed }
}

// ── KV persistence ───────────────────────────────────────

async function getLastScannedBlock(): Promise<number | null> {
  try {
    return await kv.get<number>(LAST_BLOCK_KEY)
  } catch {
    return null
  }
}

async function setLastScannedBlock(blockNumber: number): Promise<void> {
  try {
    await kv.set(LAST_BLOCK_KEY, blockNumber)
  } catch (err) {
    console.warn('[ONCHAIN] Failed to persist last scanned block:', err instanceof Error ? err.message : err)
  }
}

async function storeCriticalEvents(events: OnChainEvent[]): Promise<void> {
  const critical = events.filter(e => e.severity === 'critical' || e.severity === 'warning')
  if (critical.length === 0) return

  try {
    // Append to existing list (max 100 entries, FIFO)
    const existing = await kv.get<OnChainEvent[]>(CRITICAL_EVENTS_KEY) ?? []
    const updated = [...existing, ...critical].slice(-100)
    await kv.set(CRITICAL_EVENTS_KEY, updated, { ex: CRITICAL_EVENTS_TTL })
  } catch (err) {
    console.warn('[ONCHAIN] Failed to store critical events:', err instanceof Error ? err.message : err)
  }
}

// ── [10-L-04] Alert retry queue ──────────────────────────────
//
// The retry queue is a flat array stored under ALERT_RETRY_KEY. Entries
// carry their attempt count and first-failure timestamp so we can age
// out events that are stuck. On every tick the queue is drained first,
// before scanning new blocks — so a transient outage that resolves on
// tick N+1 delivers the alert immediately rather than waiting for the
// re-scan to find the event again.

async function readRetryQueue(): Promise<AlertRetryEntry[]> {
  try {
    const raw = await kv.get<unknown>(ALERT_RETRY_KEY)
    // Defensive: a stale KV record or a misconfigured environment could
    // return something other than the array shape. Treat anything that
    // isn't an array as empty rather than letting `for...of` crash.
    if (!Array.isArray(raw)) return []
    return raw as AlertRetryEntry[]
  } catch (err) {
    console.warn(
      '[ONCHAIN] Retry queue read failed (treating as empty):',
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

async function writeRetryQueue(queue: AlertRetryEntry[]): Promise<void> {
  // Cap at MAX_RETRY_QUEUE_LENGTH so a runaway producer can't blow up KV.
  const capped = queue.slice(-MAX_RETRY_QUEUE_LENGTH)
  try {
    if (capped.length === 0) {
      await kv.set(ALERT_RETRY_KEY, [])
    } else {
      await kv.set(ALERT_RETRY_KEY, capped)
    }
  } catch (err) {
    console.warn(
      '[ONCHAIN] Retry queue write failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

async function incrementAlertsLost(by: number): Promise<void> {
  if (by <= 0) return
  try {
    // kv.incr is atomic; loop the increment when we need >1 (small N
    // here — typically 1 at a time as events age out).
    for (let i = 0; i < by; i++) {
      await kv.incr(ALERTS_LOST_TOTAL_KEY)
    }
  } catch (err) {
    console.warn(
      '[ONCHAIN] alerts_lost_total increment failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * [10-L-04] Drain the retry queue: re-attempt each entry, drop on success,
 * bump attempts on failure, mark permanently lost when attempts hit the cap.
 *
 * Returns `{ delivered, permanentlyLost, stillPending }` for telemetry; the
 * queue itself is persisted back to KV with only stillPending entries.
 */
async function processRetryQueue(): Promise<{
  delivered: number
  permanentlyLost: number
  stillPending: number
}> {
  const queue = await readRetryQueue()
  if (queue.length === 0) return { delivered: 0, permanentlyLost: 0, stillPending: 0 }

  let delivered = 0
  let permanentlyLost = 0
  const stillPending: AlertRetryEntry[] = []

  for (const entry of queue) {
    try {
      await dispatchEventAlert(entry.event)
      delivered++
    } catch (err) {
      const nextAttempts = entry.attempts + 1
      if (nextAttempts >= MAX_ALERT_ATTEMPTS) {
        // Give up. Log + increment metric; do NOT add back to queue so
        // the system can advance past this event.
        console.error(
          `[ONCHAIN] alerts_lost_total ++ — event permanently lost after ${nextAttempts} attempts: ` +
            `${entry.event.contract}.${entry.event.eventName} tx=${entry.event.txHash} ` +
            `block=${entry.event.blockNumber} firstFailedAt=${entry.firstFailedAt} ` +
            `lastErr=${err instanceof Error ? err.message : String(err)}`,
        )
        permanentlyLost++
      } else {
        stillPending.push({ ...entry, attempts: nextAttempts })
      }
    }
  }

  await writeRetryQueue(stillPending)
  if (permanentlyLost > 0) await incrementAlertsLost(permanentlyLost)

  return { delivered, permanentlyLost, stillPending: stillPending.length }
}

/**
 * [10-L-04] Append this tick's failed events to the retry queue. Each
 * failure starts at `attempts: 1` (this dispatch counts as attempt #1).
 * Entries are de-duped by (txHash, eventName, blockNumber) so a re-scan
 * of the same block range doesn't double-stack the same event.
 */
async function enqueueFailedAlerts(failures: OnChainEvent[]): Promise<void> {
  if (failures.length === 0) return
  const existing = await readRetryQueue()
  const key = (e: OnChainEvent) => `${e.txHash}|${e.eventName}|${e.blockNumber}`
  const existingKeys = new Set(existing.map(en => key(en.event)))
  const now = new Date().toISOString()
  const additions: AlertRetryEntry[] = failures
    .filter(e => !existingKeys.has(key(e)))
    .map(event => ({ event, attempts: 1, firstFailedAt: now }))

  if (additions.length === 0) return
  await writeRetryQueue([...existing, ...additions])
}

// ── Tick cadence ─────────────────────────────────────────

/**
 * [P109/M-05] Should this tick run an on-chain scan?
 *
 * Always returns `true` — the Cloudflare Worker cron fires at 60 s and
 * we want every tick to surface admin events. The previous every-5th
 * gating delayed critical-event detection (AdminTransferred, Paused,
 * OwnershipTransferred, RouterWhitelisted) by up to 5 minutes.
 *
 * RPC cost is bounded inside `runOnChainScan()` by the in-memory
 * `lastScannedBlockInMemory` fast-path: when `eth_blockNumber` returns
 * a value we've already scanned, the function short-circuits without
 * issuing `eth_getLogs`. The KV tick counter is still incremented so
 * dashboards graphing cadence continuity keep working.
 */
export async function shouldRunOnChainScan(): Promise<boolean> {
  try {
    // Best-effort telemetry increment; failure is non-fatal.
    await kv.incr(ONCHAIN_TICK_COUNTER_KEY)
  } catch (err) {
    console.warn('[ONCHAIN] Tick counter KV increment failed (continuing):', err instanceof Error ? err.message : err)
  }
  return true
}

// ── Main entry point ─────────────────────────────────────

/**
 * Run one on-chain scan cycle. Called by runMonitoringTick() every 5th tick.
 *
 * 1. Drain the alert retry queue (re-attempt prior failures) [10-L-04]
 * 2. Read last scanned block from KV
 * 3. Get current block from RPC
 * 4. Scan events (capped to MAX_BLOCKS_PER_SCAN)
 * 5. Dispatch alerts per-event, tracking success/failure
 * 6. Enqueue failed alerts for retry on subsequent ticks
 * 7. Persist critical-events audit trail (independent of advancement)
 * 8. Advance lastScannedBlock ONLY when every non-info event delivered.
 *    KV failure for the audit trail does NOT block advancement (the
 *    alert was already delivered) — see quality criterion 3 on [10-L-04].
 */
export async function runOnChainScan(): Promise<OnChainScanResult | null> {
  // ── 1. Drain retry queue first ─────────────────────────────
  // If an alert that failed N ticks ago succeeds now, we want to
  // deliver it before chewing RPC budget on new blocks. Failures here
  // bump the per-entry attempt count; events that hit MAX_ALERT_ATTEMPTS
  // are dropped + alerts_lost_total++.
  const retryResult = await processRetryQueue()

  let client: PublicClient
  try {
    client = getServerClient()
  } catch (err) {
    console.error('[ONCHAIN] RPC client init failed:', err instanceof Error ? err.message : err)
    return null
  }

  // Get current block
  let currentBlock: number
  try {
    const blockBn = await client.getBlockNumber()
    currentBlock = Number(blockBn)
  } catch (err) {
    console.error('[ONCHAIN] Failed to get current block:', err instanceof Error ? err.message : err)
    return null
  }

  // [P109] In-memory fast-path: if we already scanned `currentBlock` in
  // this process, the only "new" thing this tick could deliver is what
  // already lives in the retry queue (drained above). Skip the KV read
  // and the eth_getLogs sweep entirely. Cold-start safe — the cache is
  // null on first call and we fall through to the KV-backed value.
  if (lastScannedBlockInMemory !== null && currentBlock <= lastScannedBlockInMemory) {
    return {
      fromBlock: lastScannedBlockInMemory + 1,
      toBlock: currentBlock,
      eventsFound: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      ...(retryResult.permanentlyLost > 0 ? { permanentlyLost: retryResult.permanentlyLost } : {}),
      ...(retryResult.delivered > 0 ? { retriesDelivered: retryResult.delivered } : {}),
    }
  }

  // Determine scan range
  const lastScanned = await getLastScannedBlock()
  const fromBlock = lastScanned != null ? lastScanned + 1 : currentBlock - 100 // First run: scan last 100 blocks

  if (fromBlock > currentBlock) {
    // No new blocks since last scan — but the retry queue may have done
    // useful work; surface that on the result so the monitoring tick log
    // line still reflects what happened.
    return {
      fromBlock,
      toBlock: currentBlock,
      eventsFound: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      ...(retryResult.permanentlyLost > 0 ? { permanentlyLost: retryResult.permanentlyLost } : {}),
      ...(retryResult.delivered > 0 ? { retriesDelivered: retryResult.delivered } : {}),
    }
  }

  // Cap to MAX_BLOCKS_PER_SCAN — remaining blocks will be scanned next tick
  const toBlock = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_SCAN - 1)

  // Scan
  let events: OnChainEvent[]
  try {
    events = await scanContractEvents(fromBlock, toBlock, client)
  } catch (err) {
    // RPC failure → do NOT advance last-block (retry next tick)
    console.error('[ONCHAIN] eth_getLogs failed:', err instanceof Error ? err.message : err)
    return null
  }

  // ── 5. Dispatch alerts per-event with success tracking ────
  const { delivered: _deliveredEvents, failed: failedEvents } = await routeAlertsTracking(events)

  // ── 6. Push failures to the retry queue ───────────────────
  // Filter out info-severity (dispatchEventAlert is a no-op for info, so
  // failed won't contain info, but keep the filter as a defensive belt).
  const failuresToRetry = failedEvents.filter(e => e.severity !== 'info')
  if (failuresToRetry.length > 0) {
    await enqueueFailedAlerts(failuresToRetry)
  }

  // ── 7. Persist audit trail (independent of advancement) ───
  // This is the only path that writes to CRITICAL_EVENTS_KEY; KV failure
  // here logs a warn but does NOT prevent block advancement, per
  // [10-L-04] quality criterion: "Alert succeeds + KV fails → block
  // advanced (alert was delivered)".
  await storeCriticalEvents(events)

  // ── 8. Gated block advancement ────────────────────────────
  // Block advances only when every non-info event delivered. A single
  // critical or warning failure holds the range back; next tick re-scans
  // and `emitTransitionAlert`'s grace-period dedup prevents duplicate
  // Telegram messages for the events that DID deliver this round.
  const blockAdvanceHeld = failuresToRetry.length > 0
  if (!blockAdvanceHeld) {
    await setLastScannedBlock(toBlock)
    // [P109] Update the in-memory fast-path cache so the next tick can
    // short-circuit without re-reading KV. We only update on full
    // success (no retry-held block) so the next tick still re-scans the
    // problem range when something was held back.
    lastScannedBlockInMemory = toBlock
  } else {
    console.warn(
      `[ONCHAIN] Holding lastScannedBlock at ${lastScanned ?? 'unset'} — ${failuresToRetry.length} alert(s) failed; ` +
        `events queued for retry (max ${MAX_ALERT_ATTEMPTS} attempts each).`,
    )
  }

  const criticalCount = events.filter(e => e.severity === 'critical').length
  const warningCount = events.filter(e => e.severity === 'warning').length
  const infoCount = events.filter(e => e.severity === 'info').length

  if (criticalCount > 0) {
    console.error(`[ONCHAIN] ${criticalCount} CRITICAL events in blocks ${fromBlock}–${toBlock}`)
  }
  if (warningCount > 0) {
    console.warn(`[ONCHAIN] ${warningCount} warning events in blocks ${fromBlock}–${toBlock}`)
  }

  return {
    fromBlock,
    toBlock,
    eventsFound: events.length,
    criticalCount,
    warningCount,
    infoCount,
    ...(blockAdvanceHeld ? { blockAdvanceHeld: true } : {}),
    ...(retryResult.permanentlyLost > 0 ? { permanentlyLost: retryResult.permanentlyLost } : {}),
    ...(retryResult.delivered > 0 ? { retriesDelivered: retryResult.delivered } : {}),
  }
}

// ── Exported for tests ───────────────────────────────────

/** [P109] Reset the in-memory fast-path cache. Test-only — do not
 *  call from production code. */
export function _resetLastScannedBlockCache(): void {
  lastScannedBlockInMemory = null
}

export const _internal = {
  TOPICS,
  MAX_BLOCKS_PER_SCAN,
  LAST_BLOCK_KEY,
  ONCHAIN_TICK_INTERVAL,
  classifyOrderExecutorEvent,
  classifyFeeCollectorEvent,
  maybeElevateFeeEvent,
  LARGE_FEE_THRESHOLD,
  // [10-L-04] retry-queue internals
  ALERT_RETRY_KEY,
  ALERTS_LOST_TOTAL_KEY,
  MAX_ALERT_ATTEMPTS,
  MAX_RETRY_QUEUE_LENGTH,
  processRetryQueue,
  enqueueFailedAlerts,
  // [P109] in-memory cache reset
  resetLastScannedBlockCache: _resetLastScannedBlockCache,
} as const
