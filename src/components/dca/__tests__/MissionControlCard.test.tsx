// @vitest-environment jsdom
/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] MissionControlCard — per active DCA order. Verifies the state matrix
 * (active countdown / completed / failed / signing), the next-buy anchor (0-fill = createdAt+interval;
 * ≥1 fill = lastFill+interval), the ring progress, and that cancel/remove wire through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MissionControlCard from '../MissionControlCard'
import { OrderType } from '@/lib/order-engine'
import type { AutonomousOrder } from '@/lib/order-engine'

// Control the shared executions hook so we can set fills / lastFillAtMs deterministically.
const execMock = vi.fn()
vi.mock('@/hooks/useOrderExecutions', () => ({ useOrderExecutions: (...a: unknown[]) => execMock(...a) }))
// Avoid TokenLogo's image/network fallback chain in jsdom.
vi.mock('@/components/TokenLogo', () => ({ default: ({ token }: { token: { symbol: string } }) => <span data-testid="logo">{token.symbol}</span> }))

const BASE = 1_700_000_000_000
const OWNER = '0x1111111111111111111111111111111111111111'

function makeOrder(over: Partial<AutonomousOrder> = {}, orderOver: Record<string, unknown> = {}): AutonomousOrder {
  return {
    id: 'o1',
    orderHash: '0x' + 'aa'.repeat(32),
    order: {
      owner: OWNER,
      // Low-entropy placeholder (USDC by symbol/decimals below; the address itself is never asserted).
      // A real high-entropy address here trips gitleaks' generic-api-key heuristic — see FEEDBACK.
      tokenIn: '0x2222222222222222222222222222222222222222',
      tokenOut: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      amountIn: 200_000000n, // 200 USDC (6dp)
      minAmountOut: 1n,
      orderType: OrderType.DCA,
      condition: 0,
      targetPrice: 0n,
      priceFeed: '0x0000000000000000000000000000000000000000',
      expiry: BigInt(Math.floor(BASE / 1000) + 7 * 86400),
      nonce: 1n,
      router: '0x6A000F20005980200259B80c5102003040001068', // Velora Augustus V6 (Base)
      routerDataHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
      dcaInterval: 2n * 3600n, // 2h
      dcaTotal: 8n,
      ...orderOver,
    } as AutonomousOrder['order'],
    signature: '0x',
    status: 'active',
    chainId: 8453,
    orderType: OrderType.DCA,
    tokenInSymbol: 'USDC',
    tokenInDecimals: 6,
    tokenOutSymbol: 'ETH',
    tokenOutDecimals: 18,
    dcaExecuted: 3,
    dcaTotal: 8,
    createdAt: BASE,
    executedAt: null,
    expiresAt: BASE + 7 * 86400 * 1000,
    error: null,
    amountOut: null,
    txHash: null,
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(BASE)
  execMock.mockReturnValue({ executions: [], orderMeta: { chain_id: 8453 }, lastFillAtMs: null, loading: false })
})
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function arcOffsetRatio() {
  const arc = screen.getByTestId('ring-arc')
  const dash = parseFloat(arc.getAttribute('stroke-dasharray') || '0')
  const offset = parseFloat((arc as unknown as SVGCircleElement).style.strokeDashoffset || '0')
  return offset / dash
}

describe('MissionControlCard — countdown anchor', () => {
  it('0 fills → anchors the countdown to createdAt + interval', () => {
    execMock.mockReturnValue({ executions: [], orderMeta: {}, lastFillAtMs: null, loading: false })
    render(<MissionControlCard order={makeOrder()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('countdown')).toHaveTextContent('02:00:00') // now=createdAt, +2h
  })

  it('≥1 fill → anchors to last fill created_at + interval', () => {
    execMock.mockReturnValue({ executions: [{ id: 'f1' }], orderMeta: {}, lastFillAtMs: BASE - 3600 * 1000, loading: false })
    render(<MissionControlCard order={makeOrder()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('countdown')).toHaveTextContent('01:00:00') // lastFill(now-1h)+2h = now+1h
  })
})

describe('MissionControlCard — states', () => {
  it('active → Cancel wired; ring at dcaExecuted/dcaTotal', () => {
    const onCancel = vi.fn()
    render(<MissionControlCard order={makeOrder({ dcaExecuted: 3, dcaTotal: 8 })} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(arcOffsetRatio()).toBeCloseTo(1 - 3 / 8, 2)
  })

  it('completed → "Completed", no countdown, Remove wired', () => {
    const onRemove = vi.fn()
    render(<MissionControlCard order={makeOrder({ status: 'filled', dcaExecuted: 8, dcaTotal: 8 })} onRemove={onRemove} />)
    expect(screen.queryByTestId('countdown')).toBeNull()
    expect(screen.getByTestId('countdown-terminal')).toHaveTextContent('Completed')
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('failed → shows a reason banner even when error is null', () => {
    render(<MissionControlCard order={makeOrder({ status: 'error', error: null })} onRemove={vi.fn()} />)
    expect(screen.getByTestId('failed-banner')).toHaveTextContent(/could not be executed/i)
  })

  it('signing → "Preparing…", neither Cancel nor Remove', () => {
    render(<MissionControlCard order={makeOrder({ status: 'signing' })} onCancel={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByTestId('countdown-terminal')).toHaveTextContent(/preparing/i)
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull()
  })
})
