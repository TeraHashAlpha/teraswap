// @vitest-environment jsdom
/**
 * DCAPositionStats — portfolio-chain eligibility for the P&L-vs-spot price
 * fetch. The stats block itself renders purely from `fills` (chain-agnostic);
 * only the live price fetch is gated by isPortfolioSupportedChain(chainId)
 * (see [E-3] in the component). Arbitrum One (42161) just joined
 * PORTFOLIO_SUPPORTED_CHAINS — pin that it fires the fetch there, and still
 * does not for a chain outside the set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import DCAPositionStats from './DCAPositionStats'
import type { FillRow } from '@/hooks/useOrderExecutions'

const FILLS: FillRow[] = [
  {
    id: '1',
    execution_number: 1,
    tx_hash: '0xabc',
    amount_in: String(10n * 10n ** 6n),
    amount_out: String(5n * 10n ** 18n),
    status: 'confirmed',
    created_at: '2026-09-01T00:00:00Z',
  },
]

function renderStats(chainId: number) {
  return render(
    <DCAPositionStats
      orderId="order-1"
      wallet="0x1111111111111111111111111111111111111111"
      tokenIn="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      tokenOut="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
      tokenInSymbol="USDC"
      tokenOutSymbol="WETH"
      tokenInDecimals={6}
      tokenOutDecimals={18}
      chainId={chainId}
      dcaTotal={1}
      fills={FILLS}
    />,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prices: {} }) }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DCAPositionStats — portfolio chain eligibility', () => {
  it('fetches spot prices for chainId=42161 (Arbitrum One is now portfolio-supported)', () => {
    renderStats(42161)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toContain('chainId=42161')
  })

  it('does not fetch spot prices for an unsupported chain (e.g. Optimism, 10)', () => {
    renderStats(10)
    expect(fetch).not.toHaveBeenCalled()
  })
})
