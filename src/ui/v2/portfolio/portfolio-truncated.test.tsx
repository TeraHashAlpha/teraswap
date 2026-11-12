// @vitest-environment jsdom
/**
 * [fix/portfolio-tokens-view] The quiet "list may be incomplete" note: shown by v1 and v2 when discovery says `truncated`, with the SAME
 * words, and absent otherwise. `usePortfolio()` is faked; wallet and chain are fakes.
 */
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, visibleTextNodes } from '../__tests__/content-parity'
import { fmtToken } from '@/lib/format'
import type { PortfolioData, PortfolioToken } from '@/hooks/usePortfolio'
import { DEFAULT_TOKENS } from '@/lib/tokens'
import { PORTFOLIO_TRUNCATED_NOTE } from '@/lib/portfolio-view'

const h = vi.hoisted(() => ({ data: null as unknown as PortfolioData }))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
}))
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => 1 }))
vi.mock('@/hooks/usePortfolio', () => ({ usePortfolio: () => h.data }))
vi.mock('@/hooks/useTokenImport', () => ({ useTokenImport: () => ({ importToken: vi.fn() }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import V1PortfolioTab from '@/components/PortfolioTab'
import { PortfolioTab as V2PortfolioTab } from './PortfolioTab'

const eth = DEFAULT_TOKENS.find((t) => t.symbol === 'ETH')!
const row: PortfolioToken = { token: eth, balance: 10n ** 18n, balanceFormatted: fmtToken(10n ** 18n, 18), priceUsd: 3000, valueUsd: 3000 }
const state = (over: Partial<PortfolioData> = {}): PortfolioData => ({
  tokens: [row], totalValueUsd: 3000, isLoading: false, isError: false, lastUpdated: new Date(), refresh: vi.fn(), isChainSupported: true, ...over,
})

beforeEach(() => { h.data = state() })
afterEach(() => cleanup())

function both() {
  const v1 = render(<V1PortfolioTab onSwapToken={() => undefined} />).container as HTMLElement
  const v2 = render(<V2PortfolioTab />).container as HTMLElement
  return { v1, v2 }
}

describe('Portfolio: truncated note', () => {
  it('truncated: both UIs show the same note, and nothing else differs', () => {
    h.data = state({ truncated: true })
    const { v1, v2 } = both()
    expect(within(v1).getByText(PORTFOLIO_TRUNCATED_NOTE)).toBeTruthy()
    expect(within(v2).getByText(PORTFOLIO_TRUNCATED_NOTE)).toBeTruthy()
    expect(compareContent(v1, v2).missingText).toEqual([])
    expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
  })

  it.each([[{ truncated: false }], [{}]])('not truncated (%j): no note in either UI', (over) => {
    h.data = state(over)
    const { v1, v2 } = both()
    expect(v1.querySelector('[data-testid="portfolio-truncated"]')).toBeNull()
    expect(v2.querySelector('[data-testid="portfolio-truncated"]')).toBeNull()
  })

  it('the note carries no U+2014 and is not a link', () => {
    expect(PORTFOLIO_TRUNCATED_NOTE.includes('—')).toBe(false)
    h.data = state({ truncated: true })
    const { v1, v2 } = both()
    expect(v1.querySelector('[data-testid="portfolio-truncated"] a')).toBeNull()
    expect(v2.querySelector('[data-testid="portfolio-truncated"] a')).toBeNull()
  })
})
