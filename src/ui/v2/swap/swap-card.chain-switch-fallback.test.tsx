// @vitest-environment jsdom
/**
 * [fix/chain-switch-token-fallback] The v2 Swap card: a chain switch never leaves a foreign-chain token on screen. Same
 * module-edge mocks as swap-card.test.tsx; the token sheet is replaced by a button that "picks" a fixed token.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE } from './test-fixtures'
import { findToken, type Token } from '@/lib/tokens'
import { getDefaultPair, findChainToken } from '@/lib/chains/tokens'

const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chain: undefined as { id: number } | undefined },
  balance: undefined as { value: bigint; decimals: number } | undefined,
  chainId: 1,
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: vi.fn() },
  oracle: { chainlinkPrice: 2490 as number | null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as Record<string, unknown>,
  approval: { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 } as unknown, status: 'ready', error: null, approve: async () => {}, isReady: true } as Record<string, unknown>,
  tier: { data: null as unknown, loading: false },
  useQuoteArgs: [] as unknown[],
  switchChain: vi.fn(),
  openConnectModal: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: h.balance }),
  useSwitchChain: () => ({ switchChain: h.switchChain }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: h.openConnectModal }) }))
vi.mock('@/hooks/useQuote', () => ({
  useQuote: (...args: unknown[]) => {
    h.useQuoteArgs = args
    return h.quote
  },
}))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId, useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => h.oracle }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => h.tier }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: vi.fn(), playTouchMP3: vi.fn(), stopWaitingSound: vi.fn() }))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map() }) }))

const pick: { token: Token | null } = { token: null }
vi.mock('../modals/TokenSheet', () => ({
  TokenSheet: ({ onSelect, onClose }: { onSelect: (t: Token) => void; onClose: () => void }) => (
    <button type="button" data-testid="pick" onClick={() => { onSelect(pick.token as Token); onClose() }}>pick</button>
  ),
}))

vi.mock('./lifecycle/use-swap-lifecycle', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useSwapLifecycle: () => m.idleLifecycle() }
})
vi.mock('@/hooks/useDepegCheck', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useDepegCheck: () => m.OK_DEPEG }
})
vi.mock('../shell/toasts', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useV2Toast: () => m.TOAST_STUB }
})

import { SwapCard } from './SwapCard'
beforeEach(() => {
  h.account = { address: undefined, isConnected: false, chain: undefined }
  h.balance = undefined
  h.chainId = 1
  h.quote = { meta: null, loading: false, error: null, countdown: 12, refresh: vi.fn() }
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.tier = { data: null, loading: false }
  h.approval = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, approve: async () => {}, isReady: true }
  pick.token = null
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ARB = 42161
const BASE = 8453
const SNX = findToken('SNX') as Token
const DAI = findToken('DAI') as Token

const pickFor = (side: 'Sell' | 'Receive', token: Token) => {
  pick.token = token
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${side} token:`) }))
  fireEvent.click(screen.getByTestId('pick'))
}
const sellLabel = () => screen.getByRole('button', { name: /Sell token:/ }).getAttribute('aria-label')!
const lastQuotePair = () => {
  const [tin, tout] = h.useQuoteArgs as [Token | null, Token | null]
  return { tin: tin?.address.toLowerCase() ?? null, tout: tout?.address.toLowerCase() ?? null }
}
const card = () => document.querySelector('[data-swap-card]') as HTMLElement

describe('v2 SwapCard — chain switch with a token that has no home on the target chain [fix/chain-switch-token-fallback]', () => {
  it('switch 1 → 42161 with SNX/USDC selected → Arbitrum default pair, no ⚠ badge, a quote is requested for the default pair', () => {
    const { rerender } = render(<SwapCard />)
    pickFor('Sell', SNX)
    expect(sellLabel()).toMatch(/SNX/)
    expect(card().textContent).not.toContain('⚠') // sanity: on mainnet SNX is a catalog token (✓)
    h.chainId = ARB
    rerender(<SwapCard />)
    const dflt = getDefaultPair(ARB)
    expect(sellLabel()).toMatch(/ETH/)
    expect(lastQuotePair()).toEqual({ tin: dflt.tokenIn!.address.toLowerCase(), tout: dflt.tokenOut!.address.toLowerCase() })
    expect(lastQuotePair().tout).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
    expect(h.useQuoteArgs[3]).toBe(true)
    expect(card().textContent).not.toContain('⚠')
    expect(card().innerHTML.toLowerCase()).not.toContain('c011a73e')
  })

  it('a stale {SNX mainnet, DAI mainnet} pair arriving on Base ends as the Base default pair', () => {
    const { rerender } = render(<SwapCard />)
    pickFor('Sell', SNX)
    pickFor('Receive', DAI)
    h.chainId = BASE
    rerender(<SwapCard />)
    const dflt = getDefaultPair(BASE)
    expect(lastQuotePair()).toEqual({ tin: dflt.tokenIn!.address.toLowerCase(), tout: dflt.tokenOut!.address.toLowerCase() })
    for (const a of Object.values(lastQuotePair())) expect(findChainToken(a!, BASE)).not.toBeNull()
    expect(card().textContent).not.toContain('⚠')
  })

  it('mainnet is untouched: SNX stays selected while the chain does not change', () => {
    const { rerender } = render(<SwapCard />)
    pickFor('Sell', SNX)
    rerender(<SwapCard />)
    expect(lastQuotePair().tin).toBe(SNX.address.toLowerCase())
  })
})
