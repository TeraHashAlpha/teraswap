// @vitest-environment jsdom
/**
 * [fix/chain-switch-token-fallback] The v2 Swap card: a chain switch never leaves a foreign-chain token on screen. Same
 * module-edge mocks as swap-card.test.tsx; the token sheet is replaced by a button that "picks" a fixed token.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE } from './test-fixtures'
import { findToken, type Token } from '@/lib/tokens'
import { getDefaultPair, findChainToken } from '@/lib/chains/tokens'
import { CHAINS, chainWalks, fixturePairs, fixtureTokens, importFixtureToken, inCatalog, knownOnChain, removeFixtureToken } from '@/test-utils/chain-switch-fixture'
import { NATIVE_ETH } from '@/lib/constants'

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

describe('v2 SwapCard — chain-switch GUARD: every walk × every pair of the 6-token fixture [fix/chain-switch-token-fallback]', () => {
  beforeAll(importFixtureToken)
  afterAll(removeFixtureToken)

  it('after every switch, every rendered token is known on that chain and ⚠ appears only for imports', () => {
    const tokens = fixtureTokens()
    expect(tokens).toHaveLength(6)
    const violations: string[] = []
    let steps = 0
    let scenarios = 0
    for (const start of CHAINS) {
      for (const [a, b] of fixturePairs(tokens)) {
        for (const walk of chainWalks(start)) {
          scenarios++
          h.chainId = start
          const { rerender, unmount } = render(<SwapCard />)
          pickFor('Sell', a)
          pickFor('Receive', b)
          for (const at of walk) {
            h.chainId = at
            rerender(<SwapCard />)
            steps++
            const label = `${a.symbol}/${b.symbol} start ${start} walk ${[start, ...walk].join('→')} @${at}`
            const q = lastQuotePair()
            for (const addr of [q.tin, q.tout]) if (!addr || !knownOnChain(addr, at)) violations.push(`${label}: quote token ${addr} unknown on ${at}`)
            // Every address the card prints (title="0x…" on the identity row) is known here; ⚠ appears exactly for the non-catalog ones.
            const printed = Array.from(card().querySelectorAll('[title^="0x"]')).map((el) => (el.getAttribute('title') as string).toLowerCase())
            for (const addr of printed) if (!knownOnChain(addr, at)) violations.push(`${label}: printed ${addr} unknown on ${at}`)
            const expectWarn = printed.filter((addr) => addr !== NATIVE_ETH.toLowerCase() && !inCatalog(addr, at)).length
            const warn = (card().textContent!.match(/⚠/g) ?? []).length
            if (warn !== expectWarn) violations.push(`${label}: ⚠ count ${warn}, expected ${expectWarn}`)
          }
          unmount()
        }
      }
    }
    console.log(`GUARD v2: ${scenarios} scenarios, ${steps} chain switches checked, ${violations.length} violations`)
    expect(violations).toEqual([])
    expect(steps).toBeGreaterThan(500)
  }, 120_000)

  it('a token imported on Base stays on Base with the one ⚠, and is replaced by the default pair the moment the chain changes', () => {
    const imp = fixtureTokens()[5]
    h.chainId = BASE
    const { rerender } = render(<SwapCard />)
    pickFor('Sell', imp)
    expect(lastQuotePair().tin).toBe(imp.address.toLowerCase())
    expect((card().textContent!.match(/⚠/g) ?? []).length).toBe(1)
    h.chainId = ARB
    rerender(<SwapCard />)
    expect(lastQuotePair().tin).not.toBe(imp.address.toLowerCase())
    expect(card().textContent).not.toContain('⚠')
  })
})
