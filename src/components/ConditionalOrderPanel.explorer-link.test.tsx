// @vitest-environment jsdom
/**
 * [fix/tx-links-remaining] ConditionalOrderPanel's filled-order tx link used to be mainnet-only
 * (`ETHERSCAN_TX`) — a Base/Arbitrum fill linked to etherscan.io, where it doesn't exist. It now
 * uses the order's own `chainId` (carried from Supabase at creation — `orders.chain_id`, immutable
 * after the order is placed) via the chain-aware `explorerTxUrl`, never the connected wallet's
 * live chain. Mirrors the ConditionalOrderPanel.test.tsx mock boilerplate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useOrderEngineMock = vi.fn()
const useAccountMock = vi.fn()
let mockChainId = 1
const useChainIdMock = vi.fn(() => mockChainId)
const useConnectModalMock = vi.fn(() => ({ openConnectModal: vi.fn() }))
const useOrderNotificationsMock = vi.fn()

vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => useOrderEngineMock(),
}))
vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: vi.fn().mockResolvedValue(undefined) }),
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => useConnectModalMock(),
  ConnectButton: () => <button data-testid="rk-connect">Connect</button>,
}))
vi.mock('@/lib/price-monitor', () => ({
  getTokenPriceUSD: vi.fn().mockResolvedValue(0),
}))
vi.mock('@/lib/sounds', () => ({
  playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(),
  playClick: vi.fn(),
  stopWaitingSound: vi.fn(),
  startWaitingSound: vi.fn(),
  playTouchMP3: vi.fn(),
}))
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected }: { selected: { symbol?: string } | null }) => (
    <div data-testid="token-selector">{selected?.symbol ?? 'Select'}</div>
  ),
}))
vi.mock('@/components/BetaDisclaimer', () => ({
  default: () => <div data-testid="beta-disclaimer" />,
}))
vi.mock('@/hooks/useOrderNotifications', () => ({
  useOrderNotifications: (...args: unknown[]) => useOrderNotificationsMock(...args),
}))
vi.mock('@/lib/analytics-tracker', () => ({
  trackTrade: vi.fn(),
}))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: vi.fn(() => ({ mode: 'ok', divergence: 0, symbol: '', message: null })) }))
vi.mock('@/components/ToastProvider', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), update: vi.fn() }),
}))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import ConditionalOrderPanel from './ConditionalOrderPanel'

function defaultEngine() {
  return {
    orders: [], activeOrders: [], historyOrders: [], limitOrders: [], stopLossOrders: [], dcaOrders: [],
    latestEvent: null, isSubmitting: false, isLoading: false, currentNonce: 0n,
    createOrder: vi.fn(), cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), removeOrder: vi.fn(),
  }
}

/** A minimal filled take-profit order (history-tab eligible: status 'filled'). */
function filledOrder(chainId: number, txHash: string) {
  return {
    id: `order-${chainId}`,
    orderHash: '0xhash',
    order: {},
    signature: '0xsig',
    status: 'filled' as const,
    orderType: 'take_profit' as const,
    chainId,
    tokenInSymbol: 'ETH',
    tokenInDecimals: 18,
    tokenOutSymbol: 'USDC',
    tokenOutDecimals: 6,
    dcaExecuted: 0,
    dcaTotal: 0,
    createdAt: Date.now(),
    executedAt: Date.now(),
    expiresAt: Date.now() + 1000,
    error: null,
    amountOut: '100',
    txHash,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockChainId = 1
  useOrderEngineMock.mockReturnValue(defaultEngine())
  useAccountMock.mockReturnValue({ address: '0x1111111111111111111111111111111111111111', isConnected: true })
})

function openOrdersTab() {
  const ordersTab = screen.getAllByRole('button').find((b) => /^Orders/.test(b.textContent ?? ''))!
  fireEvent.click(ordersTab)
}

const EXPLORER_HOST: Record<number, string> = { 1: 'etherscan.io', 8453: 'basescan.org', 42161: 'arbiscan.io' }

describe('ConditionalOrderPanel — [fix/tx-links-remaining] filled-order tx link is chain-aware, not etherscan-only', () => {
  it.each([1, 8453, 42161])("a filled order on chain %i links to that chain's own explorer", (chainId) => {
    useOrderEngineMock.mockReturnValue({ ...defaultEngine(), stopLossOrders: [filledOrder(chainId, '0xabc')] })
    renderWithProviders(<ConditionalOrderPanel />, { toast: false })
    openOrdersTab()
    const link = screen.getByText(/View on explorer/i).closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe(EXPLORER_HOST[chainId])
  })

  it('order filled on Arbitrum (42161) while the connected wallet is on Base (8453) → link stays on arbiscan.io', () => {
    mockChainId = 8453 // the connected wallet's chain — must NOT drive the explorer link
    useOrderEngineMock.mockReturnValue({ ...defaultEngine(), stopLossOrders: [filledOrder(42161, '0xabc')] })
    renderWithProviders(<ConditionalOrderPanel />, { toast: false })
    openOrdersTab()
    const link = screen.getByText(/View on explorer/i).closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe('arbiscan.io')
  })
})
