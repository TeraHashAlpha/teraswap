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

// ── Persistence ──────────────────────────────────────────────
// Dual-mode: Supabase (if configured) + localStorage (always, as cache)
// localStorage serves as offline cache & fallback

function loadEvents(): TradeEvent[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(ANALYTICS_STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as TradeEvent[]
  } catch {
    return []
  }
}

function saveEvents(events: TradeEvent[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(events))
  } catch {
    const trimmed = events.slice(-5000)
    try {
      localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      // give up
    }
  }
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
    // Update localStorage cache
    saveEvents(events)
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

  const events = loadEvents()
  events.push(event)
  saveEvents(events)

  // Async push to Supabase (fire & forget — localStorage is source of truth during session)
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

/** Clear all analytics data */
export function clearAnalytics(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(ANALYTICS_STORAGE_KEY)
}

// ══════════════════════════════════════════════════════════
//  SEED — Generate realistic demo data for visualization
//  [M-07] PRODUCTION: This entire block is stripped via tree-shaking
//  when seedDemoData is not imported. Additionally guarded at runtime.
// ══════════════════════════════════════════════════════════

const SEED_WALLETS = [
  '0x1a2b3c4d5e6f7890abcdef1234567890abcdef01',
  '0x2b3c4d5e6f7890ab1234567890abcdef01234567',
  '0x3c4d5e6f7890ab12cdef01234567890abcdef0123',
  '0x4d5e6f7890ab1234ef01234567890abcdef012345',
  '0x5e6f7890ab123456234567890abcdef0123456789',
  '0x6f7890ab12345678567890abcdef012345678901',
  '0x7890ab1234567890890abcdef0123456789012345',
  '0x890ab12345678901bcdef012345678901234567890',
  '0x90ab1234567890120def0123456789012345678901',
  '0xab12345678901234def01234567890123456789012',
  '0xbb22446688aaccee1133557799bbddff00224466',
  '0xcc33557799bbddff2244668800aaccee11335577',
  // Sybil wallets (will trade in suspicious patterns)
  '0xdead0001000100010001000100010001deadbeef',
  '0xdead0002000200020002000200020002deadbeef',
]

const SEED_PAIRS: Array<{ tokenIn: string; tokenOut: string; avgUsd: number }> = [
  { tokenIn: 'ETH', tokenOut: 'USDC', avgUsd: 3200 },
  { tokenIn: 'USDC', tokenOut: 'ETH', avgUsd: 2800 },
  { tokenIn: 'ETH', tokenOut: 'USDT', avgUsd: 2500 },
  { tokenIn: 'WBTC', tokenOut: 'ETH', avgUsd: 15000 },
  { tokenIn: 'ETH', tokenOut: 'DAI', avgUsd: 1800 },
  { tokenIn: 'LINK', tokenOut: 'ETH', avgUsd: 400 },
  { tokenIn: 'UNI', tokenOut: 'USDC', avgUsd: 600 },
  { tokenIn: 'ETH', tokenOut: 'WBTC', avgUsd: 8000 },
  { tokenIn: 'DAI', tokenOut: 'USDC', avgUsd: 5000 },
  { tokenIn: 'USDT', tokenOut: 'DAI', avgUsd: 3000 },
]

const SEED_SOURCES: AggregatorName[] = [
  '1inch', '0x', 'velora', 'odos', 'kyberswap', 'cowswap',
  'uniswapv3', 'openocean', 'sushiswap', 'balancer',
]

const SEED_TYPES: TradeType[] = ['swap', 'swap', 'swap', 'swap', 'dca_buy', 'dca_buy', 'limit_fill', 'sltp_trigger']

function randomEl<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function randomTxHash(): string {
  const hex = '0123456789abcdef'
  let hash = '0x'
  for (let i = 0; i < 64; i++) hash += hex[Math.floor(Math.random() * 16)]
  return hash
}

