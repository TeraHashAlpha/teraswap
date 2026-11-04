// @vitest-environment jsdom
/**
 * [fix/tx-links-remaining] AdminMonitor's trade-feed tx link used to be mainnet-only
 * (`ETHERSCAN_TX`) — a Base/Arbitrum trade linked to etherscan.io, where it doesn't exist. It now
 * uses `TradeEvent.chainId` (required, server-populated from `row.chain_id` — `analytics-tracker.ts`)
 * via the chain-aware `explorerTxUrl`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useAnalyticsMock = vi.fn()
vi.mock('@/hooks/useAnalytics', () => ({ useAnalytics: () => useAnalyticsMock() }))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import AdminMonitor from './AdminMonitor'
import type { DashboardData, PeriodMetrics, TradeEvent } from '@/lib/analytics-types'

function periodMetrics(): PeriodMetrics {
  return { totalVolume: 0, totalFees: 0, tradeCount: 0, uniqueWallets: 0 }
}

function trade(chainId: number, txHash: string): TradeEvent {
  return {
    id: `trade-${chainId}`,
    type: 'swap',
    wallet: '0x1111111111111111111111111111111111111111',
    timestamp: Date.now(),
    hour: 0,
    tokenIn: 'ETH', tokenInAddress: '0x0',
    tokenOut: 'USDC', tokenOutAddress: '0x1',
    amountIn: '1', amountOut: '2950',
    volumeUsd: 2950,
    feeUsd: 2.95,
    source: '1inch',
    txHash,
    chainId,
  }
}

function dashboard(trades: TradeEvent[]): DashboardData {
  return {
    allTime: periodMetrics(), last24h: periodMetrics(), last7d: periodMetrics(), last30d: periodMetrics(),
    bySource: [], byHour: [], topPairs: [], wallets: [], totalWallets: 0,
    recentTrades: trades,
    dailyVolume: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

function openActivityTab() {
  fireEvent.click(screen.getByText('Activity'))
}

const EXPLORER_HOST: Record<number, string> = { 1: 'etherscan.io', 8453: 'basescan.org', 42161: 'arbiscan.io' }

describe('AdminMonitor — [fix/tx-links-remaining] trade-feed tx link is chain-aware, not etherscan-only', () => {
  it.each([1, 8453, 42161])("a trade on chain %i links to that chain's own explorer", (chainId) => {
    useAnalyticsMock.mockReturnValue({ dashboard: dashboard([trade(chainId, '0xabc')]), loading: false, exportSnapshot: vi.fn(), refresh: vi.fn() })
    renderWithProviders(<AdminMonitor />)
    openActivityTab()
    const link = screen.getByText('↗').closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe(EXPLORER_HOST[chainId])
  })
})
