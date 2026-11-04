// @vitest-environment jsdom
/**
 * [ADR-025 / B8 C1 · fix/revoke-chain C2] Active Approvals on the Portfolio tab (owner-approved 2026-11-03: round7 frames 44 / m06 place
 * v1's panel beside the holdings). v1's `ActiveApprovals` and the v2 panel run on ONE store (`useActiveApprovals`) and ONE hook
 * (`useRevokeApproval`) over one fake wagmi write: the text is v1's, the Revoke call is v1's (`approve(spender, 0)` on the token) and is
 * only ever made on a press — and, since fix/revoke-chain, only on the RECORD's chain. Nothing is signed or sent —
 * `useWriteContract` / `useWaitForTransactionReceipt` / `useSwitchChain` are fakes.
 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { erc20Abi } from 'viem'
import { compareContent, visibleTextNodes } from '../__tests__/content-parity'
import { useActiveApprovals, type ApprovalRecord } from '@/hooks/useActiveApprovals'
import { REVOKE_COPY } from '@/hooks/useRevokeApproval'
import { EXPLORER_HOST, WALLET } from './portfolio-harness'

const h = vi.hoisted(() => ({
  chainId: 8453,
  write: vi.fn(),
  reset: vi.fn(),
  switchChain: vi.fn(),
  switching: false,
  hash: undefined as string | undefined,
  err: null as Error | null,
  /** the receipt query: `confirmed` = a receipt was fetched (query success), `receipt` = what it says, `receiptErr` = the watcher threw */
  confirmed: false,
  receipt: undefined as { status: 'success' | 'reverted' } | undefined,
  receiptErr: null as Error | null,
  waiting: false,
  supported: true,
  /** every `chainId` the receipt watcher was asked for (the record's chain, never the wallet's) */
  receiptChainIds: [] as Array<number | undefined>,
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: h.chainId } }),
  useWriteContract: () => ({ writeContract: h.write, data: h.hash, error: h.err, reset: h.reset }),
  useWaitForTransactionReceipt: (p: { hash?: string; chainId?: number }) => {
    if (p.hash) h.receiptChainIds.push(p.chainId)
    return { data: h.receipt, isSuccess: h.confirmed, isLoading: h.waiting, error: h.receiptErr }
  },
  useSwitchChain: () => ({ switchChain: h.switchChain, isPending: h.switching }),
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
  source: 'paraswap' as ApprovalRecord['source'], method: 'exact', timestamp: Date.now() - 17 * DAY, active: true, needsRevoke: true, chainId: 8453, ...over,
})
const A = rec({ tokenAddress: USDC, tokenSymbol: 'USDC' }) // Base
const B = rec({ tokenAddress: ETHFI, tokenSymbol: 'ETHFI', spenderAddress: PERMIT2, spenderLabel: 'Permit2', method: 'permit2', timestamp: Date.now() - 28 * DAY, chainId: 1 }) // Ethereum
const INFINITE = rec({ tokenAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', tokenSymbol: 'WBTC', method: 'infinite', timestamp: Date.now() - 90_000 }) // Base
const UNKNOWN = rec({ tokenAddress: '0x3333333333333333333333333333333333333333', tokenSymbol: 'OLD', chainId: undefined }) // schema-1 record: chain unknown
const HIDDEN = [rec({ tokenAddress: '0x1111111111111111111111111111111111111111', tokenSymbol: 'GONE', active: false }), rec({ tokenAddress: '0x2222222222222222222222222222222222222222', tokenSymbol: 'SMALL', needsRevoke: false })]
const HASH = '0xabc0000000000000000000000000000000000000000000000000000000000def'

beforeEach(() => {
  h.chainId = 8453
  h.write.mockReset(); h.reset.mockReset(); h.switchChain.mockReset()
  h.switching = false
  h.hash = undefined; h.err = null; h.confirmed = false; h.receipt = undefined; h.receiptErr = null; h.waiting = false; h.supported = true
  h.receiptChainIds = []
  useActiveApprovals.setState({ approvals: [A, B, INFINITE, ...HIDDEN] })
})
afterEach(() => cleanup())

const v2Panel = () => render(<PortfolioTab />).container.querySelector('[data-testid="approvals-panel"]') as HTMLElement
const rowOf = (root: HTMLElement, symbol: string) => within(root).getByText(symbol).closest('[data-testid="approval-row"]') as HTMLElement
const v1RowOf = (root: HTMLElement, symbol: string) => within(root).getByText(symbol).closest('.rounded-lg') as HTMLElement

describe('Active Approvals — parity with v1', () => {
  it('same text and the same Revoke.cash link; only actionable rows (active + needsRevoke); the count is v1\'s; each row names its chain', () => {
    const v1 = render(<ActiveApprovals />).container
    const v2 = v2Panel()
    const r = compareContent(v1, v2)
    console.log(`[approvals] v1 nodes ${r.v1Nodes}, hrefs ${r.v1Hrefs}, missing text ${r.missingText.length}, missing hrefs ${r.missingHrefs.length}`)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
    expect(within(v2).getAllByTestId('approval-row').length).toBe(3)
    expect(within(v2).queryByText('GONE')).toBeNull()
    expect(within(v2).queryByText('SMALL')).toBeNull()
    expect(within(v2).getByTestId('approvals-count').textContent).toBe('3')
    // the record's chain name, from the registry (never the wallet's chain: B is an Ethereum record while the wallet is on Base)
    expect(within(rowOf(v2, 'USDC')).getByTestId('approval-chain').textContent).toBe('Base')
    expect(within(rowOf(v2, 'ETHFI')).getByTestId('approval-chain').textContent).toBe('Ethereum')
    expect(within(rowOf(v2, 'WBTC')).getByTestId('approval-chain').textContent).toBe('Base')
    const link = within(v2).getByText('Revoke.cash →').closest('a')!
    const url = new URL(link.getAttribute('href')!)
    expect(url.hostname).toBe('revoke.cash')
    expect(url.pathname).toBe(`/address/0xd44d00000000000000000000000000000000962d`)
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    void WALLET
  })

  it('a chain-unknown record: v1 and v2 print the same neutral line (the one addition to v1\'s copy), no button, no chain name', () => {
    useActiveApprovals.setState({ approvals: [UNKNOWN] })
    const v1 = render(<ActiveApprovals />).container
    const v2 = v2Panel()
    expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
    expect(visibleTextNodes(v1)).toContain(REVOKE_COPY.unknownChain.toLowerCase())
    expect(v1.querySelector('button')).toBeNull()
    expect(within(rowOf(v2, 'OLD')).queryByRole('button')).toBeNull()
    expect(within(rowOf(v2, 'OLD')).queryByTestId('approval-chain')).toBeNull()
    expect(within(rowOf(v2, 'OLD')).getByTestId('approval-chain-unknown').textContent).toBe('Network unknown — reconnect on the chain where you approved')
    expect(within(v2).getByTestId('approvals-count').textContent).toBe('1') // still an open allowance: counted, just not revocable blind
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

describe('Active Approvals — Revoke is bound to the record\'s chain (fake write, nothing sent)', () => {
  it('on the record\'s chain, a press calls approve(spender, 0) on the token with chainId = the record\'s, exactly as v1 — and nothing before the press', () => {
    const v1 = render(<ActiveApprovals />).container
    const v2 = render(<PortfolioTab />).container
    expect(h.write).not.toHaveBeenCalled()
    fireEvent.click(within(v1RowOf(v1, 'USDC')).getByText('Revoke'))
    fireEvent.click(within(rowOf(v2, 'USDC')).getByTestId('approval-revoke'))
    expect(h.write).toHaveBeenCalledTimes(2)
    const [v1Call, v2Call] = h.write.mock.calls
    expect(v2Call).toEqual(v1Call)
    expect(v2Call[0]).toEqual({ chainId: 8453, address: A.tokenAddress, abi: erc20Abi, functionName: 'approve', args: [A.spenderAddress, 0n] })
  })

  it('Base record + wallet on Ethereum → v1\'s "Switch to Base" (v1 and v2), NO tx until switched; after the switch → tx chainId = 8453, token/spender = the record\'s', () => {
    h.chainId = 1
    const v1 = render(<ActiveApprovals />)
    const v2 = render(<PortfolioTab />)
    const v1Row = () => v1RowOf(v1.container, 'USDC')
    const v2Row = () => rowOf(v2.container, 'USDC')
    expect(within(v1Row()).queryByText('Revoke')).toBeNull()
    expect(within(v2Row()).queryByTestId('approval-revoke')).toBeNull()
    fireEvent.click(within(v1Row()).getByText('Switch to Base'))
    fireEvent.click(within(v2Row()).getByTestId('approval-switch'))
    expect(within(v2Row()).getByTestId('approval-switch').textContent).toBe('Switch to Base')
    expect(h.switchChain).toHaveBeenCalledTimes(2)
    expect(h.switchChain).toHaveBeenNthCalledWith(1, { chainId: 8453 })
    expect(h.switchChain).toHaveBeenNthCalledWith(2, { chainId: 8453 })
    expect(h.write).not.toHaveBeenCalled()
    // the row for the ETHEREUM record is revocable right now (wallet on 1), the Base ones are not
    expect(within(rowOf(v2.container, 'ETHFI')).getByTestId('approval-revoke').textContent).toBe('Revoke')
    expect(within(rowOf(v2.container, 'WBTC')).getByTestId('approval-switch').textContent).toBe('Switch to Base')

    // the wallet confirms the switch
    h.chainId = 8453
    v1.rerender(<ActiveApprovals />)
    v2.rerender(<PortfolioTab />)
    fireEvent.click(within(v1Row()).getByText('Revoke'))
    fireEvent.click(within(v2Row()).getByTestId('approval-revoke'))
    expect(h.write).toHaveBeenCalledTimes(2)
    for (const [call] of h.write.mock.calls) {
      expect(call.chainId).toBe(8453)
      expect(call.address).toBe(A.tokenAddress)
      expect(call.args).toEqual([A.spenderAddress, 0n])
      expect(call.functionName).toBe('approve')
    }
    // and now the Ethereum record is the one that needs a switch
    expect(within(rowOf(v2.container, 'ETHFI')).getByTestId('approval-switch').textContent).toBe('Switch to Ethereum')
  })

  it('the wallet lands on a third chain after "Switch to Base" → still "Switch to Base", no tx (abort)', () => {
    h.chainId = 1
    const v2 = render(<PortfolioTab />)
    fireEvent.click(within(rowOf(v2.container, 'USDC')).getByTestId('approval-switch'))
    h.chainId = 42161
    v2.rerender(<PortfolioTab />)
    expect(within(rowOf(v2.container, 'USDC')).getByTestId('approval-switch').textContent).toBe('Switch to Base')
    expect(within(rowOf(v2.container, 'ETHFI')).getByTestId('approval-switch').textContent).toBe('Switch to Ethereum')
    expect(h.write).not.toHaveBeenCalled()
  })

  it('mid-flight chain change: the press was pinned to 8453 and the wallet moved to Ethereum before signing → wagmi/viem refuse (ChainMismatch), no hash, record stays open, the row asks to switch back', () => {
    const v2 = render(<PortfolioTab />)
    fireEvent.click(within(rowOf(v2.container, 'USDC')).getByTestId('approval-revoke'))
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write.mock.calls[0][0].chainId).toBe(8453) // viem asserts the wallet's live chain against this at send time
    // viem: `ChainMismatchError` — nothing was sent
    h.err = new Error('The current chain of the wallet (id: 1) does not match the target chain for the transaction (id: 8453 – Base).')
    h.chainId = 1
    act(() => { v2.rerender(<PortfolioTab />) })
    const row = rowOf(v2.container, 'USDC')
    expect(row.textContent).not.toContain('✓ Revoked')
    expect(within(row).queryByTestId('approval-retry')).toBeNull() // Retry on the wrong chain is not offered
    expect(within(row).getByTestId('approval-switch').textContent).toBe('Switch to Base')
    expect(useActiveApprovals.getState().approvals.find((x) => x.id === A.id)?.active).toBe(true)
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(within(v2.container).getByTestId('approvals-count').textContent).toBe('3')
  })

  it('a chain-unknown record cannot be revoked from the UI: no Revoke, no Switch, no write', () => {
    useActiveApprovals.setState({ approvals: [UNKNOWN, A] })
    const v1 = render(<ActiveApprovals />).container
    const v2 = render(<PortfolioTab />).container
    expect(within(v1RowOf(v1, 'OLD')).queryByRole('button')).toBeNull()
    expect(within(rowOf(v2, 'OLD')).queryByRole('button')).toBeNull()
    expect(within(rowOf(v2, 'OLD')).getByTestId('approval-chain-unknown')).toBeTruthy()
    // the sibling Base record still works
    fireEvent.click(within(rowOf(v2, 'USDC')).getByTestId('approval-revoke'))
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write.mock.calls[0][0].chainId).toBe(8453)
  })

  it('Revoking… → Confirming… → ✓ Revoked ↗ (receipt awaited on, and linked to, the RECORD\'s chain) and the row stays readable', () => {
    const { container, rerender } = render(<PortfolioTab />)
    const first = () => rowOf(container, 'USDC')
    fireEvent.click(within(first()).getByTestId('approval-revoke'))
    expect(within(first()).getByText('Revoking…')).toBeTruthy()
    expect((within(first()).getByText('Revoking…') as HTMLButtonElement).disabled).toBe(true)

    h.hash = HASH; h.waiting = true
    rerender(<PortfolioTab />)
    expect(within(first()).getByText('Confirming…')).toBeTruthy()
    // the fake hash is shared by every row, so every row's watcher reports: each asks for ITS record's chain (Base, Base, Ethereum) —
    // a wallet-following watcher would have asked for 8453 only
    expect(new Set(h.receiptChainIds)).toEqual(new Set([8453, 1]))

    h.waiting = false; h.confirmed = true; h.receipt = { status: 'success' }
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

  it('a chain change while the receipt is pending does not re-route it: the watcher stays on the record\'s chain, the row keeps Confirming…', () => {
    useActiveApprovals.setState({ approvals: [A, INFINITE, ...HIDDEN] }) // Base records only, so a wallet-following watcher would show up as 1
    const { container, rerender } = render(<PortfolioTab />)
    fireEvent.click(within(rowOf(container, 'USDC')).getByTestId('approval-revoke'))
    h.hash = HASH; h.waiting = true
    rerender(<PortfolioTab />)
    h.chainId = 1 // wallet moves to Ethereum while the Base receipt is pending
    rerender(<PortfolioTab />)
    expect(within(rowOf(container, 'USDC')).getByText('Confirming…')).toBeTruthy()
    expect(within(rowOf(container, 'USDC')).queryByTestId('approval-switch')).toBeNull() // the tx is already on Base: no switch prompt mid-flight
    expect(new Set(h.receiptChainIds)).toEqual(new Set([8453]))
    expect(h.write).toHaveBeenCalledTimes(1)
  })

  it.each([[1], [8453], [42161]])('the revoke tx link follows the RECORD\'s chain %i (new URL().hostname), not the wallet\'s', (chainId) => {
    h.chainId = chainId === 8453 ? 1 : 8453 // the wallet is always somewhere else
    h.hash = '0xfeed000000000000000000000000000000000000000000000000000000000001'
    h.confirmed = true; h.receipt = { status: 'success' }
    useActiveApprovals.setState({ approvals: [rec({ chainId })] })
    const { container } = render(<PortfolioTab />)
    const a = container.querySelector('a[aria-label="View revoke transaction"]') as HTMLAnchorElement
    expect(new URL(a.href).hostname).toBe(EXPLORER_HOST[chainId])
    expect(new URL(a.href).pathname).toBe(`/tx/${h.hash}`)
    const v1 = render(<ActiveApprovals />).container
    const v1Link = v1.querySelector('a[target="_blank"]:not([href*="revoke.cash"])') as HTMLAnchorElement
    expect(new URL(v1Link.href).hostname).toBe(EXPLORER_HOST[chainId])
  })

  it('a rejected write shows Retry (v1), and Retry calls the write again — on the record\'s chain', () => {
    h.err = new Error('User rejected')
    const v2 = render(<PortfolioTab />).container
    const retry = within(rowOf(v2, 'USDC')).getByText('Retry')
    fireEvent.click(retry)
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write.mock.calls[0][0].chainId).toBe(8453)
    expect(h.reset).toHaveBeenCalled()
  })
})

describe('Active Approvals — "revoked" means revoked (fix/revoke-chain C3; fake receipt, nothing sent)', () => {
  const press = () => {
    const view = render(<PortfolioTab />)
    fireEvent.click(within(rowOf(view.container, 'USDC')).getByTestId('approval-revoke'))
    h.hash = HASH; h.waiting = true
    view.rerender(<PortfolioTab />)
    expect(within(rowOf(view.container, 'USDC')).getByText('Confirming…')).toBeTruthy()
    return view
  }
  const stillOpen = (container: HTMLElement) => {
    const row = rowOf(container, 'USDC')
    expect(row.textContent).not.toContain('✓ Revoked')
    expect(within(row).queryByLabelText('View revoke transaction')).toBeNull()
    expect(within(row).getByTestId('approval-retry').textContent).toBe('Retry') // v1's error copy
    expect(useActiveApprovals.getState().approvals.find((x) => x.id === A.id)?.active).toBe(true)
    expect(within(container).getByTestId('approvals-count').textContent).toBe('3')
  }

  it('a receipt with status success on the record\'s chain → ✓ Revoked, and only then is the store marked', () => {
    const view = press()
    expect(useActiveApprovals.getState().approvals.find((x) => x.id === A.id)?.active).toBe(true) // not before the receipt
    h.waiting = false; h.confirmed = true; h.receipt = { status: 'success' }
    act(() => { view.rerender(<PortfolioTab />) })
    expect(rowOf(view.container, 'USDC').textContent).toContain('✓ Revoked')
    expect(useActiveApprovals.getState().approvals.find((x) => x.id === A.id)?.active).toBe(false)
    expect(new Set(h.receiptChainIds)).toEqual(new Set([8453, 1])) // each row's watcher on its record's chain
  })

  it('a receipt was fetched (query success) but the tx REVERTED → not revoked: Retry, record stays open (v1 would have printed ✓ Revoked)', () => {
    const view = press()
    h.waiting = false; h.confirmed = true; h.receipt = { status: 'reverted' }
    act(() => { view.rerender(<PortfolioTab />) })
    stillOpen(view.container)
  })

  it('wagmi\'s watcher throws on a reverted receipt (its real behaviour: error, no data) → Retry, record stays open', () => {
    const view = press()
    h.waiting = false; h.confirmed = false; h.receipt = undefined; h.receiptErr = new Error('execution reverted')
    act(() => { view.rerender(<PortfolioTab />) })
    stillOpen(view.container)
  })

  it('query success with NO receipt is not a revoke (the old `isSuccess` condition is never enough)', () => {
    const view = press()
    h.waiting = false; h.confirmed = true; h.receipt = undefined
    act(() => { view.rerender(<PortfolioTab />) })
    const row = rowOf(view.container, 'USDC')
    expect(row.textContent).not.toContain('✓ Revoked')
    expect(useActiveApprovals.getState().approvals.find((x) => x.id === A.id)?.active).toBe(true)
  })

  it('the wallet rejects the write → Retry, record stays open, no receipt was ever watched', () => {
    const view = render(<PortfolioTab />)
    fireEvent.click(within(rowOf(view.container, 'USDC')).getByTestId('approval-revoke'))
    h.err = new Error('User rejected the request.')
    act(() => { view.rerender(<PortfolioTab />) })
    stillOpen(view.container)
    expect(h.receiptChainIds).toEqual([])
  })

  it('v1\'s row obeys the same rule: a reverted receipt leaves v1 on Retry too', () => {
    useActiveApprovals.setState({ approvals: [A] })
    const v1 = render(<ActiveApprovals />)
    fireEvent.click(within(v1.container).getByText('Revoke'))
    h.hash = HASH; h.confirmed = true; h.receipt = { status: 'reverted' }
    act(() => { v1.rerender(<ActiveApprovals />) })
    expect(v1.container.textContent).not.toContain('✓ Revoked')
    expect(within(v1.container).getByText('Retry')).toBeTruthy()
    expect(useActiveApprovals.getState().approvals[0].active).toBe(true)
  })
})
