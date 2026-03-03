/**
 * TeraSwap DCA Engine
 *
 * Client-side Dollar Cost Averaging engine with smart buying windows.
 * Persists state to localStorage. Requires browser to be open for
 * window monitoring and execution.
 *
 * Future: own smart contracts for fully autonomous execution.
 */

import {
  type DCAConfig,
  type DCAPosition,
  type DCAExecution,
  type DCAEvent,
  type DCAToken,
  type SmartWindowSnapshot,
  type ExecutionStatus,
  type WindowStatus,
  DCA_STORAGE_KEY,
  WINDOW_OPEN_RATIO,
  DIP_THRESHOLD_PERCENT,
  PRICE_POLL_INTERVAL_MS,
  HISTORICAL_PRICE_AGE_S,
} from './dca-types'
import { fetchChainlinkPriceRaw, fetchHistoricalPrice } from './chainlink'
import { fetchMetaQuote, fetchSwapFromSource, fetchApproveSpender } from './api'
import { DEFAULT_SLIPPAGE } from './constants'

// ══════════════════════════════════════════════════════════
//  ENGINE STATE
// ══════════════════════════════════════════════════════════

let positions: DCAPosition[] = []
const listeners = new Set<(event: DCAEvent) => void>()
let monitoringTimers = new Map<string, ReturnType<typeof setInterval>>()
let tickTimer: ReturnType<typeof setInterval> | null = null

// ── Event emitter ────────────────────────────────────────

export function subscribe(listener: (event: DCAEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: DCAEvent) {
  listeners.forEach(fn => fn(event))
}

// ══════════════════════════════════════════════════════════
//  PERSISTENCE
// ══════════════════════════════════════════════════════════

function persist() {
  try {
    localStorage.setItem(DCA_STORAGE_KEY, JSON.stringify(positions))
  } catch { /* quota exceeded — silent */ }
}

export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(DCA_STORAGE_KEY)
    if (raw) {
      positions = JSON.parse(raw) as DCAPosition[]
    }
  } catch {
    positions = []
  }
}

// ══════════════════════════════════════════════════════════
//  POSITION MANAGEMENT
// ══════════════════════════════════════════════════════════

