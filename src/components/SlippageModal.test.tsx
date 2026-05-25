// @vitest-environment jsdom
/**
 * [P82/M-01 Phase 2] SlippageModal + calculateAutoSlippage.
 *
 * `calculateAutoSlippage` is a pure function — tested directly.
 * The modal is tested for preset selection, custom input, and the
 * auto-mode toggle.
 */

import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import SlippageModal, { calculateAutoSlippage } from './SlippageModal'

describe('calculateAutoSlippage', () => {
  it('returns 0.1 for stable-to-stable (USDC → USDT)', () => {
    expect(calculateAutoSlippage('USDC', 'USDT')).toBe(0.1)
  })

  it('returns 0.3 for major-to-stable (ETH → USDC)', () => {
    expect(calculateAutoSlippage('ETH', 'USDC')).toBe(0.3)
  })

  it('returns 0.3 for stable-to-major (USDC → WETH)', () => {
    expect(calculateAutoSlippage('USDC', 'WETH')).toBe(0.3)
  })

  it('returns 0.5 for major-to-major (ETH → WBTC)', () => {
    expect(calculateAutoSlippage('ETH', 'WBTC')).toBe(0.5)
  })

  it('returns 2.0 when a memecoin is involved (PEPE → ETH)', () => {
    expect(calculateAutoSlippage('PEPE', 'ETH')).toBe(2.0)
  })

  it('returns 2.0 when either side is a memecoin (ETH → SHIB)', () => {
    expect(calculateAutoSlippage('ETH', 'SHIB')).toBe(2.0)
  })

  it('returns 0.5 (default) for unknown pairs', () => {
    expect(calculateAutoSlippage('FOO', 'BAR')).toBe(0.5)
  })

  it('returns 0.5 (default) when inputs are undefined', () => {
    expect(calculateAutoSlippage(undefined, undefined)).toBe(0.5)
  })

  it('returns 0.5 (default) when only one input is undefined', () => {
    expect(calculateAutoSlippage('USDC', undefined)).toBe(0.5)
  })
})

describe('SlippageModal — render', () => {
  function makeProps(over: Partial<React.ComponentProps<typeof SlippageModal>> = {}) {
    return {
      value: 0.5,
      onChange: vi.fn(),
      onClose: vi.fn(),
      isAuto: false,
      onAutoChange: vi.fn(),
      tokenInSymbol: 'ETH',
      tokenOutSymbol: 'USDC',
      ...over,
    }
  }

  it('renders all four preset buttons', () => {
    renderWithProviders(<SlippageModal {...makeProps()} />)
    expect(screen.getByText('0.1%')).toBeInTheDocument()
    expect(screen.getByText('0.5%')).toBeInTheDocument()
    expect(screen.getByText('1%')).toBeInTheDocument()
    expect(screen.getByText('3%')).toBeInTheDocument()
  })

  it('clicking a preset calls onChange with the value, disables auto, and closes', () => {
    const onChange = vi.fn()
    const onAutoChange = vi.fn()
    const onClose = vi.fn()
    renderWithProviders(<SlippageModal {...makeProps({ onChange, onAutoChange, onClose })} />)

    fireEvent.click(screen.getByText('1%'))
    expect(onChange).toHaveBeenCalledWith(1)
    expect(onAutoChange).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking the Auto button toggles to auto mode with the recommended value', () => {
    const onChange = vi.fn()
    const onAutoChange = vi.fn()
    renderWithProviders(<SlippageModal {...makeProps({ onChange, onAutoChange })} />)

    // The Auto button text includes "Auto" and the auto-calculated value.
    fireEvent.click(screen.getByText(/Auto/))
    expect(onAutoChange).toHaveBeenCalledWith(true)
    // ETH → USDC auto-slippage is 0.3.
    expect(onChange).toHaveBeenCalledWith(0.3)
  })

  it('clicking the OK button after entering a custom value commits it', () => {
    const onChange = vi.fn()
    const onClose = vi.fn()
    const { container } = renderWithProviders(
      <SlippageModal {...makeProps({ onChange, onClose })} />,
    )
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!
    fireEvent.change(input, { target: { value: '2.5' } })
    fireEvent.click(screen.getByText('OK'))
    expect(onChange).toHaveBeenCalledWith(2.5)
    expect(onClose).toHaveBeenCalled()
  })

  it('clamps custom values above 15 to 15', () => {
    const onChange = vi.fn()
    const { container } = renderWithProviders(
      <SlippageModal {...makeProps({ onChange })} />,
    )
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.click(screen.getByText('OK'))
    expect(onChange).toHaveBeenCalledWith(15)
  })

  it('clicking on the backdrop closes the modal', () => {
    const onClose = vi.fn()
    const { container } = renderWithProviders(
      <SlippageModal {...makeProps({ onClose })} />,
    )
    // Click outermost wrapper (the backdrop).
    fireEvent.click(container.firstChild as Element)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the high-slippage warning when value > 5 and not in auto mode', () => {
    renderWithProviders(<SlippageModal {...makeProps({ value: 6, isAuto: false })} />)
    expect(screen.getByText(/high slippage/i)).toBeInTheDocument()
  })

  it('shows the auto-slippage hint with token symbols when in auto mode', () => {
    renderWithProviders(
      <SlippageModal {...makeProps({ isAuto: true, tokenInSymbol: 'ETH', tokenOutSymbol: 'USDC' })} />,
    )
    expect(screen.getByText(/ETH\/USDC/)).toBeInTheDocument()
  })
})
