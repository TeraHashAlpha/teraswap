// @vitest-environment jsdom
/**
 * [ADR-025 / B8 C2] Chain switching, the Swap link and polling. v1's Portfolio is ONE chain at a time — whatever chain the header says —
 * and has no links but Swap (→ the Swap tab), no filter of its own. These tests run the v2 tab on the REAL `usePortfolio()` (fake wallet,
 * RPC and API): a chain switch must never show the previous chain's tokens; an import on one chain does not mark the same address
 * imported on another; and a tab that is not mounted (another v2 tab is showing) polls NOTHING — no API call, no RPC. (A browser-hidden tab:
 * RPC is proven 0 in `__tests__/rpc-budget`; v1's hook's two 60 s API intervals are not visibility-aware — see FEEDBACK.)
 */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERC20_BY_CHAIN, expectedTotalText, portfolioFetch } from './portfolio-harness'

const h = vi.hoisted(() => ({ chainId: 1, push: vi.fn(), importToken: vi.fn(), balanceCalls: 0 }))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: h.chainId } }),
  useBalance: () => { h.balanceCalls += 1; return { data: { value: 5n * 10n ** 17n, decimals: 18, symbol: 'ETH', formatted: '0.5' } } },
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
}))
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenImport', () => ({ useTokenImport: () => ({ importToken: h.importToken }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))

import { PortfolioTab } from './PortfolioTab'

const rowSymbols = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-testid="holding-row"] .font-semibold')).map((e) => e.textContent)
const total = (root: HTMLElement) => root.querySelector('[data-testid="portfolio-total"]')?.textContent

beforeEach(() => {
  h.chainId = 1
  h.push.mockReset()
  h.importToken.mockReset()
  vi.stubGlobal('fetch', portfolioFetch())
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chain switch (the header menu changes the chain; the hook follows it, as v1)', () => {
  it('Ethereum → Base → Arbitrum: each chain shows only its own tokens and total; nothing from the previous chain survives the switch', async () => {
    const { container, rerender } = render(<PortfolioTab />)
    await waitFor(() => expect(total(container)).toBe(expectedTotalText(1)), { timeout: 8_000 })
    expect(rowSymbols(container)).toContain('WBTC')

    // hold Base's discovery open: between the switch and its answer, Ethereum's ERC-20s must already be gone (v1 [E-3]).
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const inner = portfolioFetch()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input), 'http://localhost').searchParams.get('chainId') === '8453') await gate
      return inner(input)
    }))
    h.chainId = 8453
    rerender(<PortfolioTab />)
    expect(rowSymbols(container)).not.toContain('WBTC')
    expect(rowSymbols(container)).not.toContain('USDC') // mainnet's USDC row is gone before Base's lands
    release()
    await waitFor(() => expect(total(container)).toBe(expectedTotalText(8453)), { timeout: 8_000 })
    expect(rowSymbols(container)).not.toContain('WBTC')
    expect(rowSymbols(container)).toContain('USDC')

    h.chainId = 42161
    rerender(<PortfolioTab />)
    await waitFor(() => expect(total(container)).toBe(expectedTotalText(42161)), { timeout: 8_000 })
    expect(rowSymbols(container)).toContain('ARB')
    expect(rowSymbols(container)).not.toContain('ETHFI')
  })

  it('an unsupported chain shows v1\'s availability message, with no discovery request fired for it', async () => {
    h.chainId = 137
    const f = portfolioFetch()
    vi.stubGlobal('fetch', f)
    const { container } = render(<PortfolioTab />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-testid="portfolio-chain-unavailable"]')?.textContent).toMatch(/^Portfolio isn't available on .+ yet\.$/)
    expect(f).not.toHaveBeenCalled()
  })

  it('an import on one chain does not mark the same address imported on another (chain from the token, not the wallet)', async () => {
    const SPAM = ERC20_BY_CHAIN[1].find((t) => t.symbol === 'SPAM')!
    h.importToken.mockResolvedValue({ address: SPAM.address, symbol: 'SPAM' })
    const { container, rerender } = render(<PortfolioTab />)
    await waitFor(() => expect(total(container)).toBe(expectedTotalText(1)), { timeout: 8_000 })
    fireEvent.click(within(container).getByLabelText('Add SPAM to tokens'))
    await waitFor(() => expect(within(container).getByLabelText('Swap SPAM')).toBeTruthy())

    h.chainId = 8453 // the SAME address is held on Base too (fixture) — still un-imported there
    rerender(<PortfolioTab />)
    await waitFor(() => expect(total(container)).toBe(expectedTotalText(8453)), { timeout: 8_000 })
    expect(within(container).getByLabelText('Add SPAM to tokens')).toBeTruthy()
    expect(h.importToken).toHaveBeenCalledTimes(1)
  })
})

describe('links', () => {
  it('Swap → the Swap tab and nothing else; the tab holds no other link (v1 neither: no DCA / Orders / History links, no explorer links)', async () => {
    const { container } = render(<PortfolioTab />)
    await waitFor(() => expect(total(container)).toBe(expectedTotalText(1)), { timeout: 8_000 })
    expect(container.querySelectorAll('a[href]').length).toBe(0)
    fireEvent.click(within(container).getByLabelText('Swap USDC'))
    expect(h.push).toHaveBeenCalledTimes(1)
    expect(h.push).toHaveBeenCalledWith('/swap')
  })
})

describe('polling', () => {
  const apiCalls = (f: ReturnType<typeof portfolioFetch>) => f.mock.calls.length

  it('mounted: v1\'s 60 s discovery + price refresh; unmounted (another v2 tab is showing): no API call, no balance read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const f = portfolioFetch()
    vi.stubGlobal('fetch', f)
    const { unmount } = render(<PortfolioTab />)
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    const afterMount = apiCalls(f)
    expect(afterMount).toBeGreaterThan(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(apiCalls(f)).toBeGreaterThan(afterMount) // v1's cadence is live while the tab is on screen

    unmount()
    const calls = apiCalls(f)
    const reads = h.balanceCalls
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    expect(apiCalls(f)).toBe(calls)
    expect(h.balanceCalls).toBe(reads)
  })
})
