// @vitest-environment jsdom
/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] DCADashboard — composes the Positions tab: active orders render the
 * rich MissionControlCard, history keeps the existing DCAOrderCard; preserves Cancel All / Remove All
 * gating and the empty-state copy + Create CTA.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DCADashboard from '../DCADashboard'
import type { AutonomousOrder } from '@/lib/order-engine'

// Stub the two card types so this test focuses on composition (not card internals / fetches).
vi.mock('../MissionControlCard', () => ({ default: ({ order }: { order: AutonomousOrder }) => <div data-testid="mission-card">{order.id}</div> }))
vi.mock('../DCAOrderCard', () => ({ default: ({ order }: { order: AutonomousOrder }) => <div data-testid="history-card">{order.id}</div> }))

function order(id: string, status: AutonomousOrder['status']): AutonomousOrder {
  return { id, status } as AutonomousOrder
}
const noop = { onCancel: vi.fn(), onCancelAll: vi.fn(), onRemove: vi.fn() }

describe('DCADashboard', () => {
  it('renders active orders as MissionControlCard and history as DCAOrderCard', () => {
    render(<DCADashboard active={[order('a1', 'active'), order('a2', 'active')]} history={[order('h1', 'filled')]} {...noop} />)
    expect(screen.getAllByTestId('mission-card')).toHaveLength(2)
    expect(screen.getAllByTestId('history-card')).toHaveLength(1)
  })

  it('shows "Cancel All" only when more than one active order', () => {
    const { rerender } = render(<DCADashboard active={[order('a1', 'active')]} history={[]} {...noop} />)
    expect(screen.queryByRole('button', { name: /cancel all/i })).toBeNull()
    rerender(<DCADashboard active={[order('a1', 'active'), order('a2', 'active')]} history={[]} {...noop} />)
    expect(screen.getByRole('button', { name: /cancel all/i })).toBeInTheDocument()
  })

  it('shows "Remove All" only when more than one history order', () => {
    const { rerender } = render(<DCADashboard active={[]} history={[order('h1', 'filled')]} {...noop} />)
    expect(screen.queryByRole('button', { name: /remove all/i })).toBeNull()
    rerender(<DCADashboard active={[]} history={[order('h1', 'filled'), order('h2', 'cancelled')]} {...noop} />)
    expect(screen.getByRole('button', { name: /remove all/i })).toBeInTheDocument()
  })

  it('empty state keeps the existing copy and offers a Create CTA', () => {
    const onCreate = vi.fn()
    render(<DCADashboard active={[]} history={[]} {...noop} onCreate={onCreate} />)
    expect(screen.getByText(/no dca positions yet/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /start (a )?dca|create/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('Cancel All triggers onCancelAll', () => {
    const onCancelAll = vi.fn()
    render(<DCADashboard active={[order('a1', 'active'), order('a2', 'active')]} history={[]} onCancel={vi.fn()} onCancelAll={onCancelAll} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel all/i }))
    expect(onCancelAll).toHaveBeenCalledTimes(1)
  })
})
