// ══════════════════════════════════════════════════════════
//  SEED — Generate realistic demo data for visualization
//  [M-07 / EXT-L-04] Extracted from analytics-tracker.ts so this
//  module is NEVER pulled into the production bundle by tree-shaking,
//  regardless of how the tracker is imported. Runtime guard kept as
//  defence-in-depth.
// ══════════════════════════════════════════════════════════

import type { TradeEvent, TradeType } from './analytics-types'
import { ANALYTICS_STORAGE_KEY } from './analytics-types'
import type { AggregatorName } from './constants'

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

// Dev-only writer — bypasses tracker so the seed module has no production-code
// dependency surface. Mirrors saveEvents() behaviour for compatibility.
function writeSeedEvents(events: TradeEvent[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(events))
  } catch {
    // give up — seed data is best-effort
  }
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
  writeSeedEvents(events)
  return events.length
}
