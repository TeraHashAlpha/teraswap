import type { AggregatorName } from './constants'
import { FEE_PERCENT, CHAIN_ID } from './constants'
import {
  type TradeEvent,
  type TradeType,
  type WalletProfile,
  type SourceMetrics,
  type HourlyVolume,
  type PairMetrics,
  type PeriodMetrics,
  type DashboardData,
  ANALYTICS_STORAGE_KEY,
} from './analytics-types'
import { getSupabase, isSupabaseEnabled } from './supabase'
import {
  initSecureStorage,
  isSecureStorageReady,
  secureGet,
  secureSet,
  secureRemove,
} from './secure-storage'

// ── Persistence ──────────────────────────────────────────────
// Dual-mode: Supabase (if configured) + localStorage (always, as cache).
//
// [P200] The localStorage cache is now encrypted at rest (AES-256-GCM,
// wallet-derived key) under the v2 key. SecureStorage is async, but this
// module exposes a synchronous API (trackTrade/computeDashboard/…), so we
// keep an in-memory mirror (`memoryCache`) that sync callers read/write
// immediately, and hydrate it lazily from the encrypted store. The legacy v1
// key held plaintext JSON and is migrated + removed on first hydration.

/** Max events to keep in localStorage (proactive cap — EXT-L-02) */
const MAX_LOCAL_EVENTS = 2000

/** Legacy plaintext key (v1) — read once for migration, then removed. */
const LEGACY_ANALYTICS_KEY = ANALYTICS_STORAGE_KEY
/** Encrypted key (v2). */
const ANALYTICS_STORAGE_KEY_V2 = `${ANALYTICS_STORAGE_KEY}_v2`

// In-memory mirror of the encrypted store, shared by the sync API.
let memoryCache: TradeEvent[] = []
// True once the cache has been reconciled with the encrypted store.
let hydrated = false
// De-dupes concurrent hydration attempts.
let hydrationPromise: Promise<void> | null = null

/** Read the legacy v1 (plaintext) events for one-time migration. */
function readLegacyEvents(): TradeEvent[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(LEGACY_ANALYTICS_KEY)
    if (!raw) return []
    return JSON.parse(raw) as TradeEvent[]
  } catch {
    return []
  }
}

/**
 * Reconcile `memoryCache` with the encrypted v2 store, migrating any legacy
 * v1 plaintext data once. Idempotent and concurrency-safe. No-op until
 * SecureStorage is initialised (a wallet must be connected) — hydration is
 * retried on the next call. Events added optimistically before hydration are
 * preserved (merged by id).
 */
export async function ensureAnalyticsHydrated(): Promise<void> {
  if (hydrated) return
  if (typeof window === 'undefined') { hydrated = true; return }
  // Without a wallet-derived key we cannot decrypt — defer until one exists.
  if (!isSecureStorageReady()) return
  if (hydrationPromise) return hydrationPromise

  hydrationPromise = (async () => {
    let loaded = await secureGet<TradeEvent[]>(ANALYTICS_STORAGE_KEY_V2)

    if (loaded === null) {
      // One-time migration from legacy plaintext v1.
      const legacy = readLegacyEvents()
      if (legacy.length > 0) {
        loaded = legacy
        await secureSet(ANALYTICS_STORAGE_KEY_V2, legacy)
        try { localStorage.removeItem(LEGACY_ANALYTICS_KEY) } catch { /* ignore */ }
      }
    }

    // Merge persisted events with any added optimistically (dedupe by id).
    const byId = new Map<string, TradeEvent>()
    for (const e of loaded ?? []) byId.set(e.id, e)
    for (const e of memoryCache) byId.set(e.id, e)
    memoryCache = Array.from(byId.values())
    hydrated = true
  })().finally(() => { hydrationPromise = null })

  return hydrationPromise
}

/** Synchronous in-memory view. Kicks off hydration for subsequent reads. */
function loadEvents(): TradeEvent[] {
  void ensureAnalyticsHydrated()
  return memoryCache
}

function saveEvents(events: TradeEvent[]): void {
  // Proactive cap — keep most recent events only (EXT-L-02)
  const capped = events.length > MAX_LOCAL_EVENTS
    ? events.slice(-MAX_LOCAL_EVENTS)
    : events
  memoryCache = capped
  if (typeof window === 'undefined') return
  // Fire-and-forget encrypted write. SecureStorage swallows quota/serialise
  // errors internally (never throws), so the in-memory cache stays the
  // source of truth for the session.
  void secureSet(ANALYTICS_STORAGE_KEY_V2, capped)
}

// ── Supabase helpers ─────────────────────────────────────────

function toSnakeCase(event: TradeEvent) {
  return {
    id: event.id,
    type: event.type,
    wallet: event.wallet,
    timestamp: event.timestamp,
    hour: event.hour,
    token_in: event.tokenIn,
    token_in_addr: event.tokenInAddress,
    token_out: event.tokenOut,
    token_out_addr: event.tokenOutAddress,
    amount_in: event.amountIn,
    amount_out: event.amountOut,
    volume_usd: event.volumeUsd,
    fee_usd: event.feeUsd,
    source: event.source,
    tx_hash: event.txHash,
    chain_id: event.chainId,
  }
}

