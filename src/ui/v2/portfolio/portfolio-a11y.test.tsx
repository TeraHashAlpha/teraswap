// @vitest-environment jsdom
/**
 * [ADR-025 / B8 C3] Keyboard, labels, targets and reduced motion for the Portfolio tab (round7 44 / m06 at 375). `PortfolioView` is fed fixtures
 * directly; wallet is a fake and nothing is signed or sent.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortfolioData, PortfolioToken } from '@/hooks/usePortfolio'
import type { ApprovalRecord } from '@/hooks/useActiveApprovals'
import { DEFAULT_TOKENS } from '@/lib/tokens'
import { fmtToken } from '@/lib/format'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 8453 } }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => 8453 }))

import { PortfolioView, type PortfolioViewProps } from './PortfolioTab'

const CSS = readFileSync(join(__dirname, 'portfolio.css'), 'utf8')
const eth = DEFAULT_TOKENS.find((t) => t.symbol === 'ETH')!
const usdc = DEFAULT_TOKENS.find((t) => t.symbol === 'USDC')!
const odd = { address: '0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2' as `0x${string}`, symbol: 'ETHFI', name: 'ether.fi governance token', decimals: 18, logoURI: '', category: 'Other' as const }
const row = (token: PortfolioToken['token'], balance: bigint, valueUsd: number | null): PortfolioToken => ({ token, balance, balanceFormatted: fmtToken(balance, token.decimals), priceUsd: 1, valueUsd })
const approval = (symbol: string): ApprovalRecord => ({
  id: symbol, tokenAddress: usdc.address as `0x${string}`, tokenSymbol: symbol, spenderAddress: '0x000000000000000000000000000000000000dEaD', spenderLabel: 'Velora',
  source: 'paraswap' as ApprovalRecord['source'], method: 'exact', timestamp: Date.now(), active: true, needsRevoke: true, chainId: 8453,
})
const portfolio = (over: Partial<PortfolioData> = {}): PortfolioData => ({
  tokens: [row(eth, 10n ** 16n, 27.77), row(usdc, 5_000_000n, 5), row(odd, 10n ** 18n, 329.43)], totalValueUsd: 362.2, isLoading: false, isError: false,
  lastUpdated: new Date(), refresh: vi.fn(), isChainSupported: true, ...over,
})
function view(over: Partial<PortfolioViewProps> = {}) {
  const props: PortfolioViewProps = {
    isConnected: true, address: '0xd44d00000000000000000000000000000000962d', chainName: 'Base', portfolio: portfolio(), importedKeys: new Set(), importKey: (t) => t.address,
    onAdd: vi.fn(), onSwap: vi.fn(), approvalRows: [approval('USDC'), approval('WBTC')], approvalCount: 2, onRevoked: vi.fn(), ...over,
  }
  return { props, ...render(<PortfolioView {...props} />) }
}
afterEach(cleanup)

describe('keyboard', () => {
  it('ArrowDown / ArrowUp / Home / End move focus through every row action (Swap, Add, Revoke), wrapping; Tab order stays native', () => {
    const { container } = view()
    const actions = Array.from(container.querySelectorAll<HTMLElement>('[data-pf-action]'))
    expect(actions.map((a) => a.textContent)).toEqual(['Swap', 'Swap', 'Add', 'Revoke', 'Revoke'])
    actions[0].focus()
    fireEvent.keyDown(actions[0], { key: 'ArrowDown' }); expect(document.activeElement).toBe(actions[1])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }); expect(document.activeElement).toBe(actions[2])
    fireEvent.keyDown(document.activeElement!, { key: 'End' }); expect(document.activeElement).toBe(actions[4])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }); expect(document.activeElement).toBe(actions[0]) // wraps
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }); expect(document.activeElement).toBe(actions[4]) // wraps back
    fireEvent.keyDown(document.activeElement!, { key: 'Home' }); expect(document.activeElement).toBe(actions[0])
    expect(container.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length).toBe(0) // no positive tabindex
  })

  it('arrows on a control that is not a row action (the refresh icon) are left alone', () => {
    const { container } = view()
    const refresh = within(container).getByLabelText('Refresh portfolio')
    refresh.focus()
    const notPrevented = fireEvent.keyDown(refresh, { key: 'ArrowDown' })
    expect(notPrevented).toBe(true)
    expect(document.activeElement).toBe(refresh)
  })

  it('Swap / Add / Revoke are real buttons: Enter / click activates them, with the token passed on', () => {
    const { container, props } = view()
    fireEvent.click(within(container).getByLabelText('Swap ETH'))
    fireEvent.click(within(container).getByLabelText('Add ETHFI to tokens'))
    expect(props.onSwap).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ETH' }))
    expect(props.onAdd).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'ETHFI' }))
  })
})

describe('names, landmarks, targets', () => {
  it('every control has an accessible name; groups are labelled lists; the error is an alert; the loading list is busy', () => {
    const { container } = view()
    for (const b of Array.from(container.querySelectorAll('button'))) expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).not.toBe('')
    expect(container.querySelector('section[aria-label="Portfolio"]')).toBeTruthy()
    const groups = Array.from(container.querySelectorAll('section[data-testid^="holdings-"]'))
    expect(groups.length).toBeGreaterThanOrEqual(2)
    for (const g of groups) { expect(g.getAttribute('aria-label')).toBeTruthy(); expect(g.querySelector('ul[role="list"] > li')).toBeTruthy() }
    expect(container.querySelector('section[aria-labelledby="ts-pf-approvals-h"] h3')?.textContent).toBe('Active Approvals')
    cleanup()
    const err = view({ portfolio: portfolio({ tokens: [], isError: true, totalValueUsd: null }) }).container
    expect(err.querySelector('[role="alert"]')?.textContent).toContain('Failed to load portfolio.')
    cleanup()
    const load = view({ portfolio: portfolio({ tokens: [], isLoading: true, totalValueUsd: null, lastUpdated: null }) }).container
    expect(load.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  it('every pressable is a ≥ 44 px target (Button text / icon variants carry min-h-[44px])', () => {
    const { container } = view()
    for (const b of Array.from(container.querySelectorAll('button'))) expect(b.className).toMatch(/min-h-\[44px\]/)
    for (const a of Array.from(container.querySelectorAll('a[href]'))) expect(a.getAttribute('rel')).toBe('noopener noreferrer') // inline Revoke.cash link: inline-text exception
  })
})

describe('mobile 375 and reduced motion (CSS contract; the rendered frames are in the FEEDBACK screenshots)', () => {
  it('the approvals panel is a second column only from 1024 px; below it stacks under the holdings (m06)', () => {
    expect(CSS).toMatch(/@media \(min-width: 1024px\) \{[^}]*\.ts-pf--aside \{[^}]*grid-template-columns/)
    expect(CSS).not.toMatch(/^\.ts-pf--aside \{[^}]*grid-template-columns/m)
    expect(CSS).toMatch(/\.ts-pf-amount \{ flex: none; \}/) // amounts never shrink; the name column truncates instead
  })
  it('the refresh spinner stops under prefers-reduced-motion, and spins only while loading', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.ts-pf-spin \{ animation: none; \}/)
    expect(view({ portfolio: portfolio({ isLoading: true }) }).container.querySelector('.ts-pf-spin')).toBeTruthy()
    cleanup()
    expect(view().container.querySelector('.ts-pf-spin')).toBeNull()
  })
  it('keyboard focus is visible on every row control (teal 2 px outline)', () => {
    expect(CSS).toMatch(/\.ts-pf-row button:focus-visible[^}]*outline: 2px solid var\(--teal\)/)
  })
})
