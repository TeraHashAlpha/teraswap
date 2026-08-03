// @vitest-environment jsdom
/**
 * [CHORE-ARBITRUM-UI-POLISH] SwapHistory ("Recent swaps") regression tests.
 *
 * Found live during the Arbitrum Preview smoke: the collapse arrow / status icons were
 * emitted as HTML-entity STRINGS ("&#9650;", "&#10003;") inside JSX text, which React
 * renders LITERALLY (JSX text does not decode entities the way raw HTML does) — users saw
 * the entity text instead of ▲/✓. Amounts also rendered the raw 18-decimal value
 * ("6.209408912329324625 ARB") instead of going through the app's amount-format helper.
 * These tests pin the fix so neither regresses.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useSwapHistory, type SwapRecord } from '@/hooks/useSwapHistory'
import SwapHistory from './SwapHistory'

function seedRecord(overrides: Partial<SwapRecord> = {}) {
  useSwapHistory.getState().addRecord({
    id: '1',
    date: '2026-07-17',
    tokenIn: 'WETH',
    tokenOut: 'ARB',
    amountIn: '1.000000000000000000',
    amountOut: '6.209408912329324625',
    txHash: '0xabc',
    status: 'confirmed',
    chainId: 42161,
    ...overrides,
  })
}

describe('SwapHistory — entity + amount-formatting fixes [CHORE-ARBITRUM-UI-POLISH]', () => {
  beforeEach(() => {
    useSwapHistory.setState({ records: [] })
  })

  it('renders real Unicode chars, not literal HTML-entity text, for the collapse arrow', () => {
    seedRecord()
    render(<SwapHistory />)
    expect(screen.getByText('▼')).toBeInTheDocument()
    expect(screen.queryByText('&#9660;')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Recent swaps (1)'))
    expect(screen.getByText('▲')).toBeInTheDocument()
  })

  it('renders the status icon as a real Unicode char, not entity text', () => {
    seedRecord({ status: 'confirmed' })
    render(<SwapHistory />)
    fireEvent.click(screen.getByText('Recent swaps (1)'))
    expect(screen.getByText('✓')).toBeInTheDocument()
    expect(screen.queryByText('&#10003;')).not.toBeInTheDocument()
  })

  it('truncates the raw 18-decimal amount to a display-friendly precision', () => {
    seedRecord()
    render(<SwapHistory />)
    fireEvent.click(screen.getByText('Recent swaps (1)'))
    // formatDisplay defaults to 4 decimals — the raw 18-decimal value must not appear.
    expect(screen.queryByText(/6\.209408912329324625/)).not.toBeInTheDocument()
    expect(screen.getByText(/6\.2094\s*ARB/)).toBeInTheDocument()
  })
})
