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

// Wagmi mock used ONLY by the wallet-switch test below, to prove AdminMonitor's trade-feed links
// are inert to it — AdminMonitor itself never imports wagmi (confirmed: no useAccount/useChainId),
// so this models the surrounding app's live wallet state, not AdminMonitor's own.
let mockWalletChainId = 1
vi.mock('wagmi', () => ({
  useAccount: () => ({ chain: { id: mockWalletChainId } }),
}))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import { useAccount } from 'wagmi'
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

describe('AdminMonitor: [fix/tx-links-remaining] trade-feed tx link is chain-aware, not etherscan-only', () => {
  it.each([1, 8453, 42161])("a trade on chain %i links to that chain's own explorer", (chainId) => {
    useAnalyticsMock.mockReturnValue({ dashboard: dashboard([trade(chainId, '0xabc')]), loading: false, exportSnapshot: vi.fn(), refresh: vi.fn() })
    renderWithProviders(<AdminMonitor />)
    openActivityTab()
    const link = screen.getByText('↗').closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe(EXPLORER_HOST[chainId])
  })

  it('a trade recorded on Base (8453); the wallet switches to Arbitrum (42161) AFTER → link stays on basescan.org', () => {
    mockWalletChainId = 1
    useAnalyticsMock.mockReturnValue({ dashboard: dashboard([trade(8453, '0xabc')]), loading: false, exportSnapshot: vi.fn(), refresh: vi.fn() })
    function WalletAwareApp() {
      const { chain } = useAccount()
      return (
        <>
          <span data-testid="live-wallet-chain">{chain?.id}</span>
          <AdminMonitor />
        </>
      )
    }
    const { rerender } = renderWithProviders(<WalletAwareApp />)
    openActivityTab()
    const link = screen.getByText('↗').closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe('basescan.org')

    // Wallet switches chains; the surrounding app re-renders and DOES see it (live-wallet-chain
    // below proves the switch reached the tree) — the already-recorded trade's link must not.
    mockWalletChainId = 42161
    rerender(<WalletAwareApp />)
    expect(screen.getByTestId('live-wallet-chain').textContent).toBe('42161')
    const linkAfterSwitch = screen.getByText('↗').closest('a') as HTMLAnchorElement
    expect(new URL(linkAfterSwitch.href).hostname).toBe('basescan.org')
  })
})
