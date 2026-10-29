// @vitest-environment jsdom
/**
 * [ADR-025 / B5] Round 7 28a / 28b / 28c (pending · success · failure) and 29 (wrong network): the Execution column the card shows
 * for each hook state, and the wallet actions behind the CTA. v1's words everywhere; the explorer link follows the ORDER's chain.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SwapButton from '@/components/SwapButton'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'
import { buildTimeline, explorerName } from './lifecycle-view'

const h = vi.hoisted(() => ({
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true, chain: { id: 1 } as { id: number } | undefined },
  chainId: 1,
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  swap: {} as Record<string, unknown>,
  split: {} as Record<string, unknown>,
  route: {} as Record<string, unknown>,
  switchChain: vi.fn(),
  openConnectModal: vi.fn(),
  sounds: [] as string[],
}))
vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: { value: 3n * 10n ** 18n, decimals: 18 } }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: h.switchChain }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId, useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => ({ ...NO_ORACLE, chainlinkPrice: 2490 }) }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => ({ plan: null, status: 'ready', error: null, isReady: true, approve: async () => {}, needsPermit2Education: false }) }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }) }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => h.route }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => h.split }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('../../shell/toasts', () => ({ useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/sounds', () => ({
  playQuoteReceived: () => {},
  playTouchMP3: () => void h.sounds.push('touch'),
  playSwapConfirmMP3: () => {},
  playCancelOrderMP3: () => {},
  startWaitingSound: () => {},
  stopWaitingSound: () => {},
}))

import { SwapCard } from '../SwapCard'

const noop = () => {}
const TX = '0x8c1f000000000000000000000000000000000000000000000000000000c44b0'
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const splitHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn(), ...over,
})

let view: ReturnType<typeof render>
/** Open the card on an amount, then move the hooks (the way a Confirm press would) and re-render. */
function mount(swap: Record<string, unknown> = {}, split: Record<string, unknown> | null = null) {
  h.swap = swapHook()
  h.split = splitHook()
  view = render(<SwapCard />)
  fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } })
  h.swap = swapHook(swap)
  if (split) h.split = splitHook(split)
  view.rerender(<SwapCard />)
}
const steps = () => [...document.querySelectorAll('[data-step]')].map((e) => [e.lastElementChild!.textContent, e.getAttribute('data-step')])
const execCol = () => screen.getByTestId('execution')

