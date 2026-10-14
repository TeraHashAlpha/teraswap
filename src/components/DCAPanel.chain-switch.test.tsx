// @vitest-environment jsdom
/**
 * [fix/dca-chain-switch] A token selection never outlives the chain it was made on.
 *
 * Production symptom: pick ARB on Arbitrum, switch to Base → the panel kept Arbitrum's WETH (tokenIn)
 * and ARB (buySelection) and sent BOTH in a Base request; the server correctly said neither is
 * registered there and the consent dialog read "WETH and ARB don't have one yet".
 *
 * Every address asserted below comes from the chain token maps (@/lib/chains/tokens) — none hand-typed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubFloorEndpoint } from './dca/__tests__/stub-floor-endpoint'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)
const createOrderMock = vi.fn()

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: vi.fn().mockResolvedValue(undefined) }),
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
vi.mock('@/hooks/useChainlinkPrice', () => ({
  useChainlinkPrice: () => ({ chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }),
}))
vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
}))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenBalance', () => ({
  useTokenBalance: () => ({ raw: 1_000000000000000000000n, hasValue: true, formatted: '1000', isLoading: false, isError: false }),
}))
vi.mock('@/lib/order-engine/check-route', () => ({
  checkRoute: async () => ({ routable: true }),
  NO_ROUTE_REASON: 'No swap route found for this pair on this network.',
}))
vi.mock('@/lib/order-engine/check-oracle', () => ({
  checkOracleCoverage: async () => ({ hasOracle: true }),
}))
vi.mock('@/lib/defillama', () => ({ fetchDefiLlamaPrice: vi.fn(async () => null) }))
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 || chainId === 42161 ? '0x0000000000000000000000000000000000000abc' : null),
  }
})
// No feed registered anywhere — every pair is `unpriced`, which makes the consent dialog (and its
// symbols) reachable on both chains.
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: () => ({
    readContract: async () => ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false],
  }),
  _clearClientCache: vi.fn(),
}))
vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => ({
    dcaOrders: [], activeOrders: [], historyOrders: [], latestEvent: null, isSubmitting: false,
    createOrder: createOrderMock,
    pendingOrder: null, confirmOrder: vi.fn(), clearPendingOrder: vi.fn(),
    pendingCancel: null, confirmCancel: vi.fn(), clearPendingCancel: vi.fn(),
    cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), removeOrder: vi.fn(),
  }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button>Connect</button> }))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
// Output picker: selects the first non-core token of the CURRENT chain's real token map.
vi.mock('@/components/TokenSelector', async () => {
  const tokens = await import('@/lib/chains/tokens')
  return {
    default: ({ selected, onSelect, hideNativeInput, chainId }: {
      selected: { symbol?: string } | null; onSelect: (t: unknown) => void; hideNativeInput?: boolean; chainId?: number
    }) => (
      <div data-testid={hideNativeInput ? 'token-selector-in' : 'token-selector-out'}>
        <span data-testid={hideNativeInput ? 'in-symbol' : 'out-symbol'}>{selected?.symbol ?? 'Select'}</span>
        {!hideNativeInput && (
          <button
            data-testid="pick-alt"
            onClick={() => onSelect(tokens.getChainTokenList(useChainIdMock()).find(t => t.symbol === 'ARB' || t.symbol === 'AERO'))}
          >pick-alt</button>
        )}
        <i hidden>{chainId}</i>
      </div>
    ),
  }
})
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('./OrderReviewModal', () => ({ default: () => null }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { getChainTokenList, findChainToken, getCanonicalUsdc } from '@/lib/chains/tokens'
import { getWrappedNative } from '@/lib/chains/registry'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const BASE = 8453
const ARB = 42161

const wethOf = (c: number) => findChainToken(getWrappedNative(c), c)!
const altOf = (c: number) => getChainTokenList(c).find(t => t.symbol === (c === ARB ? 'ARB' : 'AERO'))!
const lc = (s: string) => s.toLowerCase()

/** Every (tokenIn, tokenOut) the panel sent to /api/dca-floor-cap, with the chain it claimed. */
const floorRequests = (calls: string[]) =>
  calls.map(q => {
    const p = new URLSearchParams(q)
    return { chainId: Number(p.get('chainId')), tokenIn: lc(p.get('tokenIn')!), tokenOut: lc(p.get('tokenOut')!) }
  })

const chainAddresses = (c: number) => new Set(getChainTokenList(c).map(t => lc(t.address)))

beforeEach(() => {
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(BASE)
})

