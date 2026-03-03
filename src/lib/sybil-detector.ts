import type { TradeEvent, WalletProfile } from './analytics-types'

// ══════════════════════════════════════════════════════════
//  SYBIL / WASH TRADING DETECTOR
//  Scores wallets on multiple heuristics to flag suspicious
//  behavior for airdrop exclusion.
// ══════════════════════════════════════════════════════════

export interface SybilScore {
  address: string
  /** 0-100, higher = more suspicious */
  score: number
  /** Individual heuristic flags */
  flags: SybilFlag[]
  /** Human-readable verdict */
  verdict: 'clean' | 'suspicious' | 'likely_sybil'
  /** Trade count for context */
  tradeCount: number
  totalVolumeUsd: number
}

export interface SybilFlag {
  rule: string
  description: string
  weight: number // contribution to score (0-25)
  details?: string
}

// ── Heuristic 1: Circular Trading ──────────────────────────
// Detects A→B then B→A within a time window (wash trade)
function detectCircularTrades(trades: TradeEvent[]): SybilFlag | null {
  const WINDOW_MS = 3600_000 // 1 hour
  let circularCount = 0
  const checked = new Set<string>()

  for (let i = 0; i < trades.length; i++) {
    const t1 = trades[i]
    if (!t1.tokenIn || !t1.tokenOut) continue
    const forwardKey = `${t1.tokenIn}->${t1.tokenOut}`

    for (let j = i + 1; j < trades.length; j++) {
      const t2 = trades[j]
      if (Math.abs(t2.timestamp - t1.timestamp) > WINDOW_MS) break
      if (!t2.tokenIn || !t2.tokenOut) continue

      const reverseKey = `${t2.tokenIn}->${t2.tokenOut}`
      const pairKey = `${i}-${j}`
      if (reverseKey === `${t1.tokenOut}->${t1.tokenIn}` && !checked.has(pairKey)) {
        circularCount++
        checked.add(pairKey)
      }
    }
  }

  if (circularCount === 0) return null

  const ratio = circularCount / Math.max(trades.length / 2, 1)
  const weight = Math.min(ratio * 25, 25)

  return {
    rule: 'circular_trades',
    description: 'Circular trading detected (A→B then B→A within 1h)',
    weight,
    details: `${circularCount} circular pairs found (${(ratio * 100).toFixed(0)}% of trades)`,
  }
}

// ── Heuristic 2: Repeated Exact Amounts ───────────────────
// Same amountIn used suspiciously often → likely scripted
function detectRepeatedAmounts(trades: TradeEvent[]): SybilFlag | null {
  const amounts = new Map<string, number>()
  for (const t of trades) {
    if (!t.amountIn || t.amountIn === '0') continue
    const key = `${t.amountIn}-${t.tokenIn}`
    amounts.set(key, (amounts.get(key) || 0) + 1)
  }

  const maxRepeat = Math.max(...amounts.values(), 0)
  const repeatRatio = trades.length > 0 ? maxRepeat / trades.length : 0

  if (maxRepeat < 3 || repeatRatio < 0.4) return null

  const weight = Math.min(repeatRatio * 20, 20)
  return {
    rule: 'repeated_amounts',
    description: 'Same exact amount used repeatedly',
    weight,
    details: `Top amount repeated ${maxRepeat}x (${(repeatRatio * 100).toFixed(0)}% of trades)`,
  }
}

// ── Heuristic 3: Timestamp Clustering ─────────────────────
// Trades fired at suspiciously regular intervals → bot
function detectTimestampClustering(trades: TradeEvent[]): SybilFlag | null {
  if (trades.length < 5) return null

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(sorted[i].timestamp - sorted[i - 1].timestamp)
  }

  // Check for suspiciously uniform intervals (low variance)
  const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length
  const variance = intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length
  const cv = avg > 0 ? Math.sqrt(variance) / avg : 0 // coefficient of variation

  // CV < 0.3 means intervals are very uniform (bot-like)
  if (cv > 0.3) return null

  const weight = Math.min((1 - cv) * 20, 20)
  return {
    rule: 'timestamp_clustering',
    description: 'Trades at suspiciously regular intervals (bot pattern)',
    weight,
    details: `Interval CV: ${cv.toFixed(3)} (avg ${(avg / 1000).toFixed(0)}s between trades)`,
  }
}

// ── Heuristic 4: Volume Inflation ─────────────────────────
// High volume but tiny trade sizes → farming volume for airdrop
function detectVolumeInflation(trades: TradeEvent[]): SybilFlag | null {
  if (trades.length < 10) return null

  const avgUsd = trades.reduce((s, t) => s + t.volumeUsd, 0) / trades.length
  const totalVol = trades.reduce((s, t) => s + t.volumeUsd, 0)

  // Many tiny trades with high total volume
  if (avgUsd > 50 || totalVol < 1000) return null

  const tinyRatio = trades.filter(t => t.volumeUsd < 10).length / trades.length
  if (tinyRatio < 0.7) return null

  const weight = Math.min(tinyRatio * 20, 20)
  return {
    rule: 'volume_inflation',
    description: 'Many tiny trades to inflate trade count',
    weight,
    details: `${(tinyRatio * 100).toFixed(0)}% of trades < $10 (avg $${avgUsd.toFixed(2)})`,
  }
}

