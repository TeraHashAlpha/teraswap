// @vitest-environment jsdom
/**
 * [L-3, A75b] The "Swap confirmed!" toast's explorer link follows the chain the tx was SENT on (useSwap's `txChainId`, as v1
 * SwapBox.tsx passes it), not the chain the wallet is on when the toast fires. Real V2ToastProvider, so the assertion is the link's
 * hostname: the user sends on Base / Arbitrum, switches network while it confirms, and the link must still open the right explorer.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'

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
import { V2ToastProvider } from '../../shell/toasts'

const noop = () => {}
const TX = '0x8c1f000000000000000000000000000000000000000000000000000000c44b0'
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, txChainId: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const splitHook = () => ({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn() })

beforeEach(() => {
  h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
  h.chainId = 1
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.route = { splitResult: null, analyzing: false, useSplit: false, toggleSplit: noop }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const switchTo = (chainId: number) => {
  h.chainId = chainId
  h.account = { ...h.account, chain: { id: chainId } }
}

describe('"Swap confirmed!" toast: explorer link = the chain the tx was sent on', () => {
  it.each([
    ['Base', 8453, 'basescan.org'],
    ['Arbitrum One', 42161, 'arbiscan.io'],
  ])('sent on %s (chain %i), wallet switched to Ethereum before it confirmed', (_n, sentOn, host) => {
    switchTo(sentOn)
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1', sentOn) }
    h.swap = swapHook()
    h.split = splitHook()
    const ui = () => (
      <V2ToastProvider>
        <SwapCard />
      </V2ToastProvider>
    )
    const view = render(ui())
    fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } })
    h.swap = swapHook({ status: 'swapping', txHash: TX, txChainId: sentOn })
    view.rerender(ui())
    switchTo(1)
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '1', 1) } // the card re-quotes on the newly selected chain while the tx confirms
    h.swap = swapHook({ status: 'success', txHash: TX, txChainId: sentOn })
    view.rerender(ui())
    const toast = screen.getByText('Swap confirmed!').closest('div')!.parentElement!
    const link = [...toast.querySelectorAll('a')].find((a) => a.textContent?.includes('View on explorer'))!
    expect(new URL(link.getAttribute('href')!).hostname).toBe(host)
  })
})
