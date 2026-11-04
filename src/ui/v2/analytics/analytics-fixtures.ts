import type { DashboardData, TradeEvent } from '@/lib/analytics-types'
import type { PublicStatsPayload } from '@/lib/public-stats-display'
import type { PersonalAnalytics } from '@/lib/personal-analytics'

/** Test fixtures for the Analytics tab: ONE set of answers that v1 and v2 are both rendered against. The clock is NOW. */
export const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const trade = (over: Partial<TradeEvent> & { id: string; ageMs: number }): TradeEvent => {
  const { ageMs, ...rest } = over
  return {
    type: 'swap',
    timestamp: NOW - ageMs,
    chainId: 8453,
    source: 'velora',
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    txHash: `0x${over.id.slice(1).padStart(2, '0').repeat(32)}`, // one distinct hash per trade
    ...rest,
  } as TradeEvent
}

export const TRADES: DashboardData['recentTrades'] = [
  trade({ id: 't1', ageMs: 20_000, source: 'kyberswap', tokenIn: 'CRV', tokenOut: 'USDC' }),
  trade({ id: 't2', ageMs: 14 * MIN, chainId: 1, source: 'velora', tokenIn: 'ETH', tokenOut: 'WETH', txHash: `0x${'cd'.repeat(32)}` }),
  trade({ id: 't3', ageMs: 5 * HOUR, type: 'dca_buy', chainId: 42161, source: 'velora', tokenIn: 'USDC', tokenOut: 'WETH', txHash: `0x${'ef'.repeat(32)}` }),
  trade({ id: 't4', ageMs: 3 * DAY, type: 'limit_fill', source: 'uniswapv3', tokenIn: 'WETH', tokenOut: 'USDC' }),
  trade({ id: 't5', ageMs: 4 * DAY, type: 'sltp_trigger', source: 'kyberswap', tokenIn: 'ETH', tokenOut: 'USDC', txHash: undefined as unknown as string }),
  trade({ id: 't6', ageMs: 5 * DAY, tokenIn: '', tokenOut: '', source: 'not_a_listed_source' as TradeEvent['source'] }),
  trade({ id: 't7', ageMs: 6 * DAY, type: 'mystery' as TradeEvent['type'] }),
  trade({ id: 't8', ageMs: 7 * DAY }),
  trade({ id: 't9', ageMs: 8 * DAY }),
  trade({ id: 't10', ageMs: 9 * DAY }),
  trade({ id: 't11', ageMs: 10 * DAY, tokenIn: 'ELEVENTH', tokenOut: 'ROW' }),
  trade({ id: 't12', ageMs: 11 * DAY, tokenIn: 'TWELFTH', tokenOut: 'ROW' }),
]

const day = (n: number) => new Date(NOW - (29 - n) * DAY).toISOString().slice(0, 10)
export const DAILY: DashboardData['dailyVolume'] = Array.from({ length: 30 }, (_, i) => ({
  date: day(i),
  volumeUsd: i % 7 === 3 ? 0 : 120 + ((i * 97) % 880) + (i === 27 ? 1800 : 0),
  tradeCount: i % 7 === 3 ? 0 : 1 + (i % 4),
}))

export const DASHBOARD: DashboardData = {
  allTime: { totalVolume: 16_558.2, totalFees: 16.5, tradeCount: 69, uniqueWallets: 10 },
  last24h: { totalVolume: 1_204.5, totalFees: 1.2, tradeCount: 4, uniqueWallets: 3 },
  last7d: { totalVolume: 3_870.11, totalFees: 3.9, tradeCount: 0, uniqueWallets: 0 },
  last30d: { totalVolume: 12_480_000, totalFees: 12480, tradeCount: 41, uniqueWallets: 8 },
  bySource: [
    { source: 'kyberswap', tradeCount: 47, volumeUsd: 9_000, winRate: 68 },
    { source: 'velora', tradeCount: 18, volumeUsd: 5_000, winRate: 26.4 },
    { source: 'uniswapv3', tradeCount: 4, volumeUsd: 2_000, winRate: 5.6 },
    { source: 'paraswap', tradeCount: 1, volumeUsd: 100, winRate: 0.4 },
  ] as DashboardData['bySource'],
  byHour: [],
  topPairs: [
    { pair: 'ETH/WETH', tradeCount: 8, volumeUsd: 4_100 },
    { pair: 'ETH/reUSD', tradeCount: 3, volumeUsd: 2_950.5 },
    { pair: 'USDT/reUSD', tradeCount: 3, volumeUsd: 2_000 },
    { pair: 'CRV/USDC', tradeCount: 2, volumeUsd: 1_200 },
    { pair: 'USDC/reUSD', tradeCount: 2, volumeUsd: 900 },
    { pair: 'ETH/SKY', tradeCount: 2, volumeUsd: 250.25 },
    { pair: 'SEVENTH/PAIR', tradeCount: 1, volumeUsd: 12 },
  ],
  wallets: [],
  totalWallets: 0,
  recentTrades: TRADES,
  dailyVolume: DAILY,
}

export const EMPTY_DASHBOARD: DashboardData = {
  ...DASHBOARD,
  allTime: { totalVolume: 0, totalFees: 0, tradeCount: 0, uniqueWallets: 0 },
  bySource: [],
  topPairs: [],
  recentTrades: [],
  dailyVolume: [],
}

export const STATS: PublicStatsPayload = {
  enabled: true,
  totalSwaps: 69,
  totalQuotes: 1_842,
  topSwapSources: [['kyberswap', 47], ['velora', 18], ['uniswap_v3', 4]],
  topQuoteWinners: [['velora', 900], ['kyberswap', 700], ['paraswap', 0]],
  gasless: { totalGaslessSwaps: 12, totalGasSavedUsd: 38.75, gaslessRatio: 0.1739, avgGasSavingsPerSwap: 3.23 },
}

export const PERSONAL: PersonalAnalytics = {
  wallet: '0xd44d00000000000000000000000000000000962d',
  totalSwaps: 14,
  totalVolumeUsd: 2_480.5,
  totalGasSavedUsd: 12.4,
  gaslessSwapCount: 1,
  gaslessRatio: 1 / 14,
  sourceWinRates: { velora: 57.142, kyberswap: 28.571, paraswap: 7.1, uniswap_v3: 3.5, odos: 2.1, sixth: 1.0 },
  topPairs: [
    { pair: 'ETH/USDC', count: 6, volumeUsd: 1_800 },
    { pair: 'USDC/WETH', count: 3, volumeUsd: 500.5 },
  ],
  bestHour: 0,
  bestDayOfWeek: 1,
  periodStart: '2026-09-13T08:00:00.000Z',
  periodEnd: '2026-11-03T08:00:00.000Z',
  lastUpdated: '2026-11-04T11:00:00.000Z',
}
