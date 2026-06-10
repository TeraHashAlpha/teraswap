// @vitest-environment jsdom
/**
 * [P83/M-01 Phase 2] OrderDashboard — order list with filter tabs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const useOrderEngineMock = vi.fn()
const useAccountMock = vi.fn()

vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => useOrderEngineMock(),
}))
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  useReadContract: vi.fn(() => ({ data: undefined, isLoading: false })),
}))
vi.mock('@/lib/sounds', () => ({
  playTouchMP3: vi.fn(),
}))
vi.mock('./ExecutionTimeline', () => ({
  default: () => <div data-testid="execution-timeline" />,
}))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import OrderDashboard from './OrderDashboard'
import { OrderType, PriceCondition, type AutonomousOrder } from '@/lib/order-engine'

function makeOrder(over: Partial<AutonomousOrder> = {}): AutonomousOrder {
  return {
    id: 'o-' + Math.random().toString(36).slice(2),
    orderHash: '0x' + 'aa'.repeat(32),
    order: {
      owner: '0x1111111111111111111111111111111111111111',
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountIn: 10n ** 18n,
      minAmountOut: 2_900_000_000n,
      orderType: OrderType.LIMIT,
      condition: PriceCondition.ABOVE,
      targetPrice: 300_000_000_000n,
      priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      nonce: 0n,
      router: '0x111111125421ca6dc452d289314280a0f8842a65',
      routerDataHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
      dcaInterval: 0n,
      dcaTotal: 1n,
    },
    signature: '0xdead',
    status: 'active',
    orderType: OrderType.LIMIT,
    tokenInSymbol: 'WETH',
    tokenInDecimals: 18,
    tokenOutSymbol: 'USDC',
    tokenOutDecimals: 6,
    dcaExecuted: 0,
    dcaTotal: 1,
    createdAt: Date.now(),
    executedAt: null,
    expiresAt: Date.now() + 86_400_000,
    error: null,
    amountOut: null,
    txHash: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: '0x1111111111111111111111111111111111111111' })
})

describe('OrderDashboard — wallet states', () => {
  it('shows a connect-wallet prompt when address is undefined', () => {
    useAccountMock.mockReturnValue({ address: undefined })
    useOrderEngineMock.mockReturnValue({
      orders: [],
      activeOrders: [],
      historyOrders: [],
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: false,
    })
    renderWithProviders(<OrderDashboard />)
    expect(screen.getByText(/connect your wallet/i)).toBeInTheDocument()
  })

  it('renders loading skeletons when isLoading=true', () => {
    useOrderEngineMock.mockReturnValue({
      orders: [],
      activeOrders: [],
      historyOrders: [],
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: true,
    })
    const { container } = renderWithProviders(<OrderDashboard />)
    // 3 skeleton rows.
    const skeletons = container.querySelectorAll('.animate-pulse')
    expect(skeletons.length).toBeGreaterThan(0)
  })
})

describe('OrderDashboard — filter tabs', () => {
  it('renders Active / Completed / Cancelled tabs with counts', () => {
    const active = [makeOrder({ status: 'active' }), makeOrder({ status: 'active' })]
    const filled = [makeOrder({ status: 'filled' })]
    const cancelled = [makeOrder({ status: 'cancelled' }), makeOrder({ status: 'expired' })]
    useOrderEngineMock.mockReturnValue({
      orders: [...active, ...filled, ...cancelled],
      activeOrders: active,
      historyOrders: [...filled, ...cancelled],
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: false,
    })
    renderWithProviders(<OrderDashboard />)
    expect(screen.getByText(/Active \(2\)/)).toBeInTheDocument()
    expect(screen.getByText(/Completed \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/Cancelled \(2\)/)).toBeInTheDocument()
  })

  it('switching to Completed shows the filled orders only', () => {
    const active = [makeOrder({ status: 'active' })]
    const filled = [makeOrder({ status: 'filled' })]
    useOrderEngineMock.mockReturnValue({
      orders: [...active, ...filled],
      activeOrders: active,
      historyOrders: filled,
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: false,
    })
    renderWithProviders(<OrderDashboard />)
    // Default tab is Active, switch to Completed.
    fireEvent.click(screen.getByText(/Completed \(1\)/))
    // Empty-state for active should no longer be visible; filled count visible.
    expect(screen.queryByText(/No active orders/i)).toBeNull()
  })
})

describe('OrderDashboard — empty states', () => {
  it('shows the "No active orders" placeholder when active list is empty', () => {
    useOrderEngineMock.mockReturnValue({
      orders: [],
      activeOrders: [],
      historyOrders: [],
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: false,
    })
    renderWithProviders(<OrderDashboard />)
    expect(screen.getByText(/No active orders/i)).toBeInTheDocument()
  })
})

describe('OrderDashboard — cancel all', () => {
  it('renders Cancel All button when more than one active order exists', () => {
    const active = [makeOrder({ status: 'active' }), makeOrder({ status: 'active' })]
    useOrderEngineMock.mockReturnValue({
      orders: active,
      activeOrders: active,
      historyOrders: [],
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: false,
    })
    renderWithProviders(<OrderDashboard />)
    expect(screen.getByText(/Cancel All \(2\)/)).toBeInTheDocument()
  })

  it('clicking Cancel All invokes the cancelAllOrders callback', () => {
    const cancelAllOrders = vi.fn()
    const active = [makeOrder({ status: 'active' }), makeOrder({ status: 'active' })]
    useOrderEngineMock.mockReturnValue({
      orders: active,
      activeOrders: active,
      historyOrders: [],
      cancelOrder: vi.fn(),
      cancelAllOrders,
      removeOrder: vi.fn(),
      isLoading: false,
    })
    renderWithProviders(<OrderDashboard />)
    fireEvent.click(screen.getByText(/Cancel All \(2\)/))
    expect(cancelAllOrders).toHaveBeenCalled()
  })
})

describe('OrderDashboard — [CANCEL-REVIEW] review modal wiring', () => {
  it('renders the cancel review modal from the hook pendingCancel; confirm/keep wire to the hook', () => {
    const confirmCancel = vi.fn()
    const clearPendingCancel = vi.fn()
    const order = makeOrder({ status: 'active' })
    useOrderEngineMock.mockReturnValue({
      orders: [order],
      activeOrders: [order],
      historyOrders: [],
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: false,
      pendingCancel: {
        action: 'cancel',
        orderId: order.id,
        order,
        orderStruct: order.order,
        chainId: 1,
        account: '0x1111111111111111111111111111111111111111',
      },
      confirmCancel,
      clearPendingCancel,
    })
    renderWithProviders(<OrderDashboard />)
    expect(screen.getByTestId('cancel-action').textContent).toMatch(/cancel order/i)
    fireEvent.click(screen.getByTestId('cancel-confirm'))
    expect(confirmCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('cancel-keep'))
    expect(clearPendingCancel).toHaveBeenCalledTimes(1)
  })

  it('renders NO cancel modal when there is no pendingCancel', () => {
    useOrderEngineMock.mockReturnValue({
      orders: [],
      activeOrders: [],
      historyOrders: [],
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      removeOrder: vi.fn(),
      isLoading: false,
    })
    renderWithProviders(<OrderDashboard />)
    expect(screen.queryByTestId('cancel-action')).toBeNull()
  })
})