// ── Heuristic 5: Single Source Only ───────────────────────
// Real users tend to get quotes routed through various sources
// Sybils often only get one source because they're using fixed params
function detectSingleSourceAbuse(trades: TradeEvent[]): SybilFlag | null {
  if (trades.length < 5) return null

  const sources = new Set(trades.map(t => t.source))
  if (sources.size > 1) return null

  return {
    rule: 'single_source',
    description: 'All trades through a single aggregator (unusual for meta-aggregator)',
    weight: 10,
    details: `100% of trades via ${[...sources][0]}`,
  }
}

// ── Heuristic 6: Burst Activity ───────────────────────────
// All activity crammed into short window → farming before snapshot
function detectBurstActivity(trades: TradeEvent[]): SybilFlag | null {
  if (trades.length < 5) return null

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const span = sorted[sorted.length - 1].timestamp - sorted[0].timestamp
  const spanHours = span / 3600_000

  // All trades in less than 2 hours
  if (spanHours > 2 || trades.length < 8) return null

  const weight = Math.min((trades.length / spanHours) * 2, 15)
  return {
    rule: 'burst_activity',
    description: 'All activity concentrated in a short burst',
    weight,
    details: `${trades.length} trades in ${spanHours.toFixed(1)}h`,
  }
}

// ── Main Scorer ──────────────────────────────────────────

export function scoreWallet(wallet: WalletProfile, trades: TradeEvent[]): SybilScore {
  const walletTrades = trades
    .filter(t => t.wallet.toLowerCase() === wallet.address.toLowerCase())
    .sort((a, b) => a.timestamp - b.timestamp)

  const flags: SybilFlag[] = []

  const checks = [
    detectCircularTrades,
    detectRepeatedAmounts,
    detectTimestampClustering,
    detectVolumeInflation,
    detectSingleSourceAbuse,
    detectBurstActivity,
  ]

  for (const check of checks) {
    const flag = check(walletTrades)
    if (flag) flags.push(flag)
  }

  const score = Math.min(flags.reduce((s, f) => s + f.weight, 0), 100)

  return {
    address: wallet.address,
    score,
    flags,
    verdict: score >= 60 ? 'likely_sybil' : score >= 30 ? 'suspicious' : 'clean',
    tradeCount: wallet.tradeCount,
    totalVolumeUsd: wallet.totalVolumeUsd,
  }
}

export function scoreAllWallets(wallets: WalletProfile[], trades: TradeEvent[]): SybilScore[] {
  return wallets
    .map(w => scoreWallet(w, trades))
    .sort((a, b) => b.score - a.score)
}

// ── Cluster Detection (advanced) ─────────────────────────
// Find wallets that operate at the exact same timestamps
// (suggesting they're controlled by the same entity)

export interface WalletCluster {
  wallets: string[]
  sharedTimestamps: number
  confidence: number // 0-1
}

export function detectWalletClusters(trades: TradeEvent[]): WalletCluster[] {
  // Group trades by 5-minute windows
  const WINDOW = 300_000 // 5 min
  const windowMap = new Map<number, Set<string>>()

  for (const t of trades) {
    const window = Math.floor(t.timestamp / WINDOW)
    if (!windowMap.has(window)) windowMap.set(window, new Set())
    windowMap.get(window)!.add(t.wallet.toLowerCase())
  }

  // Find wallet pairs that co-occur in many windows
  const pairCount = new Map<string, number>()
  const walletWindows = new Map<string, number>()

  for (const wallets of windowMap.values()) {
    const arr = [...wallets]
    for (const w of arr) {
      walletWindows.set(w, (walletWindows.get(w) || 0) + 1)
    }
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('|')
        pairCount.set(key, (pairCount.get(key) || 0) + 1)
      }
    }
  }

  const clusters: WalletCluster[] = []
  for (const [key, count] of pairCount) {
    if (count < 3) continue // need at least 3 co-occurrences
    const [w1, w2] = key.split('|')
    const minWindows = Math.min(walletWindows.get(w1) || 0, walletWindows.get(w2) || 0)
    const confidence = minWindows > 0 ? count / minWindows : 0

    if (confidence >= 0.5) {
      clusters.push({
        wallets: [w1, w2],
        sharedTimestamps: count,
        confidence,
      })
    }
  }

  return clusters.sort((a, b) => b.confidence - a.confidence)
}
