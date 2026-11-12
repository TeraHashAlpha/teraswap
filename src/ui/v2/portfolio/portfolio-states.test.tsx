// @vitest-environment jsdom
/**
 * [ADR-025 / B8 C1] Portfolio states matrix. `usePortfolio()` is faked (one fake feeds v1's PortfolioTab and the v2 tab), wallet and chain are
 * fakes; for every state the v2 tab shows the SAME visible text, in the same order, as v1, and its controls call what v1's call.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, visibleTextNodes } from '../__tests__/content-parity'
import { fmtToken } from '@/lib/format'
import type { PortfolioData, PortfolioToken } from '@/hooks/usePortfolio'
import { DEFAULT_TOKENS } from '@/lib/tokens'

const h = vi.hoisted(() => ({
  connected: true,
  chainId: 1,
  data: null as unknown as PortfolioData,
  refresh: vi.fn(),
  push: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.connected ? '0xd44d00000000000000000000000000000000962d' : undefined, isConnected: h.connected, chain: { id: h.chainId } }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
}))
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/usePortfolio', () => ({ usePortfolio: () => h.data }))
vi.mock('@/hooks/useTokenImport', () => ({ useTokenImport: () => ({ importToken: vi.fn() }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))

import V1PortfolioTab from '@/components/PortfolioTab'
import { PortfolioTab as V2PortfolioTab } from './PortfolioTab'

const eth = DEFAULT_TOKENS.find((t) => t.symbol === 'ETH')!
const usdc = DEFAULT_TOKENS.find((t) => t.symbol === 'USDC')!
const unknown = { address: '0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2' as `0x${string}`, symbol: 'ETHFI', name: 'ether.fi governance token', decimals: 18, logoURI: '', category: 'Other' as const }
const entry = (token: PortfolioToken['token'], balance: bigint, valueUsd: number | null): PortfolioToken => ({
  token, balance, balanceFormatted: fmtToken(balance, token.decimals), priceUsd: valueUsd === null ? null : 1, valueUsd,
})
const ROWS = [entry(eth, 11_160_000_000_000_000n, 27.77), entry(unknown, 460n * 10n ** 18n, 329.43), entry(usdc, 5_000_000n, null)]

function state(over: Partial<PortfolioData> = {}): PortfolioData {
  return { tokens: ROWS, totalValueUsd: 357.2, isLoading: false, isError: false, lastUpdated: new Date(), refresh: h.refresh, isChainSupported: true, ...over }
}

beforeEach(() => {
  h.connected = true
  h.chainId = 8453
  h.refresh.mockReset()
  h.push.mockReset()
  h.data = state()
})
afterEach(() => cleanup())

function both() {
  const v1 = render(<V1PortfolioTab onSwapToken={() => h.push('/swap')} />).container
  const v2 = render(<V2PortfolioTab />).container
  return { v1: v1 as HTMLElement, v2: v2 as HTMLElement }
}
function expectParity(label: string) {
  const { v1, v2 } = both()
  const r = compareContent(v1, v2)
  console.log(`[states] ${label}: v1 nodes ${r.v1Nodes}, missing ${r.missingText.length}`)
  expect(r.missingText).toEqual([])
  expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
  return { v1, v2 }
}

describe('Portfolio states: v2 text equals v1\'s', () => {
  it('connected, priced + unpriced rows, total, "Last updated just now"', () => {
    const { v2 } = expectParity('populated')
    expect(v2.querySelector('[data-testid="portfolio-total"]')?.textContent).toBe('$357.20')
    expect(within(v2).getByText('Last updated just now')).toBeTruthy()
    expect(within(v2).getByText('Discovered in Wallet')).toBeTruthy()
  })
  it('disconnected: "Connect your wallet to view your portfolio"', () => {
    h.connected = false
    const { v2 } = expectParity('disconnected')
    expect(v2.querySelector('[data-testid="portfolio-disconnected"]')).toBeTruthy()
    expect(within(v2).queryByText('Total value')).toBeNull()
  })
  it.each([[10], [137], [56]])('chain %i without discovery: "Portfolio isn\'t available on {chain} yet."', (chainId) => {
    h.chainId = chainId
    h.data = state({ isChainSupported: false, tokens: [], totalValueUsd: null })
    const { v2 } = expectParity(`unavailable ${chainId}`)
    expect(v2.querySelector('[data-testid="portfolio-chain-unavailable"]')?.textContent).toMatch(/^Portfolio isn't available on .+ yet\.$/)
    expect(within(v2).queryByText('Total value')).toBeNull() // none of the loading / error / empty states apply
  })
  it('initial load: "Loading prices…", four skeleton rows, total ". "', () => {
    h.data = state({ tokens: [], totalValueUsd: null, isLoading: true, lastUpdated: null })
    const { v2 } = expectParity('loading')
    expect(v2.querySelector('[data-testid="portfolio-loading"]')?.getAttribute('aria-busy')).toBe('true')
    expect(v2.querySelectorAll('[data-testid="portfolio-loading"] .ts-v2-skeleton').length).toBeGreaterThanOrEqual(4)
    expect(within(v2).getByText('Loading prices…')).toBeTruthy()
    expect(screen.queryAllByLabelText('Refresh portfolio').every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })
  it('refreshing with rows on screen: rows stay, no skeleton, the refresh control is disabled', () => {
    h.data = state({ isLoading: true })
    const { v2 } = expectParity('refreshing')
    expect(v2.querySelector('[data-testid="portfolio-loading"]')).toBeNull()
    expect(within(v2).getAllByTestId('holding-row').length).toBe(3)
    expect((within(v2).getByLabelText('Refresh portfolio') as HTMLButtonElement).disabled).toBe(true)
  })
  it('error without rows: "Failed to load portfolio." + "Try again" calls refresh', () => {
    h.data = state({ tokens: [], totalValueUsd: null, isError: true, lastUpdated: null })
    const { v1, v2 } = expectParity('error')
    expect(within(v2).getByRole('alert').textContent).toContain('Failed to load portfolio.')
    fireEvent.click(within(v1).getByText('Try again'))
    fireEvent.click(within(v2).getByText('Try again'))
    expect(h.refresh).toHaveBeenCalledTimes(2)
    expect(within(v2).queryByTestId('portfolio-empty')).toBeNull() // error is not "empty"
  })
  it('error with rows keeps the rows and the error', () => {
    h.data = state({ isError: true })
    const { v2 } = expectParity('error + rows')
    expect(within(v2).getAllByTestId('holding-row').length).toBe(3)
    expect(within(v2).getByText('Failed to load portfolio.')).toBeTruthy()
  })
  it.each([[1, 'Ethereum'], [8453, 'Base'], [42161, 'Arbitrum']])('empty wallet on chain %i: "No tokens found in this wallet on {chain}."', (chainId, name) => {
    h.chainId = chainId
    h.data = state({ tokens: [], totalValueUsd: null })
    const { v2 } = expectParity(`empty ${chainId}`)
    expect(v2.querySelector('[data-testid="portfolio-empty"]')?.textContent).toContain(name)
  })
  it('unpriced total shows v1\'s ". "', () => {
    h.data = state({ tokens: [ROWS[2]], totalValueUsd: null })
    const { v2 } = expectParity('unpriced total')
    expect(v2.querySelector('[data-testid="portfolio-total"]')?.textContent).toBe('n/a')
  })
  it.each([[7_000, 'Last updated 7s ago'], [95_000, 'Last updated 1m ago'], [3 * 3_600_000, 'Last updated 3h ago']])('"Last updated" clock, %i ms old', (ms, text) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      vi.setSystemTime(new Date('2026-11-03T12:00:00Z'))
      h.data = state({ lastUpdated: new Date(Date.now() - ms) })
      const { v2 } = expectParity(`clock ${ms}`)
      expect(within(v2).getByText(text)).toBeTruthy()
      act(() => { vi.advanceTimersByTime(3_600_000) }) // the once-a-second tick keeps it live, as v1's
      expect(v2.textContent).not.toContain(text)
    } finally {
      vi.useRealTimers()
    }
  })
  it('refresh control calls the hook\'s refresh, as v1\'s', () => {
    const { v1, v2 } = both()
    fireEvent.click(within(v1).getByLabelText('Refresh portfolio'))
    fireEvent.click(within(v2).getByLabelText('Refresh portfolio'))
    expect(h.refresh).toHaveBeenCalledTimes(2)
  })
})