function fromSnakeCase(row: Record<string, unknown>): TradeEvent {
  return {
    id: row.id as string,
    type: row.type as TradeType,
    wallet: row.wallet as string,
    timestamp: Number(row.timestamp),
    hour: Number(row.hour),
    tokenIn: row.token_in as string,
    tokenInAddress: (row.token_in_addr as string) || '',
    tokenOut: row.token_out as string,
    tokenOutAddress: (row.token_out_addr as string) || '',
    amountIn: row.amount_in as string,
    amountOut: row.amount_out as string,
    volumeUsd: Number(row.volume_usd),
    feeUsd: Number(row.fee_usd),
    source: row.source as AggregatorName,
    txHash: (row.tx_hash as string) || '',
    chainId: Number(row.chain_id),
  }
}

/** Insert a trade into Supabase (fire & forget) */
async function supabaseInsert(event: TradeEvent): Promise<void> {
  const sb = getSupabase()
  if (!sb) return
  try {
    await sb.from('trade_events').upsert(toSnakeCase(event), { onConflict: 'id' })
  } catch {
    // Silent fail — localStorage still has it
  }
}

/** Load all events from Supabase (replaces localStorage on success) */
export async function syncFromSupabase(): Promise<TradeEvent[] | null> {
  const sb = getSupabase()
  if (!sb) return null
  try {
    const { data, error } = await sb
      .from('trade_events')
      .select('*')
      .order('timestamp', { ascending: true })
      .limit(10000)
    if (error || !data) return null
    const events = data.map(fromSnakeCase)
    // Server data is authoritative — replace the cache and mark hydrated so a
    // later lazy hydration doesn't re-merge stale legacy data.
    saveEvents(events)
    hydrated = true
    if (typeof window !== 'undefined') {
      try { localStorage.removeItem(LEGACY_ANALYTICS_KEY) } catch { /* ignore */ }
    }
    return events
  } catch {
    return null
  }
}

/** Load events — from Supabase if available, else localStorage */
export async function loadEventsAsync(): Promise<TradeEvent[]> {
  if (isSupabaseEnabled()) {
    const remote = await syncFromSupabase()
    if (remote) return remote
  }
  return loadEvents()
}

// ── Record a trade ───────────────────────────────────────────

export interface TrackTradeParams {
  type: TradeType
  wallet: string
  tokenIn: string
  tokenInAddress: string
  tokenOut: string
  tokenOutAddress: string
  amountIn: string
  amountOut: string
  volumeUsd: number
  source: AggregatorName
  txHash: string
}

export function trackTrade(params: TrackTradeParams): TradeEvent {
  const now = Date.now()
  const event: TradeEvent = {
    id: params.txHash || `${now}-${Math.random().toString(36).slice(2, 8)}`,
    type: params.type,
    wallet: params.wallet.toLowerCase(),
    timestamp: now,
    hour: new Date(now).getHours(),
    tokenIn: params.tokenIn,
    tokenInAddress: params.tokenInAddress,
    tokenOut: params.tokenOut,
    tokenOutAddress: params.tokenOutAddress,
    amountIn: params.amountIn,
    amountOut: params.amountOut,
    volumeUsd: params.volumeUsd,
    feeUsd: params.volumeUsd * (FEE_PERCENT / 100),
    source: params.source,
    txHash: params.txHash,
    chainId: CHAIN_ID,
  }

  // Ensure this wallet's encryption key is derivable (idempotent no-op when
  // the same wallet is already initialised, e.g. by the order hooks).
  initSecureStorage(params.wallet)

  // Optimistic in-memory append — visible to sync readers immediately.
  memoryCache = [...memoryCache, event]

  // Persist: hydrate first (merges any prior persisted events into the cache),
  // then encrypt the full set. Fire-and-forget — SecureStorage never throws.
  void (async () => {
    await ensureAnalyticsHydrated()
    saveEvents(memoryCache)
  })()

  // Async push to Supabase (authoritative server store; fire & forget).
  supabaseInsert(event)

  return event
}

// ── Compute Dashboard ────────────────────────────────────────

function filterByPeriod(events: TradeEvent[], ms: number): TradeEvent[] {
  const cutoff = Date.now() - ms
  return events.filter(e => e.timestamp >= cutoff)
}

function computePeriodMetrics(events: TradeEvent[]): PeriodMetrics {
  const wallets = new Set(events.map(e => e.wallet))
  return {
    totalVolume: events.reduce((s, e) => s + e.volumeUsd, 0),
    totalFees: events.reduce((s, e) => s + e.feeUsd, 0),
    tradeCount: events.length,
    uniqueWallets: wallets.size,
  }
}

