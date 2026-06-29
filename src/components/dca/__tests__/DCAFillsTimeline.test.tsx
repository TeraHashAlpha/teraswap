// @vitest-environment jsdom
/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] DCAFillsTimeline — per-fill detail, newest first. amountIn→amountOut
 * (real decimals), per-fill USD via fillUsd ("—" when unknown, never a fabricated $0), SUCCESS/FAILED
 * pill, and a chain-aware BaseScan link.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import DCAFillsTimeline from '../DCAFillsTimeline'
import { explorerTxUrl } from '@/lib/chains/tokens'
import type { FillRow } from '@/hooks/useOrderExecutions'

const BASE = 8453

function fill(n: number, over: Partial<FillRow> = {}): FillRow {
  return {
    id: `f${n}`, execution_number: n, tx_hash: `0x${'a'.repeat(63)}${n}`,
    amount_in: '1000000', amount_out: '300000000000000', status: 'confirmed',
    created_at: `2026-06-0${n}T00:00:00Z`, ...over,
  }
}

function renderTimeline(fills: FillRow[], over: Partial<{ tokenInSymbol: string }> = {}) {
  return render(
    <DCAFillsTimeline
      fills={fills}
      tokenInSymbol={over.tokenInSymbol ?? 'USDC'}
      tokenInDecimals={6}
      tokenOutSymbol="WETH"
      tokenOutDecimals={18}
      chainId={BASE}
    />,
  )
}

describe('DCAFillsTimeline', () => {
  it('renders fills NEWEST first', () => {
    renderTimeline([fill(1), fill(2), fill(3)])
    const rows = screen.getAllByTestId('fill-row')
    expect(within(rows[0]).getByText(/#3/)).toBeInTheDocument()
    expect(within(rows[2]).getByText(/#1/)).toBeInTheDocument()
  })

  it('shows per-fill USD via fillUsd for a priced token', () => {
    renderTimeline([fill(1)]) // 1 USDC → ~$1
    expect(screen.getByTestId('fill-usd')).toHaveTextContent('~$1')
  })

  it('shows "—" (never $0) when the token has no known price', () => {
    renderTimeline([fill(1)], { tokenInSymbol: 'ETHFI' })
    const usd = screen.getByTestId('fill-usd')
    expect(usd).toHaveTextContent('—')
    expect(usd).not.toHaveTextContent('$0')
  })

  it('links the tx to the chain-aware explorer (BaseScan for 8453)', () => {
    renderTimeline([fill(1)])
    const link = screen.getByTestId('fill-row').querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(explorerTxUrl(fill(1).tx_hash!, BASE))
  })

  it('marks a failed fill with a FAILED pill', () => {
    renderTimeline([fill(1, { status: 'failed' })])
    expect(screen.getByTestId('fill-row')).toHaveTextContent(/failed/i)
  })

  it('renders nothing when there are no fills', () => {
    const { container } = renderTimeline([])
    expect(container.querySelector('[data-testid="fill-row"]')).toBeNull()
  })
})