beforeEach(() => {
  h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
  h.chainId = 1
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.route = { splitResult: null, analyzing: false, useSplit: false, toggleSplit: noop }
  h.sounds = []
  h.switchChain.mockClear()
  h.openConnectModal.mockClear()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('buildTimeline (the steps are SwapButton\'s labels, in the order the hooks walk them)', () => {
  const T = (route: 'standard' | 'cow', status: Parameters<typeof buildTimeline>[0]['status'], lastActive: Parameters<typeof buildTimeline>[0]['lastActive'] = 'idle') => buildTimeline({ route, status, lastActive }).map((s) => `${s.label}:${s.state}`)
  it('standard: each status lights its own step, the earlier ones are done', () => {
    expect(T('standard', 'swapping')).toEqual(['Preparing swap...:done', 'Simulating transaction...:done', 'Review transaction...:done', 'Executing swap...:active', 'Swap complete:todo'])
    expect(T('standard', 'simulating')).toEqual(['Preparing swap...:done', 'Simulating transaction...:active', 'Review transaction...:todo', 'Executing swap...:todo', 'Swap complete:todo'])
  })
  it('success: everything done', () => expect(T('standard', 'success').every((s) => s.endsWith(':done'))).toBe(true))
  it('failure is drawn on the step that was running (28c): a revert / rejection at "Executing swap...", a failed simulation at "Simulating transaction..."', () => {
    expect(T('standard', 'error', 'swapping')).toEqual(['Preparing swap...:done', 'Simulating transaction...:done', 'Review transaction...:done', 'Executing swap...:failed', 'Swap complete:todo'])
    expect(T('standard', 'error', 'simulating')[1]).toBe('Simulating transaction...:failed')
    expect(T('standard', 'error', 'idle')[0]).toBe('Preparing swap...:failed')
  })
  it('CoW: Sign order in wallet... → Waiting for solver... → Swap complete', () => {
    expect(T('cow', 'cow_signing')).toEqual(['Preparing swap...:done', 'Sign order in wallet...:active', 'Waiting for solver...:todo', 'Swap complete:todo'])
    expect(T('cow', 'cow_pending')[2]).toBe('Waiting for solver...:active')
    expect(T('cow', 'error', 'cow_pending')[2]).toBe('Waiting for solver...:failed')
  })
  it('explorerName: the chain\'s own explorer, named as its host names itself', () => {
    expect([explorerName('https://etherscan.io'), explorerName('https://basescan.org'), explorerName('https://arbiscan.io'), explorerName('nonsense')]).toEqual(['Etherscan', 'Basescan', 'Arbiscan', 'explorer'])
  })
})

describe('28a — pending', () => {
  it('replaces the quote panel with the Execution column: the timeline on "Executing swap...", the tx link on the ORDER chain\'s explorer', () => {
    mount({ status: 'swapping', txHash: TX, simulationPassed: true })
    expect(document.querySelector('[data-quote-panel]')).toBeNull()
    expect(steps()).toEqual([['Preparing swap...', 'done'], ['Simulating transaction...', 'done'], ['Review transaction...', 'done'], ['Executing swap...', 'active'], ['Swap complete', 'todo']])
    const a = within(execCol()).getByTestId('exec-tx-link') as HTMLAnchorElement
    expect(a.href).toBe(`https://etherscan.io/tx/${TX}`)
    expect(a.textContent).toBe('Transaction sent — track on Etherscan ↗') // v1's sentence
    expect(a.rel).toContain('noopener')
    expect(execCol().textContent).toContain('Pre-swap simulation passed — transaction verified safe')
    expect(document.querySelector('[data-cta]')!.textContent).toBe('Executing swap...') // v1's button label, disabled
    expect((document.querySelector('[data-cta]') as HTMLButtonElement).disabled).toBe(true)
  })
  it.each([[8453, 'basescan.org', 'Basescan'], [42161, 'arbiscan.io', 'Arbiscan']])('chain %i → its own explorer', (chainId, host, name) => {
    h.chainId = chainId
    h.account = { ...h.account, chain: { id: chainId } }
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1', chainId) }
    mount({ status: 'swapping', txHash: TX })
    const a = within(execCol()).getByTestId('exec-tx-link') as HTMLAnchorElement
    expect(a.href).toBe(`https://${host}/tx/${TX}`)
    expect(a.textContent).toContain(name)
  })
  it('CoW pending: v1\'s MEV-protected line and the Waiting for solver step', () => {
    const m = fixtureMeta()
    const cow = { ...m.all[0], source: 'cowswap' as const, gasUsd: 0 }
    h.quote = { ...h.quote, meta: taggedFixture({ ...m, best: cow, all: [cow, ...m.all.slice(1)] }, '1') }
    mount({ status: 'cow_pending' })
    expect(steps()[2]).toEqual(['Waiting for solver...', 'active'])
    expect(execCol().textContent).toContain('Your order is MEV-protected. Solvers are competing to fill it at the best price.')
  })
  it('a fallback and an inconclusive simulation are told in v1\'s words', () => {
    mount({ status: 'swapping', simulationSkipped: true, fallbackNotice: { from: 'velora', to: 'kyberswap' } })
    expect(execCol().textContent).toContain('Simulation unavailable — proceed with caution')
    expect(execCol().textContent).toContain('velora couldn\'t execute this route — switched to kyberswap')
  })
  it('split: v1\'s per-leg progress, with v1\'s leg words', () => {
    h.route = { splitResult: { bestSplit: { isSplit: true, legs: [] }, bestSingle: {} }, analyzing: false, useSplit: true, toggleSplit: noop }
    mount({}, { status: 'executing', totalLegs: 2, completedLegs: 1, legs: [{ source: 'velora', percent: 60, status: 'success' }, { source: 'kyberswap', percent: 40, status: 'signing' }] })
    const legs = screen.getByTestId('exec-legs')
    expect(legs.textContent).toContain('Split Execution')
    expect(legs.textContent).toContain('1/2 legs')
    expect(legs.textContent).toContain('✓ Done')
    expect(legs.textContent).toContain('Confirm in wallet')
  })
})

describe('28b — success', () => {
  it('the timeline completes; the received amount is v1\'s arrow line; View on explorer; New swap', () => {
    mount({ status: 'success', txHash: TX })
    expect(steps().every(([, s]) => s === 'done')).toBe(true)
    expect(execCol().textContent!.replace(/[\u00a0\u2009\u202f]/g, ' ')).toContain('1 ETH → 2 487.6842 USDC')
    expect(execCol().textContent).not.toContain('You saved') // not a CoW fill with realised surplus → no savings line
    expect((within(execCol()).getByTestId('exec-tx-link') as HTMLAnchorElement).textContent).toBe('View on explorer ↗')
    expect(document.querySelector('[data-cta]')!.textContent).toBe('Swap complete')
  })
  it('a CoW fill with realised surplus: v1\'s "You saved" wording, from the same source (mevSurplusActualWei × the Chainlink price)', () => {
    const m = fixtureMeta()
    const cow = { ...m.all[0], source: 'cowswap' as const, gasUsd: 0 }
    h.quote = { ...h.quote, meta: taggedFixture({ ...m, best: cow, all: [cow, ...m.all.slice(1)] }, '1') }
    mount({ status: 'success', txHash: TX, mevSurplusActualWei: 5_000_000n }) // 5 USDC at $2490 (the mocked feed prices every token) — over a cent
    expect(screen.getByTestId('exec-saved').textContent).toMatch(/^You saved ~.* vs public-mempool execution$/)
  })
  it('New swap: starts over — both hooks reset, the amount clears, the quote panel returns', () => {
    mount({ status: 'success', txHash: TX })
    fireEvent.click(screen.getByTestId('exec-new-swap'))
    expect(h.swap.reset).toHaveBeenCalled()
    expect((screen.getByLabelText('Sell amount') as HTMLInputElement).value).toBe('')
  })
})

describe('28c — failure', () => {
  it('v1\'s error text verbatim under v1\'s toast title; the step that failed; the retry is the CTA "Error — retry"', () => {
    mount({ status: 'error', errorMessage: 'Transaction reverted on-chain. Try increasing slippage.', txHash: TX })
    // the card saw idle → error in one hop, so the last running step is unknown → the first; a real run passes through swapping
    expect(screen.getByTestId('exec-error').textContent).toContain('Swap failed')
    expect(screen.getByTestId('exec-error').textContent).toContain('Transaction reverted on-chain. Try increasing slippage.')
    expect(steps().some(([, s]) => s === 'failed')).toBe(true)
    const cta = document.querySelector('[data-cta]') as HTMLButtonElement
    expect(cta.textContent).toBe('Error — retry')
    expect(cta.disabled).toBe(false)
  })
  it('a real run: swapping → error draws the failure on "Executing swap..."; a simulated revert says no gas was spent', () => {
    mount({ status: 'swapping' })
    h.swap = swapHook({ status: 'error', errorMessage: 'Transaction rejected in wallet.', simulationPassed: true })
    view.rerender(<SwapCard />)
    expect(steps()[3]).toEqual(['Executing swap...', 'failed'])
    expect(execCol().textContent).toContain('Transaction rejected in wallet.')
    h.swap = swapHook({ status: 'error', errorMessage: 'x', simulationPassed: false })
    view.rerender(<SwapCard />)
    expect(execCol().textContent).toContain('Pre-swap simulation caught a revert — no gas was spent')
  })
  it('no message → v1\'s fallback copy; split titles follow v1 (failed / partially complete)', () => {
    mount({ status: 'error' })
    expect(screen.getByTestId('exec-error').textContent).toContain('Transaction was rejected or failed.')
    cleanup()
    h.route = { splitResult: { bestSplit: { isSplit: true, legs: [] }, bestSingle: {} }, analyzing: false, useSplit: true, toggleSplit: noop }
    mount({}, { status: 'partial', totalLegs: 2, completedLegs: 1, errorMessage: '1/2 legs completed. 1 failed.' })
    expect(screen.getByTestId('exec-error').textContent).toContain('Split swap partially complete')
    expect(screen.getByTestId('exec-error').textContent).toContain('1/2 legs completed. 1 failed.')
  })
  it('Error — retry opens the review again with the hook reset (v1 re-runs execute from the error state)', () => {
    mount({ status: 'error', errorMessage: 'x' })
    fireEvent.click(document.querySelector('[data-cta]') as HTMLElement)
    expect(h.swap.reset).toHaveBeenCalled()
  })
})

describe('29 — wrong network & connect: v1\'s SwapButton actions', () => {
  it('a wallet on an unsupported chain: the amber text button "Switch to Ethereum" (v1\'s label); the click is v1\'s switchChain({ chainId: CHAIN_ID })', () => {
    h.account = { ...h.account, chain: { id: 137 } }
    const v1 = render(<SwapButton swapStatus="idle" approvalStatus="ready" approvalReady hasAmount hasSufficientBalance hasQuote quoteLoading={false} priceBlocked={false} onApprove={() => {}} onSwap={() => {}} />)
    const v1Label = v1.container.querySelector('button')!.textContent
    cleanup()
    render(<SwapCard />)
    const cta = document.querySelector('[data-cta="wrong-network"]') as HTMLButtonElement
    expect(cta.textContent).toBe(v1Label)
    expect(cta.textContent).toBe('Switch to Ethereum')
    expect(cta.getAttribute('data-variant')).toBe('text') // not the one solid CTA
    fireEvent.click(cta)
    expect(h.switchChain).toHaveBeenCalledTimes(1)
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: 1 })
    expect(h.sounds).toContain('touch') // v1's SwapButton plays the touch sound on every click
  })
  it('not connected: "Connect wallet" opens RainbowKit\'s modal, as v1', () => {
    h.account = { address: undefined, isConnected: false, chain: undefined }
    render(<SwapCard />)
    fireEvent.click(document.querySelector('[data-cta="connect"]') as HTMLElement)
    expect(h.openConnectModal).toHaveBeenCalledTimes(1)
  })
})
