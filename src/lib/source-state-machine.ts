/**
 * @internal — server-only module.
 *
 * DO NOT import from:
 *   - any file under src/app/(client)/
 *   - any React component
 *   - any 'use client' directive file
 *
 * forceDisable() and forceActivate() MUST only be invoked from:
 *   - monitoring-loop.ts (automatic transitions)
 *   - API routes with explicit authentication (CRON_SECRET, admin session, etc.)
 *
 * Exposing these as an unauthenticated endpoint creates a denial-of-service
 * vector and, in the case of forceActivate, a bypass of H2 kill-switch protection.
 *
 * State is persisted to Vercel KV (Upstash Redis) to survive serverless cold starts.
 * Key scheme:
 *   teraswap:source-state:{sourceId} — JSON SourceStatus, no TTL
 *   teraswap:source-state:index     — Redis SET of all known source IDs
 */

import { kv } from '@vercel/kv'

// ── Types ───────────────────────────────────────────────

export type SourceState = 'active' | 'degraded' | 'disabled'

export interface SourceStatus {
  id: string
  state: SourceState
  lastCheckAt: number
  failureCount: number
  successCount: number
  latencyHistory: number[]
  disabledReason?: string
  disabledAt?: number
  lastTransitionAt: number
}

export interface HealthCheckResult {
  ok: boolean
  latencyMs: number
  error?: string
}

// ── Critical reasons that block auto-recovery ───────────

const P0_REASONS = new Set([
  'tls-fingerprint-change',
  'dns-record-change',
  'kill-switch-triggered',
])

// ── Thresholds ──────────────────────────────────────────

const FAILURE_TO_DEGRADED = 3
const FAILURE_TO_DISABLED = 5
const SUCCESS_TO_ACTIVE = 3
const P95_DEGRADED_THRESHOLD = 5000
const P95_RECOVERY_THRESHOLD = 2000
const AUTO_RECOVERY_MS = 10 * 60_000
const MAX_LATENCY_HISTORY = 10

// ── KV key helpers ──────────────────────────────────────

const KEY_PREFIX = 'teraswap:source-state:'
const INDEX_KEY = 'teraswap:source-state:index'

function stateKey(id: string): string {
  return `${KEY_PREFIX}${id}`
}

// ── Per-tick in-memory cache ────────────────────────────
// Populated on first read per-id per tick. Cleared by beginTick().
// Writes go through to KV immediately AND update the cache.

const tickCache = new Map<string, SourceStatus>()

/** Call at the start of each monitoring tick to invalidate the cache. */
export function beginTick(): void {
  tickCache.clear()
}

// ── KV read/write ───────────────────────────────────────

function defaultStatus(id: string): SourceStatus {
  return {
    id,
    state: 'active',
    lastCheckAt: 0,
    failureCount: 0,
    successCount: 0,
    latencyHistory: [],
    lastTransitionAt: Date.now(),
  }
}

async function loadFromKV(id: string): Promise<SourceStatus> {
  // Check tick cache first
  const cached = tickCache.get(id)
  if (cached) return cached

  try {
    const data = await kv.get<SourceStatus>(stateKey(id))
    const status = data || defaultStatus(id)
    tickCache.set(id, status)
    return status
  } catch (err) {
    console.warn(`[STATE] KV unavailable for ${id}, using default:`, err instanceof Error ? err.message : err)
    // KV unavailable → fail open (treat as active)
    const status = defaultStatus(id)
    tickCache.set(id, status)
    return status
  }
}

async function saveToKV(status: SourceStatus): Promise<void> {
  tickCache.set(status.id, status)
  try {
    const pipeline = kv.pipeline()
    pipeline.set(stateKey(status.id), status)
    pipeline.sadd(INDEX_KEY, status.id)
    await pipeline.exec()
  } catch (err) {
    console.warn(`[STATE] KV write failed for ${status.id}:`, err instanceof Error ? err.message : err)
    // P0 alert: broken state store is itself an incident
    alertKVFailure(status.id, err)
  }
}