export function seedDemoData(tradeCount = 350): number {
  // [M-07] Block in production — demo data must NEVER be seeded on mainnet
  if (process.env.NODE_ENV === 'production') {
    console.warn('[TeraSwap] seedDemoData() blocked in production')
    return 0
  }

  const events: TradeEvent[] = []
  const now = Date.now()
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

  // Regular users — spread over 30 days, realistic patterns
  const regularCount = Math.floor(tradeCount * 0.85)
  for (let i = 0; i < regularCount; i++) {
    const ts = now - Math.random() * THIRTY_DAYS
    const pair = randomEl(SEED_PAIRS)
    const wallet = randomEl(SEED_WALLETS.slice(0, 12)) // regular wallets only
    const volumeMultiplier = randomBetween(0.3, 3.5)
    const vol = pair.avgUsd * volumeMultiplier
    const source = randomEl(SEED_SOURCES)

    events.push({
      id: randomTxHash(),
      type: randomEl(SEED_TYPES),
      wallet,
      timestamp: ts,
      hour: new Date(ts).getUTCHours(),
      tokenIn: pair.tokenIn,
      tokenInAddress: '',
      tokenOut: pair.tokenOut,
      tokenOutAddress: '',
      amountIn: (vol / (pair.tokenIn === 'ETH' ? 3500 : pair.tokenIn === 'WBTC' ? 95000 : 1)).toFixed(4),
      amountOut: (vol / (pair.tokenOut === 'ETH' ? 3500 : pair.tokenOut === 'WBTC' ? 95000 : 1)).toFixed(4),
      volumeUsd: Math.round(vol * 100) / 100,
      feeUsd: Math.round(vol * 0.003 * 100) / 100, // 0.3% fee
      source,
      txHash: randomTxHash(),
      chainId: 1,
    })
  }

  // Whale trades — big volumes
  const whaleCount = Math.floor(tradeCount * 0.05)
  for (let i = 0; i < whaleCount; i++) {
    const ts = now - Math.random() * THIRTY_DAYS
    const pair = randomEl(SEED_PAIRS.slice(0, 4)) // whales trade major pairs
    const vol = randomBetween(15000, 120000)
    events.push({
      id: randomTxHash(),
      type: 'swap',
      wallet: randomEl(SEED_WALLETS.slice(0, 3)),
      timestamp: ts,
      hour: new Date(ts).getUTCHours(),
      tokenIn: pair.tokenIn, tokenInAddress: '',
      tokenOut: pair.tokenOut, tokenOutAddress: '',
      amountIn: (vol / 3500).toFixed(4),
      amountOut: (vol).toFixed(2),
      volumeUsd: Math.round(vol),
      feeUsd: Math.round(vol * 0.003 * 100) / 100,
      source: randomEl(['1inch', '0x', 'cowswap', 'odos']),
      txHash: randomTxHash(),
      chainId: 1,
    })
  }

  // Sybil wallets — suspicious patterns (circular trades, repeated amounts, burst)
  const sybilCount = Math.floor(tradeCount * 0.10)
  const sybilBaseTs = now - randomBetween(2 * 3600_000, 24 * 3600_000) // burst in last 24h
  for (let i = 0; i < sybilCount; i++) {
    const sybilWallet = randomEl(SEED_WALLETS.slice(12)) // sybil wallets
    const isCircular = i % 2 === 0
    const ts = sybilBaseTs + i * 120_000 // every 2 min (uniform intervals)

    events.push({
      id: randomTxHash(),
      type: 'swap',
      wallet: sybilWallet,
      timestamp: ts,
      hour: new Date(ts).getUTCHours(),
      tokenIn: isCircular ? 'ETH' : 'USDC',
      tokenInAddress: '',
      tokenOut: isCircular ? 'USDC' : 'ETH',
      tokenOutAddress: '',
      amountIn: '1.0000', // same amount every time
      amountOut: isCircular ? '3500.00' : '0.2857',
      volumeUsd: 5, // tiny volume
      feeUsd: 0.015,
      source: 'uniswapv3', // always same source
      txHash: randomTxHash(),
      chainId: 1,
    })
  }

  // Sort by timestamp and save
  events.sort((a, b) => a.timestamp - b.timestamp)
  saveEvents(events)
  return events.length
}
