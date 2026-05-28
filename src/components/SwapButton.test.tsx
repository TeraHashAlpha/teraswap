// @vitest-environment jsdom
/**
 * [P115/M-01] SwapButton — the cascading-state CTA.
 *
 * The button surfaces every relevant state of the swap pipeline:
 * wallet disconnected, wrong chain, no amount, no balance, price
 * blocked, approval pending, swap running, error. Tests assert the
 * text/disabled state of each branch and that click handlers fire
 * correctly when enabled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// Wagmi + rainbowkit mocks — must hoist before component import.
let mockIsConnected = true
let mockChainId: number | undefined = 1
const mockOpenConnectModal = vi.fn()
const mockSwitchChain = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    isConnected: mockIsConnected,
    chain: mockChainId === undefined ? undefined : { id: mockChainId, name: 'mock' },
  })),
  useChains: vi.fn(() => [{ id: 1, name: 'Ethereum' }]),
  useSwitchChain: vi.fn(() => ({ switchChain: mockSwitchChain })),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: vi.fn(() => ({ openConnectModal: mockOpenConnectModal })),
}))

// Touch-MP3 sound effect — no-op in tests.
vi.mock('@/lib/sounds', () => ({
  playTouchMP3: vi.fn(),
}))

import SwapButton from './SwapButton'

type SwapStatus =
  | 'idle' | 'fetching_swap' | 'simulating' | 'confirming'
  | 'swapping' | 'cow_signing' | 'cow_pending' | 'success' | 'error'

type ApprovalStatus =
  | 'idle' | 'checking' | 'approving_permit2'
  | 'awaiting_permit2_education' | 'signing' | 'ready' | 'error'

// Defaults that put the button in the "ready to Swap" state.
const baseProps = {
  swapStatus: 'idle' as SwapStatus,
  approvalStatus: 'ready' as ApprovalStatus,
  approvalReady: true,
  hasAmount: true,
  hasSufficientBalance: true,
  hasQuote: true,
  quoteLoading: false,
  priceBlocked: false,
  onApprove: vi.fn(),
  onSwap: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsConnected = true
  mockChainId = 1
})

describe('SwapButton', () => {
  it('shows "Connect Wallet" when no wallet is connected', () => {
    mockIsConnected = false
    mockChainId = undefined
    render(<SwapButton {...baseProps} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/connect wallet/i)
    expect(btn).not.toBeDisabled()
  })

  it('shows "Switch to Ethereum" on the wrong chain', () => {
    mockChainId = 137 // polygon — not mainnet
    render(<SwapButton {...baseProps} />)
    expect(screen.getByRole('button')).toHaveTextContent(/switch to ethereum/i)
  })

  it('clicking "Connect Wallet" opens the RainbowKit modal', () => {
    mockIsConnected = false
    mockChainId = undefined
    render(<SwapButton {...baseProps} />)
    fireEvent.click(screen.getByRole('button'))
    expect(mockOpenConnectModal).toHaveBeenCalledTimes(1)
  })

  it('clicking "Switch to Ethereum" calls switchChain with mainnet', () => {
    mockChainId = 137
    render(<SwapButton {...baseProps} />)
    fireEvent.click(screen.getByRole('button'))
    expect(mockSwitchChain).toHaveBeenCalledWith({ chainId: 1 })
  })

  it('shows "Enter amount" disabled when hasAmount=false', () => {
    render(<SwapButton {...baseProps} hasAmount={false} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/enter amount/i)
    expect(btn).toBeDisabled()
  })

  it('shows "Insufficient balance" disabled', () => {
    render(<SwapButton {...baseProps} hasSufficientBalance={false} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/insufficient balance/i)
    expect(btn).toBeDisabled()
  })

  it('shows "Finding best route..." disabled while loading a quote', () => {
    render(<SwapButton {...baseProps} quoteLoading hasQuote={false} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/finding best route/i)
    expect(btn).toBeDisabled()
  })

  it('shows "No quotes available" disabled when no quote returned', () => {
    render(<SwapButton {...baseProps} hasQuote={false} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/no quotes available/i)
    expect(btn).toBeDisabled()
  })

  it("disables and explains when price-blocked with reason='danger'", () => {
    render(<SwapButton {...baseProps} priceBlocked blockReason="danger" />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/blocked/i)
    expect(btn).toBeDisabled()
  })

  it("disables and warns differently when price-blocked with reason='oracle'", () => {
    render(<SwapButton {...baseProps} priceBlocked blockReason="oracle" />)
    expect(screen.getByRole('button')).toHaveTextContent(/no oracle/i)
  })

  it('shows "Approve & Swap" when approval is not yet ready', () => {
    render(<SwapButton {...baseProps} approvalReady={false} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/approve & swap/i)
    expect(btn).not.toBeDisabled()
  })

  it('clicking "Approve & Swap" fires onApprove', () => {
    const onApprove = vi.fn()
    render(<SwapButton {...baseProps} approvalReady={false} onApprove={onApprove} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('shows "Swap" enabled when everything is ready', () => {
    render(<SwapButton {...baseProps} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/^swap$/i)
    expect(btn).not.toBeDisabled()
  })

  it('clicking "Swap" fires onSwap', () => {
    const onSwap = vi.fn()
    render(<SwapButton {...baseProps} onSwap={onSwap} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onSwap).toHaveBeenCalledTimes(1)
  })

  it('shows "Error — retry" enabled after a swap error', () => {
    render(<SwapButton {...baseProps} swapStatus="error" />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveTextContent(/retry/i)
    expect(btn).not.toBeDisabled()
  })

  it('shows the CoW stepper when swapStatus=cow_signing', () => {
    render(<SwapButton {...baseProps} swapStatus="cow_signing" />)
    expect(screen.getByText(/sign order in wallet/i)).toBeInTheDocument()
    // CoW two-step UI surfaces "Solver fills" text.
    expect(screen.getByText(/solver fills/i)).toBeInTheDocument()
  })

  it('renders the approve→swap stepper while approving', () => {
    render(<SwapButton {...baseProps} approvalStatus="approving_permit2" />)
    // Both step labels visible during the cascade.
    expect(screen.getByText(/1\. approve/i)).toBeInTheDocument()
    expect(screen.getByText(/2\. swap/i)).toBeInTheDocument()
  })

  it('shows the "Exact approval only" disclaimer when approval is needed', () => {
    render(<SwapButton {...baseProps} approvalReady={false} />)
    expect(
      screen.getByText(/exact approval only/i),
    ).toBeInTheDocument()
  })
})
