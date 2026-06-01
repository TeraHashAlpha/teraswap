// @vitest-environment jsdom
/**
 * [SPRINT-9F] SourceToggle — the "Liquidity Sources" selector must list EVERY
 * real aggregator the engine queries, so a user can disable any of them. Bebop
 * (the 12th adapter) was missing, so users could not turn it off even though it
 * was quoting (and, when its RFQ swap data is incomplete, failing). The list
 * must match ADAPTER_REGISTRY's 12 real sources — and must NOT include the
 * `uniswap` legacy alias (a duplicate of `uniswapv3`) or the internal
 * `teraswap_order_engine` pseudo-source.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import SourceToggle, { TOGGLEABLE_SOURCES } from './SourceToggle'

describe('SourceToggle — list completeness [SPRINT-9F]', () => {
  it('includes Bebop (the 12th source) so it can be disabled', () => {
    expect(TOGGLEABLE_SOURCES).toContain('bebop')
  })

  it('lists exactly the 12 real ADAPTER_REGISTRY sources (no alias/pseudo-source)', () => {
    expect(TOGGLEABLE_SOURCES).toHaveLength(12)
    // `uniswap` is a legacy alias of `uniswapv3` in AGGREGATOR_META — must not
    // appear or "Uniswap V3" would render twice.
    expect(TOGGLEABLE_SOURCES).not.toContain('uniswap')
    // Internal engine pseudo-source must never be user-toggleable.
    expect(TOGGLEABLE_SOURCES).not.toContain('teraswap_order_engine')
  })
})

describe('SourceToggle — render + toggle [SPRINT-9F]', () => {
  it('renders the Bebop row and toggling it calls onToggle("bebop")', () => {
    const onToggle = vi.fn()
    renderWithProviders(<SourceToggle excludedSources={new Set()} onToggle={onToggle} />)
    // Open the dropdown (button shows "12/12 sources").
    fireEvent.click(screen.getByText(/\/12 sources/))
    const bebopRow = screen.getByText('Bebop').closest('button')
    expect(bebopRow).not.toBeNull()
    fireEvent.click(bebopRow!)
    expect(onToggle).toHaveBeenCalledWith('bebop')
  })

  it('counts an excluded source as disabled in the "N/12 sources" label', () => {
    renderWithProviders(<SourceToggle excludedSources={new Set(['bebop'])} onToggle={vi.fn()} />)
    expect(screen.getByText('11/12 sources')).toBeInTheDocument()
  })
})
