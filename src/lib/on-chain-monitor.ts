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
 * Runs every 5th monitoring tick (~5 min) via shouldRunOnChainScan().
 *
 * @internal — server-only module. Called by runMonitoringTick().
 */

import { createPublicClient, http, keccak256, toBytes, type PublicClient, type Log } from 'viem'
import { mainnet } from 'viem/chains'
import { kv } from '@/lib/kv'
import { FEE_COLLECTOR_ADDRESS } from './constants'
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
  SwapWithFee: topic('SwapWithFee(address,address,address,uint256,uint256)'),
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
  if (event.eventName !== 'SwapWithFee') return event
  try {
    // SwapWithFee data layout: tokenIn (address), totalAmount (uint256), feeAmount (uint256)
    // Topics: [sig, user (indexed), router (indexed)]
    // Data: tokenIn (32 bytes) + totalAmount (32 bytes) + feeAmount (32 bytes)
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
/** KV tick counter for every-5th-tick cadence */
const ONCHAIN_TICK_COUNTER_KEY = 'teraswap:onchain:tick-counter'
const ONCHAIN_TICK_INTERVAL = 5

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

  // Fetch logs from both contracts in parallel
  const [executorLogs, feeCollectorLogs] = await Promise.all([
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
  ])

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

async function routeAlerts(events: OnChainEvent[]): Promise<void> {
  for (const event of events) {
    if (event.severity === 'info') {
      // Info: KV only (logged in storeCriticalEvents, no Telegram)
      continue
    }

    if (event.severity === 'critical') {
      // Critical: P0 full fan-out
      const reason = `on-chain-critical: ${event.contract}.${event.eventName} in tx ${event.txHash} (block ${event.blockNumber})`
      try {
        await emitTransitionAlert(
          `onchain-${event.contract.toLowerCase()}`,
          'active',
          'disabled',
          reason,
        )
      } catch (err) {
        console.error(`[ONCHAIN] Alert emission failed for ${event.eventName}:`, err instanceof Error ? err.message : err)
      }
    } else if (event.severity === 'warning') {
      // Warning: Telegram only (via transition alert with non-P0 reason)
      const reason = `on-chain-warning: ${event.contract}.${event.eventName} in tx ${event.txHash} (block ${event.blockNumber})`
      try {
        await emitTransitionAlert(
          `onchain-${event.contract.toLowerCase()}`,
          'active',
          'degraded',
          reason,
        )
      } catch (err) {
        console.error(`[ONCHAIN] Warning alert failed for ${event.eventName}:`, err instanceof Error ? err.message : err)
      }
    }
  }
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

// ── Tick cadence ─────────────────────────────────────────

/**
 * Should this tick run an on-chain scan?
 * Runs every 5th tick (same cadence as quorum, separate counter).
 */
export async function shouldRunOnChainScan(): Promise<boolean> {
  try {
    const count = await kv.incr(ONCHAIN_TICK_COUNTER_KEY)
    return count % ONCHAIN_TICK_INTERVAL === 0
  } catch (err) {
    console.warn('[ONCHAIN] Tick counter KV failed, skipping:', err instanceof Error ? err.message : err)
    return false
  }
}

// ── Main entry point ─────────────────────────────────────

/**
 * Run one on-chain scan cycle. Called by runMonitoringTick() every 5th tick.
 *
 * 1. Read last scanned block from KV
 * 2. Get current block from RPC
 * 3. Scan events (capped to MAX_BLOCKS_PER_SCAN)
 * 4. Route alerts by severity
 * 5. Persist last scanned block (only on success)
 */
export async function runOnChainScan(): Promise<OnChainScanResult | null> {
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

  // Determine scan range
  const lastScanned = await getLastScannedBlock()
  const fromBlock = lastScanned != null ? lastScanned + 1 : currentBlock - 100 // First run: scan last 100 blocks

  if (fromBlock > currentBlock) {
    // No new blocks since last scan
    return { fromBlock, toBlock: currentBlock, eventsFound: 0, criticalCount: 0, warningCount: 0, infoCount: 0 }
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

  // Route alerts + persist
  await Promise.allSettled([
    routeAlerts(events),
    storeCriticalEvents(events),
  ])

  // Advance last scanned block ONLY on success
  await setLastScannedBlock(toBlock)

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
  }
}

// ── Exported for tests ───────────────────────────────────

export const _internal = {
  TOPICS,
  MAX_BLOCKS_PER_SCAN,
  LAST_BLOCK_KEY,
  ONCHAIN_TICK_INTERVAL,
  classifyOrderExecutorEvent,
  classifyFeeCollectorEvent,
  maybeElevateFeeEvent,
  LARGE_FEE_THRESHOLD,
} as const
