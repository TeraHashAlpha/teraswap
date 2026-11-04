// @vitest-environment jsdom
/**
 * [ADR-025 / B8 C1] Active Approvals on the Portfolio tab (owner-approved 2026-11-03: round7 frames 44 / m06 place v1's panel beside the
 * holdings). v1's `ActiveApprovals` and the v2 panel run on ONE store (`useActiveApprovals`, v1's, unchanged) and one fake wagmi write: the
 * text is v1's, the Revoke call is v1's (`approve(spender, 0)` on the token) and is only ever made on a press. Nothing is signed or sent —
 * `useWriteContract` / `useWaitForTransactionReceipt` are fakes.
 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { erc20Abi } from 'viem'
import { compareContent, visibleTextNodes } from '../__tests__/content-parity'
import { useActiveApprovals, type ApprovalRecord } from '@/hooks/useActiveApprovals'
import { EXPLORER_HOST, WALLET } from './portfolio-harness'

const h = vi.hoisted(() => ({
  chainId: 8453,
  write: vi.fn(),
  reset: vi.fn(),
  hash: undefined as string | undefined,
  err: null as Error | null,
  confirmed: false,
  waiting: false,
  supported: true,
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: h.chainId } }),
  useWriteContract: () => ({ writeContract: h.write, data: h.hash, error: h.err, reset: h.reset }),
  useWaitForTransactionReceipt: () => ({ isSuccess: h.confirmed, isLoading: h.waiting }),
}))
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: () => ({ tokens: [], totalValueUsd: null, isLoading: false, isError: false, lastUpdated: new Date(), refresh: vi.fn(), isChainSupported: h.supported }),
}))
vi.mock('@/hooks/useTokenImport', () => ({ useTokenImport: () => ({ importToken: vi.fn() }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import ActiveApprovals from '@/components/ActiveApprovals'
import { PortfolioTab } from './PortfolioTab'

const DAY = 86_400_000
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const ETHFI = '0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2' as const
const VELORA = '0x000000000000000000000000000000000000dEaD' as const
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const
const rec = (over: Partial<ApprovalRecord>): ApprovalRecord => ({
  id: `${over.tokenAddress}:${over.spenderAddress}`.toLowerCase(), tokenAddress: USDC, tokenSymbol: 'USDC', spenderAddress: VELORA, spenderLabel: 'Velora',
  source: 'paraswap' as ApprovalRecord['source'], method: 'exact', timestamp: Date.now() - 17 * DAY, active: true, needsRevoke: true, ...over,
})
const A = rec({ tokenAddress: USDC, tokenSymbol: 'USDC' })
const B = rec({ tokenAddress: ETHFI, tokenSymbol: 'ETHFI', spenderAddress: PERMIT2, spenderLabel: 'Permit2', method: 'permit2', timestamp: Date.now() - 28 * DAY })
const INFINITE = rec({ tokenAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', tokenSymbol: 'WBTC', method: 'infinite', timestamp: Date.now() - 90_000 })
const HIDDEN = [rec({ tokenAddress: '0x1111111111111111111111111111111111111111', tokenSymbol: 'GONE', active: false }), rec({ tokenAddress: '0x2222222222222222222222222222222222222222', tokenSymbol: 'SMALL', needsRevoke: false })]

beforeEach(() => {
  h.chainId = 8453
  h.write.mockReset(); h.reset.mockReset()
  h.hash = undefined; h.err = null; h.confirmed = false; h.waiting = false; h.supported = true
  useActiveApprovals.setState({ approvals: [A, B, INFINITE, ...HIDDEN] })
})
afterEach(() => cleanup())

describe('Active Approvals — parity with v1', () => {
  it('same text and the same Revoke.cash link; only actionable rows (active + needsRevoke); the count is v1\'s', () => {
    const v1 = render(<ActiveApprovals />).container
    const v2 = render(<PortfolioTab />).container.querySelector('[data-testid="approvals-panel"]') as HTMLElement
    const r = compareContent(v1, v2)
    console.log(`[approvals] v1 nodes ${r.v1Nodes}, hrefs ${r.v1Hrefs}, missing text ${r.missingText.length}, missing hrefs ${r.missingHrefs.length}`)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
    expect(within(v2).getAllByTestId('approval-row').length).toBe(3)
    expect(within(v2).queryByText('GONE')).toBeNull()
    expect(within(v2).queryByText('SMALL')).toBeNull()
    expect(within(v2).getByTestId('approvals-count').textContent).toBe('3')
    const link = within(v2).getByText('Revoke.cash →').closest('a')!
    const url = new URL(link.getAttribute('href')!)
    expect(url.hostname).toBe('revoke.cash')
    expect(url.pathname).toBe(`/address/0xd44d00000000000000000000000000000000962d`)
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    void WALLET
  })

  it('no actionable approval → no panel (v1 renders null)', () => {
    useActiveApprovals.setState({ approvals: HIDDEN })
    const v1 = render(<ActiveApprovals />).container
    const v2 = render(<PortfolioTab />).container
    expect(v1.innerHTML).toBe('')
    expect(v2.querySelector('[data-testid="approvals-panel"]')).toBeNull()
  })

  it('the panel also shows on a chain the holdings do not support (approvals do not depend on discovery)', () => {
    h.supported = false
    const v2 = render(<PortfolioTab />).container
    expect(v2.querySelector('[data-testid="portfolio-chain-unavailable"]')).toBeTruthy()
    expect(v2.querySelector('[data-testid="approvals-panel"]')).toBeTruthy()
  })
})

describe('Active Approvals — Revoke (fake write, nothing sent)', () => {
  it('a press calls approve(spender, 0) on the token, exactly as v1 — and nothing before the press', () => {
    const v1 = render(<ActiveApprovals />).container
    const v2 = render(<PortfolioTab />).container
    expect(h.write).not.toHaveBeenCalled()
    fireEvent.click(within(v1).getAllByText('Revoke')[0])
    fireEvent.click(within(v2).getAllByTestId('approval-revoke')[0])
    expect(h.write).toHaveBeenCalledTimes(2)
    const [v1Call, v2Call] = h.write.mock.calls
    expect(v2Call).toEqual(v1Call)
    expect(v2Call[0]).toEqual({ address: A.tokenAddress, abi: erc20Abi, functionName: 'approve', args: [A.spenderAddress, 0n] })
  })

  it('Revoking… → Confirming… → ✓ Revoked ↗ (revoke tx on the active chain\'s explorer) and the row stays readable', () => {
    const { container, rerender } = render(<PortfolioTab />)
    const first = () => within(container).getAllByTestId('approval-row')[0]
    fireEvent.click(within(first()).getByTestId('approval-revoke'))
    expect(within(first()).getByText('Revoking…')).toBeTruthy()
    expect((within(first()).getByText('Revoking…') as HTMLButtonElement).disabled).toBe(true)

    h.hash = '0xabc0000000000000000000000000000000000000000000000000000000000def'; h.waiting = true
    rerender(<PortfolioTab />)
    expect(within(first()).getByText('Confirming…')).toBeTruthy()

    h.waiting = false; h.confirmed = true
    act(() => { rerender(<PortfolioTab />) })
    const row = first()
    expect(row.textContent).toContain('✓ Revoked')
    const a = within(row).getByLabelText('View revoke transaction') as HTMLAnchorElement
    const url = new URL(a.href)
    expect(url.hostname).toBe(EXPLORER_HOST[8453])
    expect(url.pathname).toBe(`/tx/${h.hash}`)
    expect(a.rel).toBe('noopener noreferrer')
    // the store marked it revoked (v1's markRevoked), yet the row is still listed with its receipt link
    expect(useActiveApprovals.getState().approvals.find((x) => x.id === A.id)?.active).toBe(false)
    expect(within(container).getAllByTestId('approval-row').length).toBe(3)
    expect(within(container).getByTestId('approvals-count').textContent).toBe('2') // v1's count: actionable only
  })

  it.each([[1], [8453], [42161]])('the revoke tx link follows the active chain %i', (chainId) => {
    h.chainId = chainId
    h.hash = '0xfeed000000000000000000000000000000000000000000000000000000000001'
    h.confirmed = true
    const { container } = render(<PortfolioTab />)
    const a = container.querySelector('a[aria-label="View revoke transaction"]') as HTMLAnchorElement
    expect(new URL(a.href).hostname).toBe(EXPLORER_HOST[chainId])
    expect(new URL(a.href).pathname).toBe(`/tx/${h.hash}`)
  })

  it('a rejected write shows Retry (v1), and Retry calls the write again', () => {
    h.err = new Error('User rejected')
    const v2 = render(<PortfolioTab />).container
    const retry = within(within(v2).getAllByTestId('approval-row')[0]).getByText('Retry')
    fireEvent.click(retry)
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.reset).toHaveBeenCalled()
  })
})
