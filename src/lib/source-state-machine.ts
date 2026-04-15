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
 *   - API routes with explicit authentication (MONITOR_CRON_SECRET, admin session, etc.)
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
import { emitTransitionAlert } from './alert-wrapper'
import { isP0Reason } from './p0-reasons'
import thresholdsJson from '../../data/source-thresholds.json'

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

// ── Per-source thresholds ───────────────────────────────

export interface SourceThresholds {
  failuresToDegraded: number
  failuresToDisabled: number
  successesToActive: number
  p95LatencyThresholdMs: number
  /** H5 quorum: max deviation % for volatile pairs (default 5) */
  quorumMaxDeviationPercent?: number
  /** H5 quorum: max deviation % for stablecoin pairs (default 2) */
  quorumStableMaxDeviationPercent?: number
}

interface ThresholdsConfig {
  defaults: SourceThresholds
  overrides: Record<string, Partial<SourceThresholds> & { _comment?: string }>
}

const HARDCODED_DEFAULTS: SourceThresholds = {
  failuresToDegraded: 3,
  failuresToDisabled: 5,
  successesToActive: 3,
  p95LatencyThresholdMs: 5000,
  quorumMaxDeviationPercent: 5,
  quorumStableMaxDeviationPercent: 2,
}

let thresholdsConfig: ThresholdsConfig | null = null

function validateThresholds(t: SourceThresholds, sourceId: string): SourceThresholds {
  const { failuresToDegraded, failuresToDisabled, successesToActive, p95LatencyThresholdMs } = t

  if (!Number.isInteger(failuresToDegraded) || failuresToDegraded < 1 ||
      !Number.isInteger(failuresToDisabled) || failuresToDisabled < 1 ||
      !Number.isInteger(successesToActive) || successesToActive < 1) {
    console.warn(`[STATE] Invalid thresholds for ${sourceId}: values must be positive integers, using defaults`)
    return HARDCODED_DEFAULTS
  }
  if (failuresToDisabled <= failuresToDegraded) {
    console.warn(`[STATE] Invalid thresholds for ${sourceId}: failuresToDisabled must exceed failuresToDegraded, using defaults`)
    return HARDCODED_DEFAULTS
  }
  if (p95LatencyThresholdMs !== undefined && (!Number.isInteger(p95LatencyThresholdMs) || p95LatencyThresholdMs < 100)) {
    console.warn(`[STATE] Invalid thresholds for ${sourceId}: p95LatencyThresholdMs must be >= 100, using defaults`)
    return HARDCODED_DEFAULTS
  }
  return t
}

function loadThresholds(): ThresholdsConfig {
  if (thresholdsConfig) return thresholdsConfig

  try {
    const raw = thresholdsJson as unknown as ThresholdsConfig
    if (!raw?.defaults || typeof raw.defaults.failuresToDegraded !== 'number') {
      throw new Error('Malformed thresholds JSON — missing or invalid defaults')
    }
    // Validate defaults themselves
    const validatedDefaults = validateThresholds(raw.defaults, '_defaults')
    thresholdsConfig = { defaults: validatedDefaults, overrides: raw.overrides ?? {} }
    return thresholdsConfig
  } catch (err) {
    console.warn('[STATE] Failed to load source-thresholds.json, using hardcoded defaults:', err instanceof Error ? err.message : err)
    thresholdsConfig = { defaults: HARDCODED_DEFAULTS, overrides: {} }
    return thresholdsConfig
  }
}

export function getThresholds(sourceId: string): SourceThresholds {
  const config = loadThresholds()
  const override = config.overrides[sourceId]
  if (!override) return config.defaults

  const merged: SourceThresholds = {
    failuresToDegraded: override.failuresToDegraded ?? config.defaults.failuresToDegraded,
    failuresToDisabled: override.failuresToDisabled ?? config.defaults.failuresToDisabled,
    successesToActive: override.successesToActive ?? config.defaults.successesToActive,
    p95LatencyThresholdMs: override.p95LatencyThresholdMs ?? config.defaults.p95LatencyThresholdMs,
    quorumMaxDeviationPercent: (override as Record<string, unknown>).quorumMaxDeviationPercent as number ?? config.defaults.quorumMaxDeviationPercent,
    quorumStableMaxDeviationPercent: (override as Record<string, unknown>).quorumStableMaxDeviationPercent as number ?? config.defaults.quorumStableMaxDeviationPercent,
  }
  return validateThresholds(merged, sourceId)
}

/** Reset cached thresholds — for testing only. */
export function _resetThresholdsCache(): void {
  thresholdsConfig = null
}

// ── Non-configurable constants ──────────────────────────

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
    // P0 alert: broken state store is itself an incident
    alertKVFailure(status.id, 'write', err)
  }
}

function alertKVFailure(sourceId: string, operation: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[STATE] KV ${operation} failed for ${sourceId}: ${message}`)

  // Route through the standard alert pipeline (fans out to all channels, HTML-escaped).
  // 'kv-store-failure' is a P0 reason → bypasses grace period and uses short dedup TTL.
  // If KV is down, the dedup check in alert-wrapper will fail-open (existing behaviour).
  emitTransitionAlert(sourceId, 'active', 'active', `kv-store-failure: ${operation} — ${message}`).catch(alertErr => {
    // Last resort: if even the alert-wrapper fails, log to console.
    // The GitHub Actions watchdog will catch the stale heartbeat.
    console.error(`[STATE] Alert emission also failed: ${alertErr instanceof Error ? alertErr.message : alertErr}`)
  })
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

  // Fire-and-forget alert — never blocks state machine
  emitTransitionAlert(status.id, from, newState, reason).catch(err => {
    console.error(`[STATE] alert emission failed for ${status.id}:`, err instanceof Error ? err.message : err)
  })
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
  const t = getThresholds(sourceId)
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
      if (s.successCount >= t.successesToActive && p95 < P95_RECOVERY_THRESHOLD) {
        transition(s, 'active', `${t.successesToActive} consecutive successes, p95=${Math.round(p95)}ms`)
      }
    }
  } else {
    s.failureCount++
    s.successCount = 0

    if (s.state === 'active') {
      const p95 = calcP95(s.latencyHistory)
      if (s.failureCount >= t.failuresToDegraded) {
        transition(s, 'degraded', `${s.failureCount} consecutive failures`)
      } else if (s.latencyHistory.length >= 5 && p95 > t.p95LatencyThresholdMs) {
        transition(s, 'degraded', `p95=${Math.round(p95)}ms exceeds ${t.p95LatencyThresholdMs}ms`)
      }
    }

    if (s.state === 'degraded' && s.failureCount >= t.failuresToDisabled) {
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
    if (isP0Reason(s.disabledReason)) continue
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