function alertKVFailure(id: string, err: unknown): void {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (botToken && chatId) {
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🔴 <b>P0: KV STATE STORE UNAVAILABLE</b>\n\nFailed to persist state for <code>${id}</code>.\nError: ${err instanceof Error ? err.message : String(err)}\n\nSource states may reset on next cold start.`,
        parse_mode: 'HTML',
      }),
    }).catch(() => {})
  }
}

// ── Utility ─────────────────────────────────────────────

function calcP95(history: number[]): number {
  if (history.length === 0) return 0
  const sorted = [...history].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

// ── State transition logic ──────────────────────────────

type TransitionCallback = (id: string, from: SourceState, to: SourceState, reason: string) => void
let onTransition: TransitionCallback | null = null

export function setTransitionCallback(cb: TransitionCallback): void {
  onTransition = cb
}

function transition(status: SourceStatus, newState: SourceState, reason: string): void {
  const from = status.state
  if (from === newState) return
  status.state = newState
  status.lastTransitionAt = Date.now()
  console.log(`[STATE] ${status.id}: ${from} → ${newState} (${reason})`)
  if (onTransition) onTransition(status.id, from, newState, reason)
}

// ── Public API (async — backed by KV) ───────────────────

export async function getStatus(sourceId: string): Promise<SourceStatus> {
  return loadFromKV(sourceId)
}

export async function getAllStatuses(): Promise<SourceStatus[]> {
  try {
    const ids = await kv.smembers(INDEX_KEY) as string[]
    if (!ids || ids.length === 0) return []
    const statuses = await Promise.all(ids.map(id => loadFromKV(id)))
    return statuses
  } catch (err) {
    console.warn('[STATE] KV unavailable for getAllStatuses:', err instanceof Error ? err.message : err)
    return Array.from(tickCache.values())
  }
}

export async function recordHealthCheck(sourceId: string, result: HealthCheckResult): Promise<void> {
  const s = await loadFromKV(sourceId)
  s.lastCheckAt = Date.now()

  s.latencyHistory.push(result.latencyMs)
  if (s.latencyHistory.length > MAX_LATENCY_HISTORY) {
    s.latencyHistory = s.latencyHistory.slice(-MAX_LATENCY_HISTORY)
  }

  if (result.ok) {
    s.successCount++
    s.failureCount = 0

    if (s.state === 'degraded') {
      const p95 = calcP95(s.latencyHistory)
      if (s.successCount >= SUCCESS_TO_ACTIVE && p95 < P95_RECOVERY_THRESHOLD) {
        transition(s, 'active', `${SUCCESS_TO_ACTIVE} consecutive successes, p95=${Math.round(p95)}ms`)
      }
    }
  } else {
    s.failureCount++
    s.successCount = 0

    if (s.state === 'active') {
      const p95 = calcP95(s.latencyHistory)
      if (s.failureCount >= FAILURE_TO_DEGRADED) {
        transition(s, 'degraded', `${s.failureCount} consecutive failures`)
      } else if (s.latencyHistory.length >= 5 && p95 > P95_DEGRADED_THRESHOLD) {
        transition(s, 'degraded', `p95=${Math.round(p95)}ms exceeds ${P95_DEGRADED_THRESHOLD}ms`)
      }
    }

    if (s.state === 'degraded' && s.failureCount >= FAILURE_TO_DISABLED) {
      transition(s, 'disabled', `${s.failureCount} consecutive failures`)
      s.disabledAt = Date.now()
      s.disabledReason = result.error || 'health-check-failures'
    }
  }

  await saveToKV(s)
}

export async function forceDisable(sourceId: string, reason: string): Promise<void> {
  const s = await loadFromKV(sourceId)
  s.disabledReason = reason
  s.disabledAt = Date.now()
  transition(s, 'disabled', `force: ${reason}`)
  await saveToKV(s)
}

export async function forceActivate(sourceId: string): Promise<void> {
  const s = await loadFromKV(sourceId)
  s.failureCount = 0
  s.successCount = 0
  s.disabledReason = undefined
  s.disabledAt = undefined
  transition(s, 'active', 'force activated')
  await saveToKV(s)
}

export async function checkAutoRecovery(): Promise<string[]> {
  const recovered: string[] = []
  const now = Date.now()
  const all = await getAllStatuses()

  for (const s of all) {
    if (s.state !== 'disabled' || !s.disabledAt) continue
    if (s.disabledReason && P0_REASONS.has(s.disabledReason)) continue
    if (now - s.disabledAt >= AUTO_RECOVERY_MS) {
      s.failureCount = 0
      s.successCount = 0
      s.disabledReason = undefined
      s.disabledAt = undefined
      transition(s, 'active', `auto-recovery after ${AUTO_RECOVERY_MS / 60_000}min`)
      await saveToKV(s)
      recovered.push(s.id)
    }
  }

  return recovered
}

/** Reset all state — FORBIDDEN in production. */
export async function resetAllStates(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetAllStates is forbidden in production')
  }
  tickCache.clear()
  try {
    const ids = await kv.smembers(INDEX_KEY) as string[]
    if (ids?.length) {
      const pipeline = kv.pipeline()
      for (const id of ids) pipeline.del(stateKey(id))
      pipeline.del(INDEX_KEY)
      await pipeline.exec()
    }
  } catch {
    // Test environment may not have KV
  }
}