describe('DCAPanel [fix/dca-chain-switch] — selections never outlive the chain', () => {
  it('fixtures are real: both chains have the alt token and distinct WETH', () => {
    expect(altOf(BASE)).toBeTruthy()
    expect(altOf(ARB)).toBeTruthy()
    expect(lc(wethOf(BASE).address)).not.toBe(lc(wethOf(ARB).address))
  })

  it.each([
    ['panel rerendered in place (inner reset)', false],
    ['panel keyed by chainId (page.tsx)', true],
  ])('8453→42161→8453: every address sent to /api/dca-floor-cap belongs to the current chain — %s', async (_n, keyed) => {
    const { calls } = stubFloorEndpoint()
    const ui = () => <DCAPanel key={keyed ? useChainIdMock() : 'static'} />
    const { rerender } = renderWithProviders(ui())

    // Base: pick the Base alt token.
    fireEvent.click(screen.getByTestId('pick-alt'))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))

    // → Arbitrum: pick ARB.
    useChainIdMock.mockReturnValue(ARB)
    rerender(ui())
    // buy side reset, never Base's token: empty in place; a keyed remount gets the new chain's default
    expect(screen.getByTestId('out-symbol').textContent).toBe(keyed ? getCanonicalUsdc(ARB)!.symbol : 'Select')
    expect(lc(screen.getByTestId('in-symbol').textContent!)).toBe(lc(wethOf(ARB).symbol))
    fireEvent.click(screen.getByTestId('pick-alt'))
    await waitFor(() => expect(floorRequests(calls).some(r => r.chainId === ARB && r.tokenOut === lc(altOf(ARB).address))).toBe(true))

    // → back to Base: the Arbitrum pair must not be asked about under chainId 8453.
    const before = calls.length
    useChainIdMock.mockReturnValue(BASE)
    rerender(ui())
    expect(screen.getByTestId('out-symbol').textContent).toBe(keyed ? getCanonicalUsdc(BASE)!.symbol : 'Select')
    await new Promise(r => setTimeout(r, 50))

    const reqs = floorRequests(calls)
    expect(reqs.length).toBeGreaterThan(0)
    for (const r of reqs) {
      const known = chainAddresses(r.chainId)
      expect(known.has(r.tokenIn), `tokenIn ${r.tokenIn} not on chain ${r.chainId}`).toBe(true)
      expect(known.has(r.tokenOut), `tokenOut ${r.tokenOut} not on chain ${r.chainId}`).toBe(true)
    }
    // And specifically: the post-switch Base requests use Base's WETH, never Arbitrum's.
    for (const r of floorRequests(calls.slice(before))) {
      expect(r.chainId).toBe(BASE)
      expect(r.tokenIn).toBe(lc(wethOf(BASE).address))
    }
  })

  it('no stale symbol in the consent dialog after switching chain and re-picking', async () => {
    stubFloorEndpoint()
    const { rerender } = renderWithProviders(<DCAPanel />)
    useChainIdMock.mockReturnValue(ARB)
    rerender(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-alt')) // ARB on Arbitrum
    useChainIdMock.mockReturnValue(BASE)
    rerender(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-alt')) // AERO on Base
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /Start DCA/i })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /Start DCA/i }))

    const body = (await screen.findByTestId('floor-consent-body')).textContent ?? ''
    expect(body).toContain('AERO')
    expect(body).not.toContain('ARB')
  })

  it('the signed order carries only current-chain addresses after a switch', async () => {
    stubFloorEndpoint()
    const { rerender } = renderWithProviders(<DCAPanel />)
    useChainIdMock.mockReturnValue(ARB)
    rerender(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-alt'))
    useChainIdMock.mockReturnValue(BASE)
    rerender(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-alt'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /Start DCA/i })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /Start DCA/i }))
    fireEvent.click(await screen.findByTestId('floor-consent-checkbox'))
    fireEvent.click(screen.getByTestId('floor-consent-confirm'))
    await waitFor(() => expect(createOrderMock).toHaveBeenCalledTimes(1))
    const cfg = createOrderMock.mock.calls[0][0] as { tokenIn: { address: string }; tokenOut: { address: string }; chainId?: number }
    const known = chainAddresses(BASE)
    expect(known.has(lc(cfg.tokenIn.address))).toBe(true)
    expect(known.has(lc(cfg.tokenOut.address))).toBe(true)
    expect(lc(cfg.tokenIn.address)).toBe(lc(wethOf(BASE).address))
  })
})