function generateId(): string {
  return `dca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function getAllPositions(): DCAPosition[] {
  return positions
}

export function getPosition(id: string): DCAPosition | null {
  return positions.find(p => p.config.id === id) ?? null
}

/**
 * Create a new DCA position with pre-computed execution schedule.
 */
export function createPosition(
  tokenIn: DCAToken,
  tokenOut: DCAToken,
  totalAmount: string,
  numberOfParts: number,
  intervalMs: number,
  slippage: number = DEFAULT_SLIPPAGE,
): DCAPosition {
  const id = generateId()
  const now = Date.now()

  // Calculate amount per part (integer division)
  const total = BigInt(totalAmount)
  const perPart = total / BigInt(numberOfParts)
  const amountPerPart = perPart.toString()

  const config: DCAConfig = {
    id,
    tokenIn,
    tokenOut,
    totalAmount,
    numberOfParts,
    intervalMs,
    amountPerPart,
    slippage,
    createdAt: now,
  }

  // Pre-schedule all executions
  // First execution: immediate (window opens now)
  // Subsequent: first + (index × interval)
  const firstBuyTime = now + intervalMs // first buy after one interval
  const executions: DCAExecution[] = Array.from({ length: numberOfParts }, (_, i) => {
    const scheduledTime = firstBuyTime + i * intervalMs
    const windowDuration = intervalMs * WINDOW_OPEN_RATIO
    const windowOpenTime = scheduledTime - windowDuration

    return {
      id: `${id}_exec_${i}`,
      positionId: id,
      index: i,
      amountIn: amountPerPart,
      scheduledTime,
      windowOpenTime,
      windowCloseTime: scheduledTime,
      priceAtWindowOpen: null,
      priceYesterday: null,
      targetDipPrice: null,
      status: 'scheduled' as ExecutionStatus,
      windowStatus: 'pending' as WindowStatus,
      executionReason: null,
      executedAt: null,
      amountOut: null,
      txHash: null,
      source: null,
      error: null,
    }
  })

  const position: DCAPosition = {
    config,
    executions,
    status: 'active',
    totalExecuted: 0,
    totalSpent: '0',
    totalReceived: '0',
    averagePriceUsd: null,
    startedAt: now,
    pausedAt: null,
    completedAt: null,
  }

  positions.push(position)
  persist()
  emit({ type: 'position_created', positionId: id })

  // Start the global tick if not running
  startGlobalTick()

  return position
}

export function pausePosition(id: string) {
  const pos = getPosition(id)
  if (!pos || pos.status !== 'active') return

  pos.status = 'paused'
  pos.pausedAt = Date.now()

  // Stop any active monitoring for this position
  stopMonitoring(id)

  persist()
  emit({ type: 'position_paused', positionId: id })
}

export function resumePosition(id: string) {
  const pos = getPosition(id)
  if (!pos || pos.status !== 'paused') return

  pos.status = 'active'
  pos.pausedAt = null

  // Reschedule any missed windows
  const now = Date.now()
  for (const exec of pos.executions) {
    if (exec.status === 'scheduled' && exec.windowCloseTime < now) {
      // Window was missed during pause — mark for immediate execution
      exec.windowOpenTime = now
      exec.windowCloseTime = now + 60_000 // 1 minute grace window
    }
  }

  persist()
  emit({ type: 'position_resumed', positionId: id })
  startGlobalTick()
}

export function cancelPosition(id: string) {
  const pos = getPosition(id)
  if (!pos) return

  pos.status = 'cancelled'
  stopMonitoring(id)

  // Mark all pending executions as skipped
  for (const exec of pos.executions) {
    if (exec.status === 'scheduled' || exec.status === 'window_open') {
      exec.status = 'skipped'
      exec.windowStatus = 'closed'
    }
  }

  persist()
  emit({ type: 'position_cancelled', positionId: id })
}

// ══════════════════════════════════════════════════════════
//  GLOBAL TICK — checks windows every 30s
// ══════════════════════════════════════════════════════════

export function startGlobalTick() {
  if (tickTimer) return // already running

  tickTimer = setInterval(() => {
    checkWindows()
  }, 30_000) // check every 30s

  // Also run immediately
  checkWindows()
}

export function stopGlobalTick() {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  // Stop all monitoring
  monitoringTimers.forEach((timer) => clearInterval(timer))
  monitoringTimers.clear()
}

function stopMonitoring(positionId: string) {
  const keys = [...monitoringTimers.keys()].filter(k => k.startsWith(positionId))
  for (const key of keys) {
    clearInterval(monitoringTimers.get(key)!)
    monitoringTimers.delete(key)
  }
}

/**
 * Check all active positions for windows that should open.
 */
function checkWindows() {
  const now = Date.now()

  for (const pos of positions) {
    if (pos.status !== 'active') continue

    for (const exec of pos.executions) {
      if (exec.status !== 'scheduled') continue

      // Should this window open now?
      if (now >= exec.windowOpenTime) {
        openSmartWindow(pos, exec)
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
//  SMART WINDOW — price monitoring & execution logic
// ══════════════════════════════════════════════════════════

async function openSmartWindow(position: DCAPosition, execution: DCAExecution) {
  const monitorKey = `${position.config.id}_${execution.index}`

  // Prevent duplicate monitoring
  if (monitoringTimers.has(monitorKey)) return

  execution.status = 'window_open'
  execution.windowStatus = 'active'
  persist()

  emit({
    type: 'window_opened',
    positionId: position.config.id,
    executionIndex: execution.index,
  })

  // Fetch price context
  try {
    const currentData = await fetchChainlinkPriceRaw(position.config.tokenOut.address)
    if (currentData) {
      execution.priceAtWindowOpen = currentData.price
      execution.targetDipPrice = currentData.price * (1 - DIP_THRESHOLD_PERCENT)
    }

    const historical = await fetchHistoricalPrice(
      position.config.tokenOut.address,
      HISTORICAL_PRICE_AGE_S,
    )
    if (historical) {
      execution.priceYesterday = historical.price
    }

    persist()
  } catch {
    // Price fetch failed — will execute at window close
  }

  // Check immediately if price already below yesterday
  if (execution.priceYesterday !== null && execution.priceAtWindowOpen !== null) {
    if (execution.priceAtWindowOpen < execution.priceYesterday) {
      execution.executionReason = 'price_below_yesterday'
      execution.windowStatus = 'closed'
      triggerExecution(position, execution)
      return
    }
  }

  // Start monitoring loop
  execution.windowStatus = 'monitoring'
  persist()

  const timer = setInterval(async () => {
    if (position.status !== 'active' || execution.status !== 'window_open') {
      clearInterval(timer)
      monitoringTimers.delete(monitorKey)
      return
    }

    const now = Date.now()

    try {
      const priceData = await fetchChainlinkPriceRaw(position.config.tokenOut.address)
      if (!priceData) return

      const currentPrice = priceData.price

      // Emit snapshot for UI
      const snapshot: SmartWindowSnapshot = {
        positionId: position.config.id,
        executionIndex: execution.index,
        windowStatus: execution.windowStatus,
        priceAtWindowOpen: execution.priceAtWindowOpen,
        priceYesterday: execution.priceYesterday,
        currentPrice,
        targetDipPrice: execution.targetDipPrice,
        percentFromTarget: execution.targetDipPrice
          ? ((currentPrice - execution.targetDipPrice) / execution.targetDipPrice) * 100
          : null,
        timeRemainingMs: Math.max(0, execution.windowCloseTime - now),
        reason: getWindowStatusText(execution, currentPrice, now),
      }

      emit({
        type: 'price_update',
        positionId: position.config.id,
        executionIndex: execution.index,
        snapshot,
      })

      // Decision logic
      if (execution.priceYesterday !== null && currentPrice < execution.priceYesterday) {
        // Price dropped below yesterday → buy immediately
        clearInterval(timer)
        monitoringTimers.delete(monitorKey)
        execution.executionReason = 'price_below_yesterday'
        execution.windowStatus = 'closed'
        triggerExecution(position, execution)
        return
      }

      if (execution.targetDipPrice !== null && currentPrice <= execution.targetDipPrice) {
        // 0.3% dip achieved → buy
        clearInterval(timer)
        monitoringTimers.delete(monitorKey)
        execution.executionReason = 'dip_achieved'
        execution.windowStatus = 'closed'
        triggerExecution(position, execution)
        return
      }

      if (now >= execution.windowCloseTime) {
        // Window expired → forced execution
        clearInterval(timer)
        monitoringTimers.delete(monitorKey)
        execution.executionReason = 'window_expired'
        execution.windowStatus = 'closed'
        triggerExecution(position, execution)
        return
      }
    } catch {
      // Price fetch error — continue monitoring, don't abort
    }
  }, PRICE_POLL_INTERVAL_MS)

  monitoringTimers.set(monitorKey, timer)
}

function getWindowStatusText(
  exec: DCAExecution,
  currentPrice: number,
  now: number,
): string {
  if (exec.priceYesterday !== null && currentPrice < exec.priceYesterday) {
    return `Price below yesterday ($${exec.priceYesterday.toFixed(2)}) — buying now`
  }
  if (exec.targetDipPrice !== null) {
    const diff = ((currentPrice - exec.targetDipPrice) / exec.targetDipPrice * 100).toFixed(2)
    const remaining = Math.max(0, Math.ceil((exec.windowCloseTime - now) / 60_000))
    return `Waiting for 0.3% dip: $${currentPrice.toFixed(2)} → target $${exec.targetDipPrice.toFixed(2)} (${diff}% away) · ${remaining}min left`
  }
  return 'Monitoring prices...'
}

// ══════════════════════════════════════════════════════════
//  EXECUTION — calls meta-aggregator for best price
// ══════════════════════════════════════════════════════════

/** Callback for wallet transaction signing — set by the React hook */
let sendTransactionFn: ((params: {
  to: `0x${string}`
  data: `0x${string}`
  value: string
  gas: number
}) => Promise<string>) | null = null

let signCowOrderFn: ((params: {
  orderParams: any
}) => Promise<string>) | null = null

let userAddressFn: (() => string | undefined) | null = null

/**
 * Register wallet interaction callbacks from the React layer.
 * Called by useDCAEngine hook on mount.
 */
export function registerWalletCallbacks(callbacks: {
  sendTransaction: typeof sendTransactionFn
  signCowOrder: typeof signCowOrderFn
  getUserAddress: typeof userAddressFn
}) {
  sendTransactionFn = callbacks.sendTransaction
  signCowOrderFn = callbacks.signCowOrder
  userAddressFn = callbacks.getUserAddress
}

async function triggerExecution(position: DCAPosition, execution: DCAExecution) {
  const from = userAddressFn?.()
  if (!from) {
    execution.status = 'failed'
    execution.error = 'Wallet not connected'
    persist()
    emit({
      type: 'execution_failed',
      positionId: position.config.id,
      executionIndex: execution.index,
      error: 'Wallet not connected',
    })
    return
  }

  execution.status = 'executing'
  persist()
  emit({
    type: 'execution_started',
    positionId: position.config.id,
    executionIndex: execution.index,
  })

  try {
    // Step 1: Get best quote from all 11 sources
    const metaQuote = await fetchMetaQuote(
      position.config.tokenIn.address,
      position.config.tokenOut.address,
      execution.amountIn,
      position.config.tokenIn.decimals,
      position.config.tokenOut.decimals,
    )

    const bestSource = metaQuote.best.source

    // Step 2: Build swap transaction
    const swap = await fetchSwapFromSource(
      bestSource,
      position.config.tokenIn.address,
      position.config.tokenOut.address,
      execution.amountIn,
      from,
      position.config.slippage,
      position.config.tokenIn.decimals,
      position.config.tokenOut.decimals,
      metaQuote.best.meta,
    )

    execution.source = bestSource

    // Step 3: Execute
    if (!swap.tx && bestSource === 'cowswap') {
      // CoW Protocol: sign EIP-712 order
      if (!signCowOrderFn) throw new Error('CoW signing not available')

      execution.status = 'awaiting_sig'
      persist()
      emit({
        type: 'awaiting_signature',
        positionId: position.config.id,
        executionIndex: execution.index,
      })

      const txHash = await signCowOrderFn({ orderParams: (swap as any).cowOrderParams })
      execution.txHash = txHash
    } else if (swap.tx) {
      // Standard swap: send transaction
      if (!sendTransactionFn) throw new Error('Transaction sending not available')

      execution.status = 'awaiting_sig'
      persist()
      emit({
        type: 'awaiting_signature',
        positionId: position.config.id,
        executionIndex: execution.index,
      })

      const txHash = await sendTransactionFn({
        to: swap.tx.to,
        data: swap.tx.data,
        value: swap.tx.value,
        gas: swap.tx.gas,
      })
      execution.txHash = txHash
    } else {
      throw new Error(`No transaction data from ${bestSource}`)
    }

    // Step 4: Mark success
    execution.status = 'executed'
    execution.executedAt = Date.now()
    execution.amountOut = swap.toAmount

    // Update position aggregates
    position.totalExecuted++
    position.totalSpent = (BigInt(position.totalSpent) + BigInt(execution.amountIn)).toString()
    if (execution.amountOut) {
      position.totalReceived = (BigInt(position.totalReceived) + BigInt(execution.amountOut)).toString()
    }

    // Check if position is complete
    if (position.totalExecuted >= position.config.numberOfParts) {
      position.status = 'completed'
      position.completedAt = Date.now()
      emit({ type: 'position_completed', positionId: position.config.id })
    }

    persist()
    emit({
      type: 'execution_success',
      positionId: position.config.id,
      executionIndex: execution.index,
      txHash: execution.txHash || '',
    })
  } catch (err) {
    execution.status = 'failed'
    execution.error = err instanceof Error ? err.message : String(err)
    persist()
    emit({
      type: 'execution_failed',
      positionId: position.config.id,
      executionIndex: execution.index,
      error: execution.error,
    })
  }
}

// ══════════════════════════════════════════════════════════
//  GET NEXT EXECUTION INFO (for UI)
// ══════════════════════════════════════════════════════════

export function getNextExecution(positionId: string): DCAExecution | null {
  const pos = getPosition(positionId)
  if (!pos) return null
  return pos.executions.find(e =>
    e.status === 'scheduled' || e.status === 'window_open' || e.status === 'executing' || e.status === 'awaiting_sig'
  ) ?? null
}

export function getActiveSnapshots(): SmartWindowSnapshot[] {
  const snapshots: SmartWindowSnapshot[] = []
  for (const pos of positions) {
    if (pos.status !== 'active') continue
    for (const exec of pos.executions) {
      if (exec.windowStatus === 'monitoring' || exec.windowStatus === 'active') {
        snapshots.push({
          positionId: pos.config.id,
          executionIndex: exec.index,
          windowStatus: exec.windowStatus,
          priceAtWindowOpen: exec.priceAtWindowOpen,
          priceYesterday: exec.priceYesterday,
          currentPrice: null, // filled by live monitoring
          targetDipPrice: exec.targetDipPrice,
          percentFromTarget: null,
          timeRemainingMs: Math.max(0, exec.windowCloseTime - Date.now()),
          reason: 'Monitoring...',
        })
      }
    }
  }
  return snapshots
}