function computeSourceMetrics(events: TradeEvent[]): SourceMetrics[] {
  const map = new Map<AggregatorName, { count: number; volume: number }>()

  for (const e of events) {
    const entry = map.get(e.source) || { count: 0, volume: 0 }
    entry.count++
    entry.volume += e.volumeUsd
    map.set(e.source, entry)
  }

  const total = events.length || 1
  return Array.from(map.entries())
    .map(([source, data]) => ({
      source,
      tradeCount: data.count,
      volumeUsd: data.volume,
      winRate: (data.count / total) * 100,
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
}

function computeHourlyVolume(events: TradeEvent[]): HourlyVolume[] {
  const hours: HourlyVolume[] = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    volumeUsd: 0,
    tradeCount: 0,
  }))

  for (const e of events) {
    hours[e.hour].volumeUsd += e.volumeUsd
    hours[e.hour].tradeCount++
  }

  return hours
}

function computeTopPairs(events: TradeEvent[]): PairMetrics[] {
  const map = new Map<string, { count: number; volume: number }>()

  for (const e of events) {
    const pair = `${e.tokenIn}/${e.tokenOut}`
    const entry = map.get(pair) || { count: 0, volume: 0 }
    entry.count++
    entry.volume += e.volumeUsd
    map.set(pair, entry)
  }

  return Array.from(map.entries())
    .map(([pair, data]) => ({
      pair,
      tradeCount: data.count,
      volumeUsd: data.volume,
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, 10)
}

function computeWallets(events: TradeEvent[]): WalletProfile[] {
  const map = new Map<string, {
    count: number
    volume: number
    firstSeen: number
    lastSeen: number
    types: Set<TradeType>
    pairs: Map<string, number>
  }>()

  for (const e of events) {
    let entry = map.get(e.wallet)
    if (!entry) {
      entry = {
        count: 0, volume: 0,
        firstSeen: e.timestamp, lastSeen: e.timestamp,
        types: new Set(), pairs: new Map(),
      }
      map.set(e.wallet, entry)
    }
    entry.count++
    entry.volume += e.volumeUsd
    entry.lastSeen = Math.max(entry.lastSeen, e.timestamp)
    entry.firstSeen = Math.min(entry.firstSeen, e.timestamp)
    entry.types.add(e.type)
    const pair = `${e.tokenIn}/${e.tokenOut}`
    entry.pairs.set(pair, (entry.pairs.get(pair) || 0) + 1)
  }

  return Array.from(map.entries())
    .map(([address, data]) => {
      let topPair = ''
      let topCount = 0
      for (const [pair, count] of data.pairs) {
        if (count > topCount) { topPair = pair; topCount = count }
      }
      return {
        address,
        tradeCount: data.count,
        totalVolumeUsd: data.volume,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
        typesUsed: data.types,
        topPair,
      }
    })
    .sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd)
}

function computeDailyVolume(events: TradeEvent[]): Array<{ date: string; volumeUsd: number; tradeCount: number }> {
  const map = new Map<string, { volume: number; count: number }>()

  // Last 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  for (const e of events) {
    if (e.timestamp < cutoff) continue
    const date = new Date(e.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    const entry = map.get(date) || { volume: 0, count: 0 }
    entry.volume += e.volumeUsd
    entry.count++
    map.set(date, entry)
  }

  return Array.from(map.entries())
    .map(([date, data]) => ({ date, volumeUsd: data.volume, tradeCount: data.count }))
}

// ── Main entry ──

export function computeDashboard(): DashboardData {
  const events = loadEvents()

  const wallets = computeWallets(events)

  return {
    allTime: computePeriodMetrics(events),
    last24h: computePeriodMetrics(filterByPeriod(events, 24 * 60 * 60 * 1000)),
    last7d: computePeriodMetrics(filterByPeriod(events, 7 * 24 * 60 * 60 * 1000)),
    last30d: computePeriodMetrics(filterByPeriod(events, 30 * 24 * 60 * 60 * 1000)),
    bySource: computeSourceMetrics(events),
    byHour: computeHourlyVolume(events),
    topPairs: computeTopPairs(events),
    wallets,
    totalWallets: wallets.length,
    recentTrades: [...events].reverse().slice(0, 50),
    dailyVolume: computeDailyVolume(events),
  }
}

/** Export raw events for airdrop snapshot */
export function exportWalletSnapshot(): Array<{
  address: string
  tradeCount: number
  totalVolumeUsd: number
  firstSeen: string
  lastSeen: string
}> {
  const wallets = computeWallets(loadEvents())
  return wallets.map(w => ({
    address: w.address,
    tradeCount: w.tradeCount,
    totalVolumeUsd: Math.round(w.totalVolumeUsd * 100) / 100,
    firstSeen: new Date(w.firstSeen).toISOString(),
    lastSeen: new Date(w.lastSeen).toISOString(),
  }))
}

/** Get total event count (for quick check) */
export function getEventCount(): number {
  return loadEvents().length
}

/** Clear all analytics data (in-memory cache + encrypted v2 + legacy v1). */
export function clearAnalytics(): void {
  memoryCache = []
  hydrated = true // cleared state is authoritative; no re-hydrate needed
  if (typeof window === 'undefined') return
  secureRemove(ANALYTICS_STORAGE_KEY_V2)
  try { localStorage.removeItem(LEGACY_ANALYTICS_KEY) } catch { /* ignore */ }
}
